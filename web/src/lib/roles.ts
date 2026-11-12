// Role rules for the interface. The database enforces the same rules through
// row-level security; this module only decides what to show.

export const ROLES = ['owner', 'admin', 'rep', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  rep: 'Sales rep',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full control, including billing, owners and deleting the workspace',
  admin: 'Manages settings, channels, campaigns, reps and viewers',
  rep: 'Works leads, follow-ups, meetings and deals',
  viewer: 'Read-only access',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Workspace settings, channel switches and the kill switch. */
export function canManageSettings(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

export function canDeleteWorkspace(role: Role): boolean {
  return role === 'owner';
}

/** Roles this actor may hand out when adding or changing a member. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === 'owner') return [...ROLES];
  if (actor === 'admin') return ['rep', 'viewer'];
  return [];
}

/** Whether the actor may change or remove a member who currently has `target`. */
export function canManageMember(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target === 'rep' || target === 'viewer';
  return false;
}

export function canInvite(actor: Role): boolean {
  return assignableRoles(actor).length > 0;
}
