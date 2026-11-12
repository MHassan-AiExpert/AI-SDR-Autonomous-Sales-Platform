import { describe, expect, it } from 'vitest';
import { friendlyAuthError, friendlyDbError } from '@/lib/errors';

describe('error messages', () => {
  it('WEB-20 maps database errors to clear messages', () => {
    expect(friendlyDbError({ code: '42501', message: 'new row violates row-level security policy' })).toMatch(/permission/);
    expect(friendlyDbError({ code: '42501', message: 'You are not allowed to add a member with this role' })).toMatch(/not allowed/);
    expect(friendlyDbError({ code: 'P0002', message: 'x' })).toMatch(/sign up first/);
    expect(friendlyDbError({ code: '23505', message: 'This person is already a member of the workspace' })).toMatch(/already a member/);
    expect(friendlyDbError({ code: '23514', message: 'A workspace must keep at least one owner' })).toMatch(/at least one owner/);
  });

  it('WEB-21 never leaks raw database details', () => {
    const msg = friendlyDbError({ code: 'XX000', message: 'relation "public.secret_table" does not exist' });
    expect(msg).not.toMatch(/secret_table|relation/);
    expect(friendlyDbError(null)).toMatch(/Something went wrong/);
  });

  it('WEB-22 sign-in errors do not reveal whether an email exists', () => {
    expect(friendlyAuthError({ code: 'invalid_credentials' })).toBe('Email or password is incorrect.');
    expect(friendlyAuthError({ code: 'email_not_confirmed' })).toMatch(/Confirm your email/);
    expect(friendlyAuthError({ code: 'over_request_rate_limit' })).toMatch(/Too many attempts/);
    expect(friendlyAuthError({ code: 'weird' })).toMatch(/could not complete/);
  });
});
