// Turns database and auth errors into messages that are safe to show.

type ErrorLike = { code?: string; message?: string } | null | undefined;

export function friendlyDbError(error: ErrorLike, fallback = 'Something went wrong. Please try again.'): string {
  if (!error) return fallback;
  switch (error.code) {
    case '42501':
      return error.message?.startsWith('You are not allowed')
        ? error.message
        : 'You do not have permission to do that.';
    case 'P0002':
      return 'No account found for this email. Ask them to sign up first.';
    case '23505':
      return error.message?.includes('already a member')
        ? 'This person is already a member of the workspace.'
        : 'That already exists.';
    case '23514':
      if (error.message === 'Invalid credentials') return 'Those credentials are not valid.';
      return error.message?.includes('at least one owner')
        ? 'A workspace must keep at least one owner.'
        : 'That value is not allowed.';
    default:
      return fallback;
  }
}

export function friendlyAuthError(error: ErrorLike): string {
  const code = error?.code ?? '';
  if (code === 'invalid_credentials') return 'Email or password is incorrect.';
  if (code === 'email_not_confirmed') return 'Confirm your email address first. Check your inbox for the link.';
  if (code === 'user_already_exists' || code === 'email_exists') return 'An account with this email already exists. Sign in instead.';
  if (code === 'weak_password') return 'Choose a stronger password.';
  if (code.includes('rate_limit')) return 'Too many attempts. Wait a minute and try again.';
  return 'We could not complete that. Please try again.';
}
