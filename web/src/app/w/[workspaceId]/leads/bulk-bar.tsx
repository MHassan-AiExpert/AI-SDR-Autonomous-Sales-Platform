'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/action-form';
import { LEAD_STAGES, STAGE_LABELS } from '@/lib/campaigns';
import { bulkUpdateLeads } from '../actions';

type Campaign = { id: string; name: string };

/**
 * Wraps the leads table: the checkboxes live inside this form, so the chosen
 * action is submitted with every selected lead id.
 */
export function BulkBar({ workspaceId, campaigns, canEdit, children }: {
  workspaceId: string; campaigns: Campaign[]; canEdit: boolean; children: React.ReactNode;
}) {
  const [state, action] = useActionState(bulkUpdateLeads, {});
  const [choice, setChoice] = useState<'stage' | 'owner' | 'campaign' | 'suppress'>('stage');
  const [count, setCount] = useState(0);

  if (!canEdit) return <>{children}</>;

  function recount(form: HTMLFormElement | null) {
    if (!form) return;
    setCount(form.querySelectorAll<HTMLInputElement>('input[name="lead_id"]:checked').length);
  }

  return (
    <form action={action} onChange={(e) => recount(e.currentTarget)} className="stack">
      <input type="hidden" name="workspace_id" value={workspaceId} />
      {children}

      <div className="card stack" role="group" aria-label="Act on selected leads">
        <div className="row">
          <strong>{count ? `${count} selected` : 'Select leads to act on them'}</strong>
          <label className="field">
            <span className="sr-only">What to do</span>
            <select name="bulk_action" value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
              <option value="stage">Change stage</option>
              <option value="owner">Assign owner</option>
              <option value="campaign">Move to campaign</option>
              <option value="suppress">Suppress (never contact)</option>
            </select>
          </label>

          {choice === 'stage' ? (
            <label className="field">
              <span className="sr-only">Stage</span>
              <select name="stage" defaultValue="contacted">
                {LEAD_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
              </select>
            </label>
          ) : null}

          {choice === 'owner' ? (
            <label className="field">
              <span className="sr-only">Owner</span>
              <select name="owner_id" defaultValue="me"><option value="me">Me</option><option value="none">Nobody</option></select>
            </label>
          ) : null}

          {choice === 'campaign' ? (
            <label className="field">
              <span className="sr-only">Campaign</span>
              <select name="campaign_id" defaultValue={campaigns[0]?.id ?? ''}>
                {campaigns.length ? campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">No campaigns yet</option>}
              </select>
            </label>
          ) : null}

          <SubmitButton variant="secondary">Apply</SubmitButton>
        </div>
        {choice === 'suppress' ? (
          <p className="muted">Their email and phone go on the suppression list, so no agent contacts them again on any channel, and future imports skip them.</p>
        ) : null}
        {state?.error ? <p className="form-message form-error" role="alert">{state.error}</p> : null}
        {state?.notice ? <p className="form-message form-ok" role="status">{state.notice}</p> : null}
      </div>
    </form>
  );
}
