import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import { DELIVERY_LABELS, EVENTS, EVENT_LABELS, SCOPES, SCOPE_LABELS, VERIFY_EXAMPLE } from '@/lib/api';
import { addEndpoint, createApiKey, deleteEndpoint, endpointSecret, revokeApiKey, sendTestEvent, setEndpointActive } from './actions';

export const metadata: Metadata = { title: 'API and webhooks' };

const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'never');

export default async function DevelopersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const h = await headers();
  const base = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('x-forwarded-host') ?? h.get('host') ?? ''}/api/v1`;

  if (!manage) {
    return (
      <main className="stack-lg">
        <h1>API and webhooks</h1>
        <p className="muted">Owners and admins create API keys and webhook endpoints for this workspace.</p>
      </main>
    );
  }

  const [{ data: keyRows }, { data: endpointRows }, { data: deliveryRows }] = await Promise.all([
    supabase.from('api_keys').select('id, name, prefix, scopes, created_at, last_used_at, revoked_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('webhook_endpoints').select('id, url, description, events, active, consecutive_failures, disabled_reason, created_at').eq('workspace_id', workspace.id).order('created_at'),
    supabase.from('webhook_deliveries').select('id, endpoint_id, event, status, attempts, last_status, last_error, created_at, delivered_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(50),
  ]);
  type Key = { id: string; name: string; prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
  type Endpoint = { id: string; url: string; description: string | null; events: string[]; active: boolean; consecutive_failures: number; disabled_reason: string | null };
  type Delivery = { id: string; endpoint_id: string; event: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: string };
  const keys = (keyRows ?? []) as Key[];
  const endpoints = (endpointRows ?? []) as Endpoint[];
  const deliveries = (deliveryRows ?? []) as Delivery[];
  const urlOf = new Map(endpoints.map((e) => [e.id, e.url]));
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

  return (
    <main className="stack-lg">
      <h1>API and webhooks</h1>
      <p>
        Connect your own systems: read and add leads with an API key, and have events sent to your server the moment
        they happen. Zapier, Make and n8n work with both. The full reference is in the API guide (docs/API.md).
      </p>

      <section className="card stack" aria-labelledby="keys">
        <h2 id="keys">API keys</h2>
        <p className="muted">
          Send the key as <code>Authorization: Bearer sdr_...</code> to <code>{base}</code>. Each key only sees this
          workspace, only does what its permissions allow, and is limited to 120 requests a minute.
        </p>
        {keys.length ? (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">API keys</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Permissions</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <th scope="row">{k.name}</th>
                    <td><code>{k.prefix}…</code></td>
                    <td>{k.scopes.join(', ')}</td>
                    <td>{k.revoked_at ? <span className="badge">Revoked</span> : when(k.last_used_at)}</td>
                    <td>
                      {k.revoked_at ? null : (
                        <ActionForm action={revokeApiKey}>
                          {hidden('workspace_id', workspace.id)}{hidden('key_id', k.id)}
                          <SubmitButton variant="ghost">Revoke</SubmitButton>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No keys yet.</p>}
        <ActionForm action={createApiKey} className="stack" resetOnSuccess>
          {hidden('workspace_id', workspace.id)}
          <label className="field"><span>Name, so you know where it is used</span><input name="name" type="text" maxLength={80} required placeholder="For example: website form" /></label>
          <fieldset className="stack">
            <legend>Permissions</legend>
            {SCOPES.map((s) => (
              <label key={s} className="choice"><input type="checkbox" name={`scope_${s}`} defaultChecked={s === 'leads:read'} /><span>{SCOPE_LABELS[s]} <code>{s}</code></span></label>
            ))}
          </fieldset>
          <SubmitButton>Create key</SubmitButton>
        </ActionForm>
      </section>

      <section className="card stack" aria-labelledby="hooks">
        <h2 id="hooks">Webhook endpoints</h2>
        <p className="muted">
          Each event is sent as a signed POST, retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours if your
          server does not answer with a 2xx. An endpoint that fails 15 times in a row is switched off and you are told.
        </p>
        {endpoints.map((e) => (
          <article key={e.id} className="card stack" aria-label={e.url}>
            <div className="row">
              <strong>{e.url}</strong>
              <span className={e.active ? 'badge badge-ok' : 'badge badge-warn'}>{e.active ? 'On' : 'Off'}</span>
            </div>
            {e.description ? <p className="muted">{e.description}</p> : null}
            <p className="muted">Events: {e.events.map((x) => EVENT_LABELS[x as keyof typeof EVENT_LABELS] ?? x).join(', ')}</p>
            {e.disabled_reason ? <p><span className="badge badge-warn">Needs attention</span> {e.disabled_reason}</p> : null}
            <div className="row">
              <ActionForm action={sendTestEvent}>{hidden('workspace_id', workspace.id)}{hidden('endpoint_id', e.id)}<SubmitButton variant="secondary">Send a test event</SubmitButton></ActionForm>
              <ActionForm action={endpointSecret}>{hidden('workspace_id', workspace.id)}{hidden('endpoint_id', e.id)}<SubmitButton variant="ghost">Show signing secret</SubmitButton></ActionForm>
              <ActionForm action={endpointSecret}>{hidden('workspace_id', workspace.id)}{hidden('endpoint_id', e.id)}{hidden('rotate', 'true')}<SubmitButton variant="ghost">Replace signing secret</SubmitButton></ActionForm>
              <ActionForm action={setEndpointActive}>{hidden('workspace_id', workspace.id)}{hidden('endpoint_id', e.id)}{hidden('active', e.active ? 'false' : 'true')}<SubmitButton variant="ghost">{e.active ? 'Switch off' : 'Switch on'}</SubmitButton></ActionForm>
              <ActionForm action={deleteEndpoint}>{hidden('workspace_id', workspace.id)}{hidden('endpoint_id', e.id)}<SubmitButton variant="ghost">Delete</SubmitButton></ActionForm>
            </div>
          </article>
        ))}
        <ActionForm action={addEndpoint} className="stack" resetOnSuccess>
          {hidden('workspace_id', workspace.id)}
          <label className="field"><span>Address (https)</span><input name="url" type="url" maxLength={500} required placeholder="https://hooks.example.com/sdr" /></label>
          <label className="field"><span>Description (optional)</span><input name="description" type="text" maxLength={200} /></label>
          <fieldset className="stack">
            <legend>Events to send</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="choice"><input type="checkbox" name={`event_${ev}`} defaultChecked={ev === 'meeting.booked' || ev === 'deal.won'} /><span>{EVENT_LABELS[ev]} <code>{ev}</code></span></label>
            ))}
          </fieldset>
          <SubmitButton>Add endpoint</SubmitButton>
        </ActionForm>
        <details>
          <summary>Verifying a delivery</summary>
          <p className="muted">
            Each delivery carries <code>X-SDR-Signature: t=&lt;seconds&gt;,v1=&lt;HMAC-SHA256&gt;</code> of
            <code> &lt;t&gt;.&lt;raw body&gt;</code> with the endpoint&apos;s signing secret, plus <code>X-SDR-Event</code> and
            <code> X-SDR-Delivery</code>. The body&apos;s <code>id</code> is the same on every retry, so a repeat can be ignored.
          </p>
          <pre className="pre">{VERIFY_EXAMPLE}</pre>
        </details>
      </section>

      <section className="stack" aria-labelledby="deliveries">
        <h2 id="deliveries">Recent deliveries</h2>
        {deliveries.length === 0 ? <p className="muted">Nothing sent yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Recent webhook deliveries</caption>
              <thead><tr><th scope="col">Event</th><th scope="col">Endpoint</th><th scope="col">Result</th><th scope="col">Attempts</th><th scope="col">Queued</th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <th scope="row"><code>{d.event}</code></th>
                    <td>{urlOf.get(d.endpoint_id) ?? '—'}</td>
                    <td>
                      <span className={d.status === 'delivered' ? 'badge badge-ok' : d.status === 'dead' ? 'badge badge-error' : 'badge'}>{DELIVERY_LABELS[d.status] ?? d.status}</span>
                      {d.last_error && d.status !== 'delivered' ? <><br /><small className="muted">{d.last_error}</small></> : null}
                    </td>
                    <td>{d.attempts}</td>
                    <td>{when(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
