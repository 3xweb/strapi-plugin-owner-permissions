'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { withOwnerPermissionsRoleEditor } = require('./index.cjs');

const dependency = '@strapi/plugin-users-permissions';
const depsRoot = process.env.STRAPI_TEST_DEPS || path.resolve(__dirname, '..');
const requireFromFixture = createRequire(path.join(depsRoot, 'package.json'));
const upstreamRoot = path.dirname(requireFromFixture.resolve(dependency + '/package.json'));

test('patches only the versioned native editor and retains app Vite options', async () => {
  const existing = { name: 'existing' };
  const config = withOwnerPermissionsRoleEditor({
    plugins: [existing],
    optimizeDeps: { exclude: ['original'], include: ['react'] },
  });
  assert.strictEqual(config.plugins[0], existing);
  assert.deepEqual(config.optimizeDeps.include, ['react']);
  assert.deepEqual(config.optimizeDeps.exclude, ['original', dependency, dependency + '/strapi-admin']);

  const plugin = config.plugins[1];
  plugin.configResolved({ root: depsRoot });
  assert.equal(plugin.transform('unchanged', path.join(upstreamRoot, 'unrelated.js')), null);
  for (const filename of [
    'admin/src/components/Policies/index.jsx',
    'dist/admin/components/Policies/index.mjs',
    'dist/admin/components/Policies/index.js',
  ]) {
    const id = path.join(upstreamRoot, filename);
    const original = await fs.readFile(id, 'utf8');
    const { code } = plugin.transform(original, id + '?v=123');
    assert.match(code, /User-generated content/);
    assert.match(code, /Save ownership rules/);
    assert.match(code, /OwnerPermissionsRules/);
    assert.match(code, /displayedRoutes/);
    assert.throws(() => plugin.transform(original + '\n// modified upstream', id), /Unexpected/);
    assert.equal(await fs.readFile(id, 'utf8'), original);
  }
});

test('bundles the native Roles editor reachable from Users & Permissions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-permissions-admin-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.symlink(path.join(depsRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const input = path.join(root, 'admin.mjs');
  await fs.writeFile(input, `export { default } from '${dependency}/strapi-admin';\n`);
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  const vite = await import(pathToFileURL(requireFromFixture.resolve('vite')));
  const build = vite.build ?? vite.default.build;
  const result = await build(withOwnerPermissionsRoleEditor({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input,
        preserveEntrySignatures: 'strict',
        external: (id) => !id.startsWith(dependency) && !id.startsWith('.') && !path.isAbsolute(id),
      },
    },
  }));
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(({ output }) => output);
  const roles = chunks.find((chunk) => chunk.type === 'chunk' && chunk.code.includes('Save ownership rules'));
  assert.ok(roles);
  assert.match(roles.code, /User-generated content/);
  assert.ok(chunks.some((chunk) => chunk.type === 'chunk' && /ProtectedRolesEditPage/.test(chunk.code)));
  assert.match(roles.code, /settings\/users-permissions\/roles\/:id/);
  assert.match(roles.code, /owner-permissions\/roles\//);
});
