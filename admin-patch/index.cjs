'use strict';

const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join, resolve } = require('node:path');
const createOwnerRules = require('./OwnerRules.cjs');

const DEPENDENCY = '@strapi/plugin-users-permissions';
const MINIMUM_MINOR = 49;
const NAME = 'owner-permissions:native-role-editor';

const esmSetup = `import * as OwnerRulesReact from 'react';
import { Button, Checkbox, SingleSelect, SingleSelectOption } from '@strapi/design-system';
import { useFetchClient, useAPIErrorHandler } from '@strapi/strapi/admin';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import { useMatch } from 'react-router-dom';
const OwnerPermissionsRules = (${createOwnerRules})(OwnerRulesReact, { Button, Checkbox, Flex, SingleSelect, SingleSelectOption, Typography }, { useFetchClient, useAPIErrorHandler }, { useMutation, useQuery, useQueryClient });`;

const POLICIES = [
  {
    path: 'dist/admin/components/Policies/index.mjs',
    hash: '79885141d11b26c4b37a443c74e82dea00d9633f34c495aa084238453bdfc64f',
    setup: esmSetup,
    anchor: '}, key))',
    insertion: ", ...(roleId ? [jsx(OwnerPermissionsRules, { id: roleId, selectedAction }, 'owner-' + roleId)] : [])]",
    runtime: '',
  },
  {
    path: 'dist/admin/components/Policies/index.js',
    hash: '7c16d71d8201834c4be753232d04d4025ca21350a03f42b4625d3c185d7af21c',
    setup: `const OwnerRulesReact = require('react');
const useMatch = require('react-router-dom').useMatch;
const OwnerPermissionsRules = (${createOwnerRules})(OwnerRulesReact, designSystem, require('@strapi/strapi/admin'), require('react-query'));`,
    anchor: '}, key))',
    insertion: ", ...(roleId ? [jsxRuntime.jsx(OwnerPermissionsRules, { id: roleId, selectedAction }, 'owner-' + roleId)] : [])]",
    runtime: 'jsxRuntime.',
  },
  {
    path: 'admin/src/components/Policies/index.jsx',
    hash: 'f62fdbe2472d4587a78b19687f30e2baa3e35776f0f11da0aa625cec9e5321de',
    setup: esmSetup,
    anchor: '          ))}',
    insertion: '\n          {roleId && <OwnerPermissionsRules id={roleId} selectedAction={selectedAction} key={roleId} />}',
  },
];

function patchPolicies(code, variant) {
  const hash = createHash('sha256').update(code).digest('hex');
  const definition = 'const Policies =';
  const map = 'children: displayedRoutes.map(';
  if (
    hash !== variant.hash || code.split(definition).length !== 2 ||
    code.split(variant.anchor).length !== 2 ||
    (variant.runtime !== undefined && code.split(map).length !== 2)
  ) {
    throw new Error(`[owner-permissions] Unexpected ${variant.path}. This Users & Permissions build has a different Roles panel. Review the integration before rebuilding.`);
  }
  const patch = code
    .replace(definition, () => `${variant.setup}\n\n${definition}`)
    .replace(/^( +)const \{ formatMessage \}/m, (_, indent) =>
      `${indent}const roleId = useMatch('/settings/users-permissions/roles/:id')?.params.id;\n${indent}const { formatMessage }`);
  if (variant.runtime === undefined) {
    return patch.replace(variant.anchor, () => variant.anchor + variant.insertion);
  }
  return patch
    .replace(
      `children: selectedAction ? /*#__PURE__*/ ${variant.runtime}jsx(`,
      `children: selectedAction ? /*#__PURE__*/ ${variant.runtime}jsxs(`,
    )
    .replace(map, 'children: [...displayedRoutes.map(')
    .replace(variant.anchor, () => variant.anchor + variant.insertion);
}

function roleEditorPlugin() {
  let policyPanels = new Map();
  let patched = false;
  return {
    name: NAME,
    enforce: 'pre',
    configResolved(config) {
      const requireFromApp = createRequire(resolve(config.root, 'package.json'));
      const manifest = requireFromApp.resolve(DEPENDENCY + '/package.json');
      const { version } = requireFromApp(manifest);
      const stableStrapi5 = /^5\.(\d+)\.\d+$/.exec(version);
      if (!stableStrapi5 || Number(stableStrapi5[1]) < MINIMUM_MINOR) {
        throw new Error(`[owner-permissions] Native Role editor requires ${DEPENDENCY} >=5.${MINIMUM_MINOR}.0 <6. Installed version: ${version}.`);
      }
      policyPanels = new Map(POLICIES.map((variant) => [
        realpathSync(join(dirname(manifest), variant.path)), variant,
      ]));
    },
    transform(code, id) {
      if (!id.split('?')[0].includes('/Policies/index.')) return null;
      let filename;
      try {
        filename = realpathSync(id.split('?')[0]);
      } catch {
        return null;
      }
      const variant = policyPanels.get(filename);
      if (!variant) return null;
      const source = patchPolicies(code, variant);
      patched = true;
      return { code: source, map: null };
    },
    generateBundle() {
      if (!patched) {
        this.error('[owner-permissions] The native Users & Permissions Roles editor was not reached by the admin build.');
      }
    },
  };
}

function withOwnerPermissionsRoleEditor(config) {
  const exclude = config.optimizeDeps?.exclude ?? [];
  return {
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      exclude: [...new Set([...exclude, DEPENDENCY, DEPENDENCY + '/strapi-admin'])],
    },
    plugins: [...(config.plugins ?? []), roleEditorPlugin()],
  };
}

module.exports = { withOwnerPermissionsRoleEditor };
