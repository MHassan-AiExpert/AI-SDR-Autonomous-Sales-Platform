// Monitoring (SRS M11, section 10.4 and 10.6): every 15 minutes each
// workspace is checked for problems the team should know about, and a daily
// summary is sent each morning in the workspace's time zone.
//
// * Bounce or opt-out rate over the workspace's limit (at least 50 emails in
//   the last 7 days): the campaign's emails are paused and the team is told.
// * An integration that stopped working, or whose credits run low.
// * Tasks stuck in the queue for more than 15 minutes.
// * Alerts held during quiet hours are posted once they end.

import { flushHeld, localDay, localHour, notify } from './notify.ts';
import type { Deps } from './jobs.ts';
import { log } from './log.ts';

export const MIN_SENT = 50;
export const SUMMARY_HOUR = 8;

const TOOL_NAMES: Record<string, string> = {
  apollo: 'Apollo', apify: 'Apify', zerobounce: 'ZeroBounce', instantly: 'Instantly', twilio: 'Twilio', vapi: 'Vapi', slack: 'Slack',
  hubspot: 'HubSpot', calendly: 'Calendly', stripe: 'Stripe', pandadoc: 'PandaDoc', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini',
};
const toolName = (t: string) => TOOL_NAMES[t] ?? t;
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const md = (s: string) => s.replace(/[*_~`<>&]/g, '');

export type RateCheck = { pause: boolean; reason: string | null; bounce: number; optout: number };

/** Decides from measured counts whether a campaign's emails must stop. */
export function checkRates(sent: number, bounced: number, optedOut: number, bouncePct: number, optoutPct: number): RateCheck {
  const bounce = sent ? bounced / sent : 0;
  const optout = sent ? optedOut / sent : 0;
  if (sent < MIN_SENT) return { pause: false, reason: null, bounce, optout };
  if (bounce * 100 >= bouncePct) return { pause: true, reason: `Bounce rate ${pct(bounce)} over the last 7 days (${bounced} of ${sent} emails) reached the ${bouncePct}% limit`, bounce, optout };
  if (optout * 100 >= optoutPct) return { pause: true, reason: `Opt-out rate ${pct(optout)} over the last 7 days (${optedOut} of ${sent} emails) reached the ${optoutPct}% limit`, bounce, optout };
  return { pause: false, reason: null, bounce, optout };
}

export function summaryText(name: string, a: { leads: number; emails: number; replies: number; positive: number; calls: number; meetings: number; won: number; failed: number }): string {
  return [
    `:sunrise: *Daily summary* (${md(name)}), last 24 hours`,
    `• ${a.leads} new leads, ${a.emails} emails sent, ${a.calls} calls`,
    `• ${a.replies} replies, ${a.positive} positive`,
    `• ${a.meetings} meetings booked, ${a.won} deals won`,
    a.failed ? `• :warning: ${a.failed} agent tasks failed. See the campaign task history.` : '',
  ].filter(Boolean).join('\n');
}

export async function monitorWorkspace(deps: Deps, ws: string, now = new Date()) {
  const { store, fetchImpl } = deps;
  const stats = { paused: 0, integration_alerts: 0, credit_alerts: 0, queue_alerts: 0, summary: false, held_sent: 0 };
  const settings = await store.monitorSettings(ws);
  const notifySettings = await store.notifySettings(ws);
  if (!settings || !notifySettings) return stats;
  const day = localDay(notifySettings.timezone, now);
  const link = (path: string, label: string) => (deps.appUrl ? ` <${deps.appUrl}/w/${ws}${path}|${label}>` : '');

  // 1. Delivery: pause emails before the sending domains are harmed
  for (const c of await store.deliveryRates(ws)) {
    const r = checkRates(c.sent, c.bounced, c.opted_out, settings.bounce_pct, settings.optout_pct);
    if (!r.pause || !r.reason) continue;
    if (!(await store.autoPauseEmails(ws, c.id, r.reason))) continue;
    stats.paused++;
    await notify(store, ws, {
      event: 'system_alert', severity: 'critical', campaignId: c.id, path: `/campaigns/${c.id}`, title: `Emails paused: ${c.name.slice(0, 90)}`,
      dedupe: `autopause:${c.id}:${day}`,
      slack: `:octagonal_sign: *Emails paused* (${md(c.name)}): ${r.reason}. Check the lead list and mailboxes, then turn emails back on.${link(`/campaigns/${c.id}`, 'Open campaign')}`,
    }, fetchImpl, now);
  }

  // 2. Integrations: broken connections and low credits
  for (const i of await store.integrationProblems(ws)) {
    if (i.status === 'error' || i.status === 'expired') {
      const r = await notify(store, ws, {
        event: 'system_alert', severity: 'warning', path: '/setup', title: `${toolName(i.tool)} needs attention`, dedupe: `integration:${i.tool}:${day}`,
        slack: `:warning: *${toolName(i.tool)} is not working*: ${md(i.last_error ?? (i.status === 'expired' ? 'the sign-in expired' : 'the last check failed'))}. Reconnect it in Setup.${link('/setup', 'Open Setup')}`,
      }, fetchImpl, now);
      if (r.status !== 'duplicate') stats.integration_alerts++;
    } else if (i.credits !== null && i.credits < settings.low_credits) {
      const r = await notify(store, ws, {
        event: 'system_alert', severity: 'warning', path: '/setup', title: `${toolName(i.tool)} credits are low`, dedupe: `credits:${i.tool}:${day}`,
        slack: `:battery: *${toolName(i.tool)} credits are low*: ${Math.floor(i.credits)} left. Top up so the agents keep working.${link('/setup', 'Open Setup')}`,
      }, fetchImpl, now);
      if (r.status !== 'duplicate') stats.credit_alerts++;
    }
  }

  // 3. Queue: tasks waiting far longer than the one-minute cycle
  const stuck = await store.stuckJobs(ws);
  if (stuck.n) {
    const hour = now.toISOString().slice(0, 13);
    const r = await notify(store, ws, {
      event: 'system_alert', severity: 'warning', path: '/campaigns', title: 'Agent tasks are waiting', dedupe: `queue:${hour}`,
      slack: `:hourglass: *Agent tasks are waiting*: ${stuck.n} ${stuck.n === 1 ? 'task has' : 'tasks have'} waited more than 15 minutes. The agent service may be down.`,
    }, fetchImpl, now);
    if (r.status !== 'duplicate') stats.queue_alerts++;
  }

  // 4. Daily summary, once a day from 8am local time
  if (localHour(notifySettings.timezone, now) >= SUMMARY_HOUR) {
    const a = await store.dailyActivity(ws);
    const quiet = Object.values(a).every((v) => !Number(v));
    const r = quiet ? { status: 'duplicate' as const } : await notify(store, ws, { event: 'daily_summary', path: '/analytics', title: 'Daily summary', dedupe: `daily:${day}`, slack: summaryText(settings.name, a) }, fetchImpl, now);
    stats.summary = r.status !== 'duplicate';
  }

  // 5. Alerts held during quiet hours
  stats.held_sent = await flushHeld(store, ws, notifySettings, fetchImpl, now);
  return stats;
}

/** Checks up to `limit` workspaces that are due. One workspace's problem never stops the others. */
export async function runMonitoring(deps: Deps, limit = 10, now = new Date()) {
  const ids = await deps.store.monitoringClaim(limit);
  let checked = 0;
  for (const ws of ids) {
    try {
      const s = await monitorWorkspace(deps, ws, now);
      checked++;
      if (s.paused || s.integration_alerts || s.credit_alerts || s.queue_alerts) log('info', 'monitoring raised alerts', { workspace_id: ws, ...s });
    } catch (err) {
      log('error', 'monitoring failed', { workspace_id: ws, error: err instanceof Error ? err.message : 'unknown' });
    }
  }
  return checked;
}
