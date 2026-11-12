// Reply inbox labels and filters.

export const REPLY_CLASSES = ['interested', 'question', 'objection', 'not_now', 'referral', 'out_of_office', 'wrong_person', 'unsubscribe', 'negative'] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const REPLY_LABELS: Record<ReplyClass, string> = {
  interested: 'Interested', question: 'Question', objection: 'Objection', not_now: 'Not now', referral: 'Referral',
  out_of_office: 'Out of office', wrong_person: 'Wrong person', unsubscribe: 'Unsubscribed', negative: 'Not interested',
};

/** Replies a person should answer, most urgent first. */
export const NEEDS_ANSWER: ReplyClass[] = ['interested', 'question', 'referral', 'objection'];

export function replyBadge(c: string | null): 'ok' | 'warn' | 'error' | '' {
  if (c === 'interested' || c === 'referral') return 'ok';
  if (c === 'question' || c === 'objection' || c === 'not_now') return 'warn';
  if (c === 'unsubscribe' || c === 'negative') return 'error';
  return '';
}

export type InboxFilter = { view: 'open' | 'handled' | 'all'; kind: ReplyClass | 'needs_answer' | null };

export function parseInboxFilter(params: Record<string, string | string[] | undefined>): InboxFilter {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const view = one(params.view);
  const kind = one(params.kind);
  return {
    view: view === 'handled' || view === 'all' ? view : 'open',
    kind: kind === 'needs_answer' ? 'needs_answer' : (REPLY_CLASSES as readonly string[]).includes(kind) ? (kind as ReplyClass) : null,
  };
}

/** Only links to the sending service's own conversation view are shown. */
export function safeConversationUrl(url: string | null): string | null {
  return url && /^https:\/\/([a-z0-9-]+\.)*instantly\.ai\//.test(url) ? url : null;
}
