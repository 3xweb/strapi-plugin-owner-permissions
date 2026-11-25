# Owner Permissions for Strapi 5

Limit user-generated content to its owner on the Strapi REST Content API.
Enable standard actions in **Settings → Users & Permissions → Roles**. On the
same role edit page, expand an eligible collection and click the gear next to
an action. In the **Advanced settings** pane, enable **Only own records** and
save the ownership rules. The owner field identifies the stored relationship
between each record and its owner. Enable the native action permission as well
for users with that role to use the route.

## Installation

From your Strapi project, install the package from npm:

```sh
npm install @3xweb/strapi-plugin-owner-permissions
```

In a JavaScript project, enable the plugin in `config/plugins.js`:

```js
module.exports = {
  'owner-permissions': { enabled: true },
};
```

In a TypeScript project, use `config/plugins.ts`:

```ts
export default {
  'owner-permissions': { enabled: true },
};
```

Ownership settings are stored in the database and edited from the Roles page.

The native role editor in Users & Permissions 5.62.0 has no injection zone. Add
the package's version-checked Vite integration in `src/admin/vite.config.js`
and rebuild the admin panel:

```js
const { withOwnerPermissionsRoleEditor } = require('@3xweb/strapi-plugin-owner-permissions/admin-patch');

module.exports = withOwnerPermissionsRoleEditor;
```

For TypeScript, use `src/admin/vite.config.ts` instead:

```ts
import { withOwnerPermissionsRoleEditor } from '@3xweb/strapi-plugin-owner-permissions/admin-patch';

export default withOwnerPermissionsRoleEditor;
```

If you already customize the Vite config, pass your final config object to
`withOwnerPermissionsRoleEditor`. Use matching Strapi and Users & Permissions versions from **5.49.0 to <6**.
The admin integration checks the upstream Roles panel before building and
stops if its source has changed.

Rebuild the admin panel and restart Strapi:

```sh
npm run build
npm run start
```

## Configure a collection

In the collection schema's `attributes`, define an ownership field. It can use
any name, such as `owner` or `author`. It must be a private, unidirectional
many-to-one relation to a Users & Permissions user.

```json
{
  "owner": {
    "type": "relation",
    "relation": "manyToOne",
    "target": "plugin::users-permissions.user",
    "private": true
  }
}
```

## Configure a role

1. Open **Settings → Users & Permissions → Roles** and select a role.
2. Expand the collection in **Permissions**. Enable the native permissions for
   the actions the role can execute and save them with **Save**.
3. Click the gear beside an action. In the right-hand pane, turn on **Only own
   records** and select **Save ownership rules**. Repeat for each action that
   should be restricted.
4. If the collection has one eligible owner field, the panel displays it
   automatically. If there are multiple eligible fields, select the relation
   that identifies the owner. All restricted actions for that role and
   collection use the same field.

![Update with Only own records enabled and owner shown as the owner field](https://cdn.jsdelivr.net/npm/@3xweb/strapi-plugin-owner-permissions@0.1.0/docs/images/owner-permissions-update.jpg)

A different action in the same collection can keep native access. In this
example, **Find** is enabled for the role and **Only own records** is off.

![Find with the native permission enabled and Only own records off](https://cdn.jsdelivr.net/npm/@3xweb/strapi-plugin-owner-permissions@0.1.0/docs/images/owner-permissions-find.jpg)

Ownership is configured per role, collection, and core action. Actions with
**Only own records** enabled are limited to the caller's records. Other actions
for that role continue to follow the native permissions, so, for example, a
role can list all entries and only update its own entries. A collection with
ownership rules is available only to user roles configured for it. Collections
with no ownership rules keep their native behavior. Save the native action
permissions separately using the existing role save button.

Assign owners to existing documents through a trusted migration before enabling
the rule. Previously saved collection-wide rules are displayed and enforced
for all five core actions until changed. Removing the last rule for a collection
restores native access, including any permissions assigned to the public role.

On a protected collection, the server assigns the owner during creation and
prevents clients from setting or changing that relationship. A rule on `find`
covers both list results and pagination totals. Restricted individual actions
return 404 for records owned by someone else. Anonymous calls and API tokens
cannot access protected collections through the guarded REST API.

The ownership field must be a private, unidirectional many-to-one relationship
to Users & Permissions. The plugin rejects unsupported saved mappings at startup.
Protected collections support scalar fields and eligible ownership
relations. Only the selected owner relation is assigned on creation. Other
owner relations are managed by trusted server-side workflows. The plugin rejects populate, inbound relations to protected collections,
Draft & Publish, i18n, and GraphQL when mappings are enabled. Admin access and
internal jobs keep their existing access rules. Custom endpoints that read
directly from the database need their own explicit authorization. Rules are
keyed by core action, so custom endpoints cannot define a different rule for
another method or path using the same action.

For a fixture using the previous file-based mappings, record those rules, remove
the mapping configuration from plugins.js, and re-create the rules in the Roles
screen before making the REST API available. The plugin refuses to start with the
old configuration still present.

## Test locally

Run `npm run test:integration` with Strapi 5, Users & Permissions and
`better-sqlite3` available. To reuse a separate dependency installation, set
`STRAPI_TEST_DEPS` to the directory containing its `node_modules`. The test
creates a temporary Strapi app and SQLite database, logs in two synthetic users
using Users & Permissions, and exercises the built-in REST endpoints on
loopback.

Both the admin bundle and the REST integration suite were verified on Strapi
and Users & Permissions **5.49.0**, **5.62.0**, and **5.64.0**, using Node.js 22.
