import type { UserConfig } from 'vite' with { 'resolution-mode': 'import' };

/** Adds the Owner Permissions controls to the native Strapi Roles editor. */
export function withOwnerPermissionsRoleEditor(config: UserConfig): UserConfig;
