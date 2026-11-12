'use client';

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import type { FormState } from '@/lib/form-state';

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

const PendingContext = createContext(false);

export function SubmitButton({ children, variant = 'primary' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" className={`btn btn-${variant}`} disabled={pending} aria-busy={pending}>
      {pending ? 'Working…' : children}
    </button>
  );
}

/**
 * A form bound to a Server Action that shows the action's error or notice.
 * What the person typed stays in place when the action returns an error.
 * Without JavaScript the form still posts to the same action.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.notice) ref.current?.reset();
  }, [state, resetOnSuccess]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Include the clicked button's name and value, as a normal form post would
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const data = new FormData(event.currentTarget, submitter && submitter.name ? submitter : undefined);
    startTransition(() => formAction(data));
  }

  return (
    <form ref={ref} action={formAction} onSubmit={onSubmit} className={className} noValidate>
      <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
      {state?.error ? (
        <p className="form-message form-error" role="alert">{state.error}</p>
      ) : null}
      {state?.notice ? (
        <p className="form-message form-notice" role="status">{state.notice}</p>
      ) : null}
    </form>
  );
}
