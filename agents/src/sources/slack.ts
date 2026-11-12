// Team alerts in the company's own Slack workspace.

import { requestJson, isObject, ProviderError, type Fetch } from '../http.ts';

export async function postSlack(token: string, channel: string, text: string, fetchImpl?: Fetch): Promise<void> {
  const body = await requestJson('Slack', 'https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  }, { fetchImpl, timeoutMs: 15_000 });
  if (!isObject(body) || body.ok !== true) {
    const code = isObject(body) && typeof body.error === 'string' ? body.error : 'unknown_error';
    const auth = ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(code);
    throw new ProviderError('Slack', auth ? 401 : 400,
      auth ? 'Slack rejected the stored credentials'
        : code === 'channel_not_found' || code === 'not_in_channel' ? 'Add the Slack app to the alert channel, or check the channel name in Settings'
          : `Slack could not post the alert (${code.replace(/[^a-z_]/g, '').slice(0, 40)})`);
  }
}

/** Slack mrkdwn needs &, < and > escaped in user-provided text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
