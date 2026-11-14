import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { BrandMark } from '@/components/brand-mark';
import { brandStyle, readBrand } from '@/lib/brand';
import { AGENCY_ROLE_LABELS, DEFAULT_FIELDS, canManageAgency, readUsage, requireAgency, revenueText, usagePercent, type AgencyRole } from '@/lib/agency';
import { RANGES, RANGE_LABELS, parseRange, period } from '@/lib/analytics';
import { addAgencyMember, createClientWorkspace, deleteAgencyTemplate, promoteTemplate, removeAgencyMember, saveBrand, saveDefaults, setClientPlan, setTemplateDefault } from '../actions';
import { KIND_LABELS, describeSequenceTemplate, type TemplateRow } from '@/lib/templates';

export const metadata: Metadata = { title: 'Agency console' };

export default async function AgencyConsole({ params, searchParams }: { params: Promise<{ agencyId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { agencyId } = await params;
  const { supabase, user, agency } = await requireAgency(agencyId);
  const sp = await searchParams;
  const range = parseRange(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  const { from, to } = period(range);
  const manage = canManageAgency(agency.role);

  const [{ data: rawUsage, error: usageError }, { data: brandRow }, { data: team }, { data: myWorkspaces }, { data: libraryRows }, { data: promotableRows }] = await Promise.all([
    supabase.rpc('agency_usage', { ag: agency.id, p_from: from.toISOString(), p_to: to.toISOString() }),
    supabase.from('agency_brands').select('app_name, logo_url, primary_color, support_email, custom_domain').eq('agency_id', agency.id).maybeSingle(),
    supabase.rpc('agency_members_list', { ag: agency.id }),
    supabase.from('workspace_members').select('workspace_id, role').eq('user_id', user.id),
    supabase.from('templates').select('id, workspace_id, agency_id, kind, name, description, payload, is_default, updated_at')
      .eq('agency_id', agency.id).order('kind').order('name'),
    supabase.from('templates').select('id, workspace_id, agency_id, kind, name, description, payload, is_default, updated_at')
      .not('workspace_id', 'is', null).order('kind').order('name'),
  ]);
  const usage = readUsage(rawUsage);
  const brand = readBrand(brandRow ?? { app_name: agency.name });
  const memberOf = new Set((myWorkspaces ?? []).map((m) => m.workspace_id));
  const defaults = agency.campaign_defaults;
  const hidden = <input type="hidden" name="agency_id" value={agency.id} />;
  const library = (libraryRows ?? []) as unknown as TemplateRow[];
  const promotable = (promotableRows ?? []) as unknown as TemplateRow[];

  return (
    <div className="shell" style={brandStyle(brand)}>
      <header className="topbar">
        <div className="row">
          <BrandMark brand={brand} />
          <span className="divider" aria-hidden="true">/</span>
          <span className="ws-name">{agency.name}</span>
          <span className="badge">{AGENCY_ROLE_LABELS[agency.role]}</span>
        </div>
        <div className="row">
          <Link href="/agency">Agencies</Link>
          <Link href="/workspaces">Workspaces</Link>
          <form action="/auth/signout" method="post"><button className="btn btn-ghost" type="submit">Sign out</button></form>
        </div>
      </header>
      <main className="content stack-lg">
        <div className="spread">
          <h1>Agency console</h1>
          <nav className="row" aria-label="Period">
            {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => (
              <Link key={r} href={`/agency/${agency.id}?range=${r}`} className={r === range ? 'btn btn-secondary' : 'btn btn-ghost'} aria-current={r === range ? 'page' : undefined}>{RANGE_LABELS[r]}</Link>
            ))}
            <a className="btn btn-ghost" href={`/agency/${agency.id}/usage?range=${range}`}>Download usage (CSV)</a>
          </nav>
        </div>

        <section className="card stack" aria-labelledby="clients">
          <h2 id="clients">Clients</h2>
          <p className="muted">Usage for {RANGE_LABELS[range].toLowerCase()}. Only counts are shown here; open a client workspace to see its leads and conversations. You can open a workspace only where you hold a role in it.</p>
          {usageError || !usage ? <p className="form-message form-error" role="alert">Client usage could not be loaded. Refresh to try again.</p> : null}
          {usage && !usage.length ? <p className="muted">No client workspaces yet. Create the first one below.</p> : null}
          {usage?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th scope="col">Client</th><th scope="col">Plan</th><th scope="col">Leads this month</th><th scope="col">Team</th><th scope="col">Emails</th><th scope="col">Calls (min)</th><th scope="col">Texts</th><th scope="col">Meetings</th><th scope="col">Won</th><th scope="col">Revenue</th></tr>
                </thead>
                <tbody>
                  {usage.map((c) => {
                    const pct = usagePercent(c.leads_this_month, c.monthly_lead_limit);
                    return (
                      <tr key={c.id}>
                        <td>{memberOf.has(c.id) ? <Link href={`/w/${c.id}`}>{c.name}</Link> : c.name}{c.outreach_paused ? <> <span className="badge badge-warn">Paused</span></> : null}</td>
                        <td>{c.plan}</td>
                        <td>{c.leads_this_month}{c.monthly_lead_limit ? ` of ${c.monthly_lead_limit}` : ''}{pct !== null && pct >= 90 ? <> <span className="badge badge-warn">{pct}%</span></> : null}</td>
                        <td>{c.members}{c.seat_limit ? ` of ${c.seat_limit}` : ''}</td>
                        <td>{c.emails}</td>
                        <td>{c.calls} ({c.call_minutes})</td>
                        <td>{c.texts}</td>
                        <td>{c.meetings}</td>
                        <td>{c.won}</td>
                        <td>{revenueText(c.revenue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {manage && usage?.length ? (
            <details>
              <summary>Change a client&apos;s plan and limits</summary>
              <div className="stack">
                {usage.map((c) => (
                  <ActionForm key={c.id} action={setClientPlan} className="row">
                    {hidden}<input type="hidden" name="workspace_id" value={c.id} />
                    <strong>{c.name}</strong>
                    <label className="field"><span>Plan</span><input name="plan" type="text" required maxLength={40} defaultValue={c.plan} /></label>
                    <label className="field"><span>Leads per month</span><input name="monthly_lead_limit" type="number" min={1} defaultValue={c.monthly_lead_limit ?? ''} placeholder="No limit" /></label>
                    <label className="field"><span>Seats</span><input name="seat_limit" type="number" min={1} defaultValue={c.seat_limit ?? ''} placeholder="No limit" /></label>
                    <SubmitButton variant="secondary">Save</SubmitButton>
                  </ActionForm>
                ))}
              </div>
            </details>
          ) : null}
        </section>

        {manage ? (
          <section className="card stack" aria-labelledby="new-client">
            <h2 id="new-client">New client workspace</h2>
            <p className="muted">You become the workspace owner. It starts from your default playbook and cadence below. Then invite the client from the workspace&apos;s Team page.</p>
            <ActionForm action={createClientWorkspace} className="stack">
              {hidden}
              <div className="grid-2">
                <label className="field"><span>Client company</span><input name="name" type="text" required minLength={2} maxLength={120} autoComplete="off" /></label>
                <label className="field"><span>Plan</span><input name="plan" type="text" required maxLength={40} defaultValue="Starter" /></label>
                <label className="field"><span>Leads per month</span><input name="monthly_lead_limit" type="number" min={1} placeholder="No limit" /></label>
                <label className="field"><span>Seats</span><input name="seat_limit" type="number" min={1} placeholder="No limit" /></label>
              </div>
              <SubmitButton>Create client workspace</SubmitButton>
            </ActionForm>
          </section>
        ) : null}

        <section className="card stack" aria-labelledby="brand">
          <h2 id="brand">Brand</h2>
          <p className="muted">Your clients see this name, logo and colour on the sign-in pages and throughout the app, and the agents use the app name in what they create (CRM notes, sending campaigns, payment settings). To use your own domain, add a CNAME record pointing it at the app and enter it here.</p>
          <ActionForm action={saveBrand} className="stack">
            {hidden}
            <fieldset className="stack" disabled={!manage}>
              <legend className="sr-only">Brand settings</legend>
              <div className="grid-2">
                <label className="field"><span>App name</span><input name="app_name" type="text" required maxLength={60} defaultValue={brand.app_name} /></label>
                <label className="field"><span>Logo address (https)</span><input name="logo_url" type="url" maxLength={500} defaultValue={brand.logo_url ?? ''} placeholder="https://youragency.com/logo.png" /></label>
                <label className="field"><span>Brand colour</span><input name="primary_color" type="color" defaultValue={brand.primary_color ?? '#2f5bea'} /></label>
                <label className="field"><span>Support email</span><input name="support_email" type="email" maxLength={270} defaultValue={brand.support_email ?? ''} /></label>
                <label className="field"><span>Custom domain</span><input name="custom_domain" type="text" maxLength={253} defaultValue={brandRow?.custom_domain ?? ''} placeholder="app.youragency.com" /></label>
              </div>
            </fieldset>
            {manage ? <SubmitButton>Save brand</SubmitButton> : null}
          </ActionForm>
        </section>

        <section className="card stack" aria-labelledby="defaults">
          <h2 id="defaults">Defaults for new clients</h2>
          <p className="muted">New client workspaces copy these, and their new campaigns start with this cadence. Leave a field empty to keep the standard value shown.</p>
          <ActionForm action={saveDefaults} className="stack">
            {hidden}
            <fieldset className="stack" disabled={!manage}>
              <legend className="sr-only">Cadence defaults</legend>
              <div className="grid-2">
                {DEFAULT_FIELDS.map((f) => (
                  <label key={f.key} className="field">
                    <span>{f.label}</span>
                    <input name={f.key} type={f.type === 'time' ? 'text' : 'number'} inputMode={f.type === 'time' ? 'numeric' : undefined} pattern={f.type === 'time' ? '([01][0-9]|2[0-3]):[0-5][0-9]' : undefined} placeholder={f.placeholder} defaultValue={defaults[f.key] === undefined ? '' : String(defaults[f.key])} />
                  </label>
                ))}
              </div>
              <label className="field">
                <span>Default playbook</span>
                <select name="playbook_from" defaultValue="">
                  <option value="">{agency.has_default_playbook ? 'Keep the current default playbook' : 'No default playbook'}</option>
                  {(usage ?? []).filter((c) => memberOf.has(c.id)).map((c) => <option key={c.id} value={c.id}>Copy the playbook of {c.name}</option>)}
                  {agency.has_default_playbook ? <option value="none">Remove the default playbook</option> : null}
                </select>
                <small className="muted">Build a playbook once in one client workspace, then copy it here for every new client.</small>
              </label>
            </fieldset>
            {manage ? <SubmitButton>Save defaults</SubmitButton> : null}
          </ActionForm>
        </section>

        <section className="card stack" aria-labelledby="library">
          <h2 id="library">Template library</h2>
          <p className="muted">
            Build a sequence or a snippet once in one client workspace, then copy it here. Anything marked as a
            default is copied into every new client workspace when it is created; clients already created keep what
            they have.
          </p>

          {library.length === 0 ? (
            <p>Nothing in the agency library yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Templates in the agency library</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Kind</th>
                    <th scope="col">What it is</th>
                    <th scope="col">New clients get it</th>
                    {manage ? <th scope="col">Change</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {library.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">{t.name}</th>
                      <td>{KIND_LABELS[t.kind]}</td>
                      <td>{t.kind === 'sequence' ? describeSequenceTemplate(t) : (t.description ?? 'A block of copy.')}</td>
                      <td>{t.is_default ? 'Yes' : 'No'}</td>
                      {manage ? (
                        <td>
                          <ActionForm action={setTemplateDefault}>
                            {hidden}
                            <input type="hidden" name="template_id" value={t.id} />
                            {t.is_default ? null : <input type="hidden" name="is_default" value="on" />}
                            <SubmitButton variant="ghost">{t.is_default ? 'Stop giving it to new clients' : 'Give it to new clients'}</SubmitButton>
                          </ActionForm>
                          <ActionForm action={deleteAgencyTemplate}>
                            {hidden}
                            <input type="hidden" name="template_id" value={t.id} />
                            <SubmitButton variant="ghost">Remove</SubmitButton>
                          </ActionForm>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {manage ? (
            promotable.length === 0 ? (
              <p className="muted">
                Nothing to copy yet. Save a sequence or add a snippet in one of your client workspaces first.
              </p>
            ) : (
              <ActionForm action={promoteTemplate} className="stack">
                {hidden}
                <label className="field">
                  <span>Copy a template from a client workspace</span>
                  <select name="template_id" defaultValue="">
                    <option value="" disabled>Choose a template</option>
                    {promotable.map((t) => (
                      <option key={t.id} value={t.id}>{KIND_LABELS[t.kind]}: {t.name}</option>
                    ))}
                  </select>
                </label>
                <label className="choice">
                  <input type="checkbox" name="is_default" defaultChecked />
                  <span>Give it to every new client workspace</span>
                </label>
                <SubmitButton variant="secondary">Copy into the agency library</SubmitButton>
              </ActionForm>
            )
          ) : null}
        </section>

        <section className="card stack" aria-labelledby="team">
          <h2 id="team">Agency team</h2>
          <p className="muted">Admins manage clients, the brand and defaults. Staff see the console. Neither sees a client&apos;s records unless a workspace owner gives them a role in that workspace.</p>
          <ul className="list">
            {((team ?? []) as { user_id: string; email: string | null; role: AgencyRole }[]).map((m) => (
              <li key={m.user_id} className="spread">
                <span>{m.email ?? 'Unknown'}{m.user_id === user.id ? ' (you)' : ''}</span>
                <span className="row">
                  <span className="badge">{AGENCY_ROLE_LABELS[m.role] ?? m.role}</span>
                  {manage && m.role !== 'owner' && m.user_id !== user.id ? (
                    <ActionForm action={removeAgencyMember}>{hidden}<input type="hidden" name="user_id" value={m.user_id} /><SubmitButton variant="secondary">Remove</SubmitButton></ActionForm>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {manage ? (
            <ActionForm action={addAgencyMember} className="row">
              {hidden}
              <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
              <label className="field"><span>Role</span><select name="role" defaultValue="staff"><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
              <SubmitButton variant="secondary">Add to team</SubmitButton>
            </ActionForm>
          ) : null}
        </section>
      </main>
    </div>
  );
}
