import { describe, expect, it } from 'vitest';
import { assignableRoles, canDeleteWorkspace, canInvite, canManageMember, canManageSettings, isRole, ROLES } from '@/lib/roles';

describe('roles', () => {
  it('WEB-01 only owners and admins manage settings and the kill switch', () => {
    expect(ROLES.filter(canManageSettings)).toEqual(['owner', 'admin']);
  });

  it('WEB-02 only owners can delete a workspace', () => {
    expect(ROLES.filter(canDeleteWorkspace)).toEqual(['owner']);
  });

  it('WEB-03 owners can hand out every role; admins only rep and viewer; others none', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'rep', 'viewer']);
    expect(assignableRoles('admin')).toEqual(['rep', 'viewer']);
    expect(assignableRoles('rep')).toEqual([]);
    expect(assignableRoles('viewer')).toEqual([]);
  });

  it('WEB-04 admins cannot manage owners or other admins', () => {
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'admin')).toBe(false);
    expect(canManageMember('admin', 'rep')).toBe(true);
    expect(canManageMember('admin', 'viewer')).toBe(true);
  });

  it('WEB-05 owners manage everyone; reps and viewers manage no one', () => {
    for (const target of ROLES) {
      expect(canManageMember('owner', target)).toBe(true);
      expect(canManageMember('rep', target)).toBe(false);
      expect(canManageMember('viewer', target)).toBe(false);
    }
  });

  it('WEB-06 only owners and admins see the add-member form', () => {
    expect(ROLES.filter(canInvite)).toEqual(['owner', 'admin']);
  });

  it('WEB-07 unknown role values are rejected', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('superadmin')).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
