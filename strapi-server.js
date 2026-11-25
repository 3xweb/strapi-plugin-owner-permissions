'use strict';

const USER = 'plugin::users-permissions.user';
const ROLE = 'plugin::users-permissions.role';
const MAPPING = 'plugin::owner-permissions.role-mapping';
const ROLE_READ = 'plugin::users-permissions.roles.read';
const ROLE_UPDATE = 'plugin::users-permissions.roles.update';
const REQUEST_RULES = Symbol('owner-permissions.rules');
const ACTIONS = new Map([
  ['findMany', 'find'],
  ['count', 'find'],
  ['findOne', 'findOne'],
  ['create', 'create'],
  ['update', 'update'],
  ['delete', 'delete'],
]);
const CORE_ACTIONS = [...new Set(ACTIONS.values())];
function isOwnerField(attribute) {
  return attribute?.type === 'relation' && attribute.relation === 'manyToOne' &&
    attribute.target === USER && !attribute.inversedBy && !attribute.mappedBy &&
    attribute.private === true;
}

function discoverEligible(strapi) {
  if (strapi.plugins.graphql) return [];

  // Populated data can be loaded without invoking the target model's middleware.
  const blockedTargets = new Set();
  const schemas = { ...strapi.contentTypes, ...strapi.components };
  for (const [uid, schema] of Object.entries(schemas)) {
    for (const [field, attribute] of Object.entries(schema.attributes)) {
      if (field === 'localizations' && uid === attribute.target) continue;
      if (attribute.type === 'relation' && attribute.target) blockedTargets.add(attribute.target);
    }
  }

  const models = [];
  for (const [uid, schema] of Object.entries(strapi.contentTypes)) {
    if (!uid.startsWith('api::') || schema.kind !== 'collectionType' ||
        schema.options?.draftAndPublish || schema.pluginOptions?.i18n?.localized ||
        blockedTargets.has(uid)) continue;

    const fields = Object.entries(schema.attributes).filter(
      ([field]) => !['createdBy', 'updatedBy', 'localizations'].includes(field),
    );
    const relations = fields.filter(
      ([, attribute]) => ['relation', 'media', 'component', 'dynamiczone'].includes(attribute.type),
    );
    if (!relations.length || relations.some(([, attribute]) => !isOwnerField(attribute))) continue;

    models.push({ uid, label: schema.info.displayName, ownerFields: relations.map(([field]) => field) });
  }
  return models;
}

function normalizeMapping(mapping) {
  return typeof mapping === 'string'
    ? { ownerField: mapping, actions: CORE_ACTIONS }
    : mapping;
}

function serializeMappings(mappings) {
  return Object.fromEntries(
    Object.entries(mappings).map(([uid, mapping]) => [uid, normalizeMapping(mapping)]),
  );
}

function firstInvalidMapping(mappings, eligible) {
  return Object.entries(mappings).find(
    ([uid, mapping]) => {
      const rule = normalizeMapping(mapping);
      return !rule || !Array.isArray(rule.actions) || rule.actions.length === 0 ||
        new Set(rule.actions).size !== rule.actions.length ||
        rule.actions.some((action) => !CORE_ACTIONS.includes(action)) ||
        !eligible.some((model) => model.uid === uid && model.ownerFields.includes(rule.ownerField));
    },
  );
}

function roleRoutes() {
  return [
    { method: 'GET', handler: 'roles.find', action: ROLE_READ },
    { method: 'PUT', handler: 'roles.update', action: ROLE_UPDATE },
  ].map(({ method, handler, action }) => ({
    method,
    path: '/roles/:id',
    handler,
    config: {
      policies: [{ name: 'admin::hasPermissions', config: { actions: [action] } }],
    },
  }));
}

function roleController({ strapi }) {
  const query = (uid) => strapi.db.query(uid);
  const getRole = async (ctx) => {
    const id = Number(ctx.params.id);
    if (!/^\d+$/.test(ctx.params.id) || !Number.isSafeInteger(id) || id < 1) {
      ctx.throw(400, 'Invalid role ID');
    }
    const role = await query(ROLE).findOne({ where: { id }, select: ['id', 'type'] });
    if (!role) ctx.throw(404, 'Role not found');
    return role;
  };
  const getSettings = async (role) => query(MAPPING).findOne({ where: { roleId: role.id } });
  const canConfigure = (ctx, role) =>
    role.type !== 'public' && Boolean(ctx.state.userAbility?.can(ROLE_UPDATE));

  return {
    async find(ctx) {
      const role = await getRole(ctx);
      const settings = await getSettings(role);
      ctx.body = {
        data: {
          eligible: discoverEligible(strapi),
          mappings: serializeMappings(settings?.mappings ?? {}),
          canConfigure: canConfigure(ctx, role),
        },
      };
    },
    async update(ctx) {
      const role = await getRole(ctx);
      if (!canConfigure(ctx, role)) ctx.throw(403, 'This role cannot use ownership rules');
      const input = ctx.request.body?.mappings;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        ctx.throw(400, 'mappings must be an object keyed by content type UID');
      }

      const eligible = discoverEligible(strapi);
      const mappings = serializeMappings(input);
      const invalid = firstInvalidMapping(mappings, eligible);
      if (invalid) ctx.throw(400, `Unsupported ownership mapping: ${invalid[0]}`);

      const settings = await getSettings(role);
      if (settings) {
        await query(MAPPING).update({ where: { id: settings.id }, data: { mappings } });
      } else {
        await query(MAPPING).create({ data: { roleId: role.id, mappings } });
      }
      ctx.body = { data: { eligible, mappings, canConfigure: true } };
    },
  };
}

function ownerFilter(field, userId) {
  return { [field]: { id: { $eq: userId } } };
}

function addOwnerFilter(params, filter) {
  params.filters = params.filters ? { $and: [params.filters, filter] } : filter;
}

function installOwnership(strapi) {
  strapi.documents.use(async (context, next) => {
    const { uid, action, params } = context;
    const ctx = strapi.requestContext.get();
    if (!uid.startsWith('api::') || ctx?.state.route?.info?.type !== 'content-api') {
      return next();
    }
    ctx.state[REQUEST_RULES] ??= strapi.db.query(MAPPING).findMany({
      select: ['roleId', 'mappings'],
    });
    const rules = (await ctx.state[REQUEST_RULES]).filter(({ mappings }) => Object.hasOwn(mappings, uid));
    if (!rules.length) return next();

    const auth = ctx.state.auth;
    const user = auth?.strategy?.name === 'users-permissions' ? auth.credentials : null;
    const rule = rules.find(({ roleId }) => roleId === user?.role?.id);
    if (!user?.id || !user.documentId || !rule) {
      ctx.throw(403, 'An authorized user account is required for this content');
    }
    const { ownerField, actions } = normalizeMapping(rule.mappings[uid]);

    const coreAction = ACTIONS.get(action);
    if (!coreAction) {
      ctx.throw(403, 'This document action is disabled');
    }
    if (params.populate !== undefined || ctx.query.populate !== undefined) {
      ctx.throw(400, 'Populating protected content is unsupported');
    }

    if (actions.includes(coreAction)) {
      const filter = ownerFilter(ownerField, user.id);
      if (['find', 'findOne', 'delete'].includes(coreAction)) {
        addOwnerFilter(params, filter);
      }
      if (['findOne', 'update', 'delete'].includes(coreAction)) {
        if (typeof params.documentId !== 'string' || !params.documentId.trim()) {
          ctx.throw(400, 'A documentId is required');
        }
        // update() does not propagate filters to its primary lookup in Strapi 5.
        // The owner relation is immutable for client writes.
        const record = await strapi.db.query(uid).findOne({
          select: ['id'],
          where: { documentId: params.documentId, ...filter },
        });
        if (!record) ctx.throw(404, 'Document not found');
      }
    }

    if (coreAction === 'create' || coreAction === 'update') {
      const input = ctx.request.body?.data;
      const ownerFields = Object.entries(strapi.contentTypes[uid].attributes)
        .filter(([, attribute]) => isOwnerField(attribute))
        .map(([field]) => field);
      if (ownerFields.some((field) =>
        (input && Object.hasOwn(input, field)) || (params.data && Object.hasOwn(params.data, field))
      )) {
        ctx.throw(400, 'The owner relation is assigned by the server');
      }
      if (coreAction === 'create') {
        params.data = { ...params.data, [ownerField]: user.documentId };
      }
    }
    return next();
  });
}

module.exports = {
  config: {
    default: {},
    validator(config) {
      if (Object.hasOwn(config, 'mappings')) {
        throw new Error('Migrate file-based mappings to Roles settings before removing the old rule. See the README.');
      }
    },
  },
  contentTypes: {
    'role-mapping': {
      schema: {
        kind: 'collectionType',
        collectionName: 'owner_permissions_role_mappings',
        info: {
          singularName: 'role-mapping',
          pluralName: 'role-mappings',
          displayName: 'Ownership rules by role',
        },
        options: { draftAndPublish: false },
        pluginOptions: {
          'content-manager': { visible: false },
          'content-type-builder': { visible: false },
        },
        attributes: {
          roleId: { type: 'integer', required: true, unique: true, private: true },
          mappings: { type: 'json', required: true, private: true },
        },
      },
    },
  },
  controllers: { roles: roleController },
  routes: { admin: { type: 'admin', routes: roleRoutes() } },
  async bootstrap({ strapi }) {
    const eligible = discoverEligible(strapi);
    for (const { mappings } of await strapi.db.query(MAPPING).findMany()) {
      const invalid = firstInvalidMapping(mappings, eligible);
      if (invalid) throw new Error(`[owner-permissions] persisted mapping no longer supported: ${invalid[0]}`);
    }
    installOwnership(strapi);
  },
};
