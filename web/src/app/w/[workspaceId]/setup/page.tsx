import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { TOOLS, buildOnboardingPlan, type IntegrationStatus, type ToolId } from '@/lib/integrations';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { connectTool, disconnectTool, updateChecklist } from './actions';

export const metadata: Metadata = { title: 'Setup' };

type Row = {
  tool: ToolId;
  status: IntegrationStatus;
  meta: Record<string, string>;
  last_error: string | null;
  last_health_check_at: string | null;
  credits_remaining: number | null;
};

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: 'Connected',
  error: 'Needs attention',
  expired: 'Expired',
  disconnected: 'Not connected',
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}

export default async function SetupPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  const { data } = await supabase
    .from('integrations')
    .select('tool, status, meta, last_error, last_health_check_at, credits_remaining')
    .eq('workspace_id', workspace.id);
  const rows = new Map(((data ?? []) as Row[]).map((r) => [r.tool, r]));

  const plan = buildOnboardingPlan({
    enabledChannels: workspace.enabled_channels,
    aiCloserEnabled: workspace.ai_closer_enabled,
    statuses: Object.fromEntries([...rows].map(([t, r]) => [t, r.status])),
    checklist: workspace.setup_checklist ?? {},
  });
  const visibleSteps = plan.steps.filter((s) => s.required || s.id === 'crm' || s.done);
  const skipped = plan.steps.filter((s) => !s.required && s.id !== 'crm' && !s.done);

  return (
    <>
      <div className="stack">
        <h1>Setup</h1>
        <p className="muted">
          Connect your own accounts so the agents work for your company. Each connection is tested before it is saved,
          and credentials are stored encrypted. They are never shown again, even to you.
        </p>
        <div className="progress" role="progressbar" aria-valuenow={plan.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <div className="progress-bar" style={{ width: `${plan.progress}%` }} />
        </div>
        <p><strong>{plan.progress}% complete.</strong> {plan.ready ? 'Everything your enabled channels need is in place.' : 'Finish the steps below to start outreach.'}</p>
        {!manage ? <p className="muted">You can see the setup. Only owners and admins can connect tools.</p> : null}
      </div>

      {visibleSteps.map((step) => (
        <section key={step.id} className="card stack" aria-labelledby={`step-${step.id}`}>
          <div className="row spread">
            <h2 id={`step-${step.id}`}>{step.title}</h2>
            <span className={step.done ? 'badge badge-ok' : step.required ? 'badge badge-warn' : 'badge'}>
              {step.done ? 'Done' : step.required ? 'Required' : 'Optional'}
            </span>
          </div>
          <p className="muted">{step.description}</p>
          <div className="tools">
            {step.tools.map((toolId) => {
              const tool = TOOLS[toolId];
              const row = rows.get(toolId);
              const status: IntegrationStatus = row?.status ?? 'disconnected';
              const connected = status !== 'disconnected';
              return (
                <article key={toolId} className="tool" aria-labelledby={`tool-${toolId}`}>
                  <div className="row spread">
                    <h3 id={`tool-${toolId}`}>{tool.name}</h3>
                    <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
                  </div>
                  <p className="muted">{tool.purpose}</p>
                  {connected ? (
                    <ul className="facts">
                      {row?.meta?.hint ? <li>Key {row.meta.hint}</li> : null}
                      {row?.meta?.team ? <li>Workspace {row.meta.team}</li> : null}
                      {row?.meta?.phone ? <li>Number {row.meta.phone}</li> : null}
                      {row?.credits_remaining != null ? <li>{Number(row.credits_remaining).toLocaleString('en')} credits</li> : null}
                      {row?.last_health_check_at ? <li>Checked {formatDate(row.last_health_check_at)}</li> : null}
                    </ul>
                  ) : null}
                  {row?.last_error && status !== 'connected' ? <p className="form-message form-error">{row.last_error}</p> : null}
                  {manage ? (
                    <details className="connect" open={!connected && step.required && !step.done}>
                      <summary>{connected ? 'Replace credentials' : `Connect ${tool.name}`}</summary>
                      <ActionForm action={connectTool} className="stack" resetOnSuccess>
                        <input type="hidden" name="workspace_id" value={workspace.id} />
                        <input type="hidden" name="tool" value={toolId} />
                        {tool.fields.map((f) => (
                          <label key={f.name} className="field">
                            <span>{f.label}</span>
                            <input
                              name={f.name}
                              type={f.secret ? 'password' : 'text'}
                              autoComplete="off"
                              spellCheck={false}
                              required
                              aria-describedby={f.help ? `${toolId}-${f.name}-help` : undefined}
                            />
                            {f.help ? <small id={`${toolId}-${f.name}-help`}>{f.help}</small> : null}
                          </label>
                        ))}
                        <p className="muted">
                          Where to find it: <a href={tool.docsUrl} target="_blank" rel="noopener noreferrer">{tool.name} settings</a>
                        </p>
                        <SubmitButton>Test and connect</SubmitButton>
                      </ActionForm>
                      {connected ? (
                        <ActionForm action={disconnectTool}>
                          <input type="hidden" name="workspace_id" value={workspace.id} />
                          <input type="hidden" name="tool" value={toolId} />
                          <SubmitButton variant="ghost">Disconnect and delete credentials</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {plan.checklist.length ? (
        <section className="card stack" aria-labelledby="manual">
          <h2 id="manual">Manual setup steps</h2>
          <p className="muted">These are done in each provider&apos;s own dashboard. Tick them off when they are finished.</p>
          <ActionForm action={updateChecklist} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <fieldset className="stack plain" disabled={!manage}>
              <legend className="sr-only">Manual setup steps</legend>
              {plan.checklist.map((item) => (
                <label key={item.id} className="choice">
                  <input type="checkbox" name={`check_${item.id}`} defaultChecked={item.done} />
                  <span><strong>{item.title}</strong><br />{item.description}</span>
                </label>
              ))}
            </fieldset>
            {manage ? <SubmitButton variant="secondary">Save checklist</SubmitButton> : null}
          </ActionForm>
        </section>
      ) : null}

      {skipped.length ? (
        <p className="muted">
          Not needed with your current channels: {skipped.map((s) => s.title).join(', ')}. Turn the channel on in Settings to add them.
        </p>
      ) : null}
    </>
  );
}
