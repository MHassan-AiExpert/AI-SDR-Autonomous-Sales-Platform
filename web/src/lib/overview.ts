// What the Overview puts first: the agents' status and what needs a person now.

/** The platform's agents (see the README's architecture diagram, M1 to M17). */
export const AGENT_COUNT = 17;

export type AttentionItem = { key: 'handoffs' | 'drafts' | 'warnings'; count: number; title: string; hint: string; href: string; action: string };

/** Cards for "Needs your attention"; anything with nothing waiting is left out. */
export function attentionItems(c: { handoffs: number; drafts: number; warnings: number }, base: string): AttentionItem[] {
  const all: AttentionItem[] = [
    { key: 'handoffs', count: c.handoffs, title: c.handoffs === 1 ? 'Conversation waiting for a person' : 'Conversations waiting for a person', hint: 'A lead asked for a human; reply quickly', href: `${base}/notifications?view=handoffs`, action: 'Take over' },
    { key: 'drafts', count: c.drafts, title: c.drafts === 1 ? 'Email to approve' : 'Emails to approve', hint: 'Written by your AI, ready to send', href: `${base}/campaigns`, action: 'Review' },
    { key: 'warnings', count: c.warnings, title: c.warnings === 1 ? 'Alert to check' : 'Alerts to check', hint: 'Warnings from your agents and tools', href: `${base}/notifications?view=attention`, action: 'Check' },
  ];
  return all.filter((i) => i.count > 0);
}

/** The one-line status under the greeting. */
export function agentStatus(paused: boolean): string {
  return paused ? 'Outreach is paused: agents are not sending anything' : `All ${AGENT_COUNT} AI agents are working`;
}

/** "Good morning" / "Good afternoon" / "Good evening" for an hour of the day. */
export function greeting(hour: number): string {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** A time zone the runtime knows, or UTC. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC' });
    return timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The hour in a time zone, falling back to UTC for a missing or unknown zone. */
export function hourIn(timeZone: string | null | undefined, at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: safeTimeZone(timeZone) }).format(at));
}
