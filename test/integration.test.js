'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const UID = 'api::note.note';
const USER = 'plugin::users-permissions.user';
const ROLE = 'plugin::users-permissions.role';
const PERMISSION = 'plugin::users-permissions.permission';
const pluginDir = path.resolve(__dirname, '..');

async function makeApp(appDir) {
  const depsRoot = process.env.STRAPI_TEST_DEPS || pluginDir;
  const requireDependencies = createRequire(path.join(depsRoot, 'package.json'));
  const { createStrapi } = requireDependencies('@strapi/strapi');
  await symlink(path.join(depsRoot, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
  await mkdir(path.join(appDir, "public/uploads"), { recursive: true });

  const files = {
    'package.json': JSON.stringify({
      name: 'owner-permissions-fixture',
      version: '1.0.0',
      dependencies: Object.fromEntries(
        ['@strapi/strapi', '@strapi/plugin-users-permissions'].map((name) => [
          name, requireDependencies(name + '/package.json').version,
        ]),
      ),
    }),
    'config/admin.js': 'module.exports = ({env}) => ({ auth: { secret: env("ADMIN_JWT_SECRET") }, apiToken: { salt: env("API_TOKEN_SALT") }, transfer: { token: { salt: env("TRANSFER_TOKEN_SALT") } }, secrets: { encryptionKey: env("ENCRYPTION_KEY") } });',
    'config/server.js': 'module.exports = ({env}) => ({ host: "127.0.0.1", port: 0, logger: { updates: { enabled: false } }, app: { keys: env.array("APP_KEYS") } });',
    'config/database.js': `module.exports = { connection: { client: "sqlite", connection: { filename: ${JSON.stringify(path.join(appDir, 'test.sqlite'))} }, useNullAsDefault: true } };`,
    'config/plugins.js': `module.exports = ({env}) => ({
      'users-permissions': { enabled: true, config: { jwtSecret: env("JWT_SECRET") } },
      'owner-permissions': { enabled: true, resolve: ${JSON.stringify(pluginDir)} },
    });`,
    'src/api/note/content-types/note/schema.json': JSON.stringify({
      kind: 'collectionType',
      collectionName: 'notes',
      info: { singularName: 'note', pluralName: 'notes', displayName: 'Note' },
      options: { draftAndPublish: false },
      attributes: {
        title: { type: 'string', required: true },
        owner: { type: 'relation', relation: 'manyToOne', target: USER, private: true },
        reviewer: { type: 'relation', relation: 'manyToOne', target: USER, private: true },
      },
    }),
    'src/api/note/routes/note.js': `module.exports = require('@strapi/strapi').factories.createCoreRouter('${UID}');`,
    'src/api/note/controllers/note.js': `module.exports = require('@strapi/strapi').factories.createCoreController('${UID}');`,
    'src/api/note/services/note.js': `module.exports = require('@strapi/strapi').factories.createCoreService('${UID}');`,
  };

  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(appDir, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }

  for (const name of ['ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'JWT_SECRET']) {
    process.env[name] = randomBytes(32).toString('hex');
  }
  process.env.APP_KEYS = randomBytes(32).toString('hex');
  process.env.STRAPI_TELEMETRY_DISABLED = 'true';
  process.env.NODE_ENV = 'test';
  return createStrapi({ appDir, distDir: appDir, autoReload: false, serveAdminPanel: false });
}

test('configure ownership through the role admin API and isolate two JWT users', async (t) => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'owner-permissions-'));
  const strapi = await makeApp(appDir);
  t.after(async () => {
    const listeners = new Map(process.eventNames().map((name) => [name, process.rawListeners(name)]));
    await strapi.destroy();
    for (const [name, handlers] of listeners) {
      for (const handler of handlers) process.on(name, handler);
    }
    await rm(appDir, { recursive: true, force: true });
  });
  await strapi.load();

  const userQuery = strapi.db.query(USER);
  const permission = strapi.db.query(PERMISSION);
  const roleQuery = strapi.db.query(ROLE);
  const authenticated = await roleQuery.findOne({ where: { type: 'authenticated' } });
  const publicRole = await roleQuery.findOne({ where: { type: 'public' } });
  for (const action of ['find', 'findOne', 'create', 'update', 'delete']) {
    await permission.create({ data: { action: `${UID}.${action}`, role: authenticated.id } });
  }
  await permission.create({ data: { action: `${UID}.find`, role: publicRole.id } });

  const password = randomBytes(20).toString('hex');
  const userService = strapi.plugin('users-permissions').service('user');
  for (const login of ['alice', 'bob']) {
    await userService.add({
      username: login,
      email: `${login}@example.invalid`,
      password,
      provider: 'local',
      confirmed: true,
      blocked: false,
      role: authenticated.id,
    }).catch((error) => {
      throw new Error(`Could not create fixture user ${login}: ${JSON.stringify(error.details)}`, { cause: error });
    });
  }
  const bob = await userQuery.findOne({ where: { username: 'bob' } });
  await new Promise((resolve, reject) => {
    strapi.server.httpServer.once('error', reject);
    strapi.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${strapi.server.httpServer.address().port}`;
  async function request(method, url, token, input) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (input !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, {
      method, headers, body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function login(identifier) {
    const res = await request('POST', '/api/auth/local', null, { identifier, password });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.equal(res.body.jwt.split('.').length, 3);
    return res.body.jwt;
  }
  const a = await login('alice');
  const b = await login('bob');

  const roleSettings = '/owner-permissions/roles/' + authenticated.id;
  assert.ok([401, 403].includes((await request('GET', roleSettings)).status));
  assert.ok([401, 403].includes((await request('PUT', roleSettings, a, {
    mappings: { [UID]: 'owner' },
  })).status));
  const registration = await request('POST', '/admin/register-admin', null, {
    firstname: 'Fixture',
    lastname: 'Admin',
    email: 'admin@example.invalid',
    password: 'FixtureAdmin42!',
  });
  assert.equal(registration.status, 200, JSON.stringify(registration));
  const admin = registration.body.data.token;
  assert.ok(admin);
  const settings = await request('GET', roleSettings, admin);
  assert.equal(settings.status, 200, JSON.stringify(settings));
  assert.equal(settings.body.data.canConfigure, true);
  assert.deepEqual(settings.body.data.mappings, {});
  assert.deepEqual(settings.body.data.eligible.find((item) => item.uid === UID).ownerFields, ['owner', 'reviewer']);
  const allActions = ['find', 'findOne', 'create', 'update', 'delete'];
  const rule = { ownerField: 'owner', actions: allActions };
  const invalid = await request('PUT', roleSettings, admin, {
    mappings: { [UID]: { ...rule, ownerField: 'title' } },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid));
  const invalidAction = await request('PUT', roleSettings, admin, {
    mappings: { [UID]: { ...rule, actions: ['publish'] } },
  });
  assert.equal(invalidAction.status, 400, JSON.stringify(invalidAction));
  const saved = await request('PUT', roleSettings, admin, { mappings: { [UID]: rule } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.body.data.mappings, { [UID]: rule });
  assert.deepEqual((await request('GET', roleSettings, admin)).body.data.mappings, { [UID]: rule });

  const createdAlice = await request('POST', '/api/notes', a, { data: { title: 'Alice' } });
  const createdAliceAgain = await request('POST', '/api/notes', a, { data: { title: 'Alice 2' } });
  const createdBob = await request('POST', '/api/notes', b, { data: { title: 'Bob' } });
  for (const res of [createdAlice, createdAliceAgain, createdBob]) {
    assert.equal(res.status, 201, JSON.stringify(res));
    assert.equal(Object.hasOwn(res.body.data, 'owner'), false);
    assert.match(res.body.data.documentId, /.+/);
  }
  const aid = createdAlice.body.data.documentId;
  const bid = createdBob.body.data.documentId;

  const page = await request('GET', '/api/notes?pagination[pageSize]=1', a);
  assert.equal(page.status, 200, JSON.stringify(page));
  assert.equal(page.body.data.length, 1);
  assert.equal(page.body.meta.pagination.total, 2);
  assert.equal(page.body.meta.pagination.pageCount, 2);
  const bPage = await request('GET', '/api/notes', b);
  assert.deepEqual(bPage.body.data.map(({ title }) => title), ['Bob']);
  const filtered = await request('GET', '/api/notes?filters[title][$eq]=Bob', a);
  assert.deepEqual(filtered.body.data, []);
  assert.equal(filtered.body.meta.pagination.total, 0);
  assert.equal((await request('GET', `/api/notes/${aid}`, a)).status, 200);

  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await request(method, `/api/notes/${bid}`, a, method === 'PUT' ? { data: { title: 'Unauthorized' } } : undefined);
    assert.equal(res.status, 404, JSON.stringify(res));
  }

  const spoof = await request('POST', '/api/notes', a, {
    data: { title: 'Wrong owner', owner: bob.documentId },
  });
  assert.equal(spoof.status, 400, JSON.stringify(spoof));
  const reassign = await request('PUT', `/api/notes/${aid}`, a, {
    data: { title: 'Wrong owner', owner: bob.documentId },
  });
  assert.equal(reassign.status, 400, JSON.stringify(reassign));
  const setReviewer = await request('PUT', `/api/notes/${aid}`, a, {
    data: { title: 'Protected relation', reviewer: bob.documentId },
  });
  assert.equal(setReviewer.status, 400, JSON.stringify(setReviewer));
  assert.equal((await request('GET', '/api/notes?populate=*', a)).status, 400);
  assert.equal((await request('GET', '/api/notes')).status, 403);

  const apiTokenService = strapi.service('admin::api-token-content-api') ?? strapi.service('admin::api-token');
  const { accessKey } = await apiTokenService.create({
    name: 'Fixture token',
    description: '',
    type: 'full-access',
    lifespan: null,
  });
  assert.equal((await request('GET', '/api/notes', accessKey)).status, 403);

  const updated = await request('PUT', `/api/notes/${aid}`, a, { data: { title: 'Alice edited' } });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.equal(updated.body.data.title, 'Alice edited');
  const deletePermission = await permission.findOne({
    where: { action: `${UID}.delete`, role: { id: authenticated.id } },
  });
  await permission.delete({ where: { id: deletePermission.id } });
  assert.equal((await request('DELETE', `/api/notes/${aid}`, a)).status, 403);
  await permission.create({ data: { action: `${UID}.delete`, role: authenticated.id } });
  assert.equal((await request('DELETE', `/api/notes/${aid}`, a)).status, 204);
  assert.equal((await request('GET', `/api/notes/${bid}`, b)).body.data.title, 'Bob');

  const partial = { ownerField: 'owner', actions: ['find', 'update'] };
  const savedPartial = await request('PUT', roleSettings, admin, { mappings: { [UID]: partial } });
  assert.equal(savedPartial.status, 200, JSON.stringify(savedPartial));
  assert.deepEqual((await request('GET', roleSettings, admin)).body.data.mappings, { [UID]: partial });
  assert.equal((await request('GET', '/api/notes', a)).body.meta.pagination.total, 1);
  assert.equal((await request('GET', `/api/notes/${bid}`, a)).status, 200);
  assert.equal((await request('PUT', `/api/notes/${bid}`, a, { data: { title: 'Blocked' } })).status, 404);
  assert.equal((await request('GET', '/api/notes')).status, 403);
  const storedRules = strapi.db.query('plugin::owner-permissions.role-mapping');
  await storedRules.update({ where: { roleId: authenticated.id }, data: { mappings: { [UID]: 'owner' } } });
  assert.deepEqual((await request('GET', roleSettings, admin)).body.data.mappings, { [UID]: rule });
  assert.equal((await request('GET', `/api/notes/${bid}`, a)).status, 404);
});
