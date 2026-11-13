import { ActionForm, SubmitButton } from '@/components/action-form';
import { setAuditEnabled } from '../actions';

export function AuditSection({ workspaceId, campaignId, enabled, manage, stats }: {
  workspaceId: string; campaignId: string; enabled: boolean; manage: boolean; stats: { ready: number; opened: number };
}) {
  return (
    <section className="card stack" aria-labelledby="audits">
      <div className="spread">
        <h2 id="audits">Website audits</h2>
        <span className={enabled ? 'badge badge-ok' : 'badge'}>{enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="muted">Each qualified lead gets a free audit of their website and marketing: security, search basics, phones, speed, ways to call, contact and book, tracking, business details for search engines, social profiles and Google reviews, all measured from their own site, with three recommendations. The first email links to it on a private page. When a lead opens it you see it on their timeline and in Slack, and the lead moves to Engaged. With audits on, emails are written once the audit has been tried.</p>
      <dl className="stats"><div><dt>Audits ready</dt><dd>{stats.ready}</dd></div><div><dt>Opened</dt><dd>{stats.opened}</dd></div></dl>
      {manage ? (
        <ActionForm action={setAuditEnabled}>
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="campaign_id" value={campaignId} />
          <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
          <SubmitButton variant={enabled ? 'secondary' : 'primary'}>{enabled ? 'Turn audits off' : 'Turn audits on'}</SubmitButton>
        </ActionForm>
      ) : null}
    </section>
  );
}
