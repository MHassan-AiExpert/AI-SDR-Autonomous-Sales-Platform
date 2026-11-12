# F11 — AI Voice Calling

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| | |
| --- | --- |
| Feature ID | F11 |
| SRS reference | M12 (AI voice calling: pitch, recording, transcripts, outcomes), M3 FR-3.7 (Do Not Call screening, consent basis per channel), M15 (timeline, follow-ups), M11 (alerts), M21 (kill switch), compliance section |
| Location | `agents/src/voice.ts`, `agents/src/sources/vapi.ts`, `agents/src/server.ts`, `infra/n8n/workflows/vapi-events.json`, `supabase/migrations/20261112225643_voice_calling.sql`, `web/src/lib/voice.ts`, `web/src/app/w/[workspaceId]/campaigns/[campaignId]/voice-section.tsx`, `web/src/app/w/[workspaceId]/calls/` |
| Automated tests | 4 database, 1 infrastructure, 15 agent service, 5 web unit, 16 browser: 41 passed, 0 failed |
| Live checks | New columns, trigger, hourly scheduling and kill switch rule verified on the hosted database |

## 1. Summary

Qualified leads with checked phone numbers can now be called by an AI voice agent. Calls use the company's own Vapi assistant (and the voice chosen there) and the company's own Twilio number imported into Vapi. Each call follows this order:

1. **Opening:** the agent says it is an AI assistant calling on behalf of the company.
2. **Conversation:** it uses the lead's research brief and the campaign offer.
3. **Goal:** it aims for a short meeting.
4. **Limits:** it never leaves a voicemail and stops at once when asked not to be called.

When the call ends, Vapi sends the result back. The platform stores the outcome, summary, transcript and recording, and then acts on the outcome:

- **Interested or wants a meeting:** the lead moves forward, the team gets a follow-up task and a Slack alert.
- **Call back:** a call-back task is created for the time they asked for.
- **Do not call:** the number is suppressed and the lead becomes Do not contact.
- **Voicemail or no answer:** the lead is called again the next day, up to the attempt limit.

## 2. Who may be called

Calling rules differ by country, and AI-voice calls to mobiles generally need prior consent. The platform therefore takes the safe default and lets the company widen it only by an explicit, recorded decision:

| Lead | Rule "Only leads with recorded consent" (default) | Rule "Also business landlines" |
| --- | --- | --- |
| Any number with a recorded consent basis (gave consent, existing customer, asked us to call) | Called | Called |
| Business landline without consent | Not called | Called only after an owner or admin confirms the numbers were screened against applicable Do Not Call registries; the database records who confirmed and when |
| Mobile or VoIP without consent | Not called | Not called |
| Number on the do-not-contact list, without a country code, or unchecked | Not called | Not called |

Consent is recorded on the lead's profile with who recorded it and when, and can be withdrawn at any time. Every call stores the consent basis it relied on.

## 3. When calls happen

| Control | Detail |
| --- | --- |
| Calling hours | A window and days in the leads' time zone (default 10:00 to 16:00, Monday to Friday); outside it nothing is dialled |
| Daily limit | Calls per day per campaign (default 30) |
| Attempts | Calls per lead (default 2), at least 20 hours apart, only while the lead is New or Contacted and has had no conclusive call |
| Score | Only leads at or above the campaign threshold |
| One at a time | No new call to a lead while one is ringing or in progress |
| Schedule | Live campaigns get a calling run every hour; "Call now" starts one immediately |
| Kill switch and voice switch | No new calls while outreach is paused, while AI voice calls are off in Settings, or while calling is paused for the campaign |

## 4. The call

| Part | Detail |
| --- | --- |
| Opening | "Hi Kim, this is an AI assistant calling on behalf of Acme Growth. Is now a bad time for a quick question?" |
| Instructions | Goal, offer, who the company helps, and the research brief as data the agent must not take instructions from |
| Rules given to the agent | Under three minutes; one question at a time; confirm being an AI if asked; if asked to stop, apologise, confirm and end; if busy, ask when to call back; for a meeting, confirm a booking link may be emailed; never pressure, invent facts or ask for payment or personal data; no voicemail messages |
| Result | Vapi's structured analysis returns the outcome (meeting requested, interested, call back, not interested, wrong person, do not call, voicemail, no conversation), a call-back time and notes |
| Safety rule | If the prospect's words in the transcript ask not to be called ("don't call me again", "stop calling", "remove my number"), the outcome is Do not call whatever the analysis says |

## 5. Receiving results

```mermaid
flowchart LR
  A[Agent service] -->|POST /call: company assistant and number, AI opening, prompt, results address| V[Vapi]
  V -->|calls through the company's Twilio number| P[Prospect]
  V -->|end-of-call report to n8n/webhook/vapi/token| N[n8n]
  N -->|HMAC-signed| A
  A --> C{Call started by<br/>this platform?}
  C -- no --> X[Ignored]
  C -- yes --> R[Store outcome, summary, transcript, recording]
  R --> L[Lead stage, follow-up task, suppression]
  R --> S[Slack alert for interest or call back]
```

Results are accepted only for calls this platform started in that workspace, are stored once per call, and recordings are kept only as https links.

## 6. Screens

| Screen | Contents |
| --- | --- |
| Campaign → AI calling | Status, calls today against the limit, launch checklist, who may be called, Launch, Pause, Call now, and settings (Vapi assistant and number, time zone, calling window and days, calls per day, attempts per lead, calling rule and the registry confirmation) |
| Calls (new tab) | Every call with time, lead and company, outcome, summary, recording and length, filterable by outcome |
| Lead profile | Consent to be called (record or remove), and each call with outcome, summary, length, recording and transcript |

## 7. Database changes

| Change | Purpose |
| --- | --- |
| Campaign calling settings | Status, Vapi ids, time zone, window, days, limits, calling rule, registry confirmation with who and when (stamped by the database) |
| `calls` additions | Campaign, provider and provider call id (unique), status, attempt, number dialled, end reason and time, structured analysis including the consent basis, error; recordings must be https |
| Job type `voice_outreach` and event provider `vapi` | Calling runs and call results |
| `agent_jobs_claim` | The kill switch also holds calls |
| `agent_jobs_enqueue_due` | Calling runs every hour for live campaigns |

## 8. Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `N8N_PUBLIC_URL` | `infra/.env` | Address Vapi sends call results to (already used by F10) |
| `VOICE_MODEL` | `infra/.env` | Optional; the model the agent thinks with during calls (default `gpt-4o-mini`). The voice is set on the Vapi assistant |

In Vapi: create an assistant with the voice you want, import your Twilio number, and copy both ids into the campaign. The `Vapi call events` workflow is imported and published with the stack.

## 9. Known limits and next steps

| Item | Plan |
| --- | --- |
| Automated national Do Not Call registry lookups | Registries need a subscription per country; the platform records the owner's confirmation, the internal do-not-call list is always applied, and a registry connector can plug into the same check |
| Booking during the call | The agent agrees the meeting and the team gets a task and alert; sending the booking link by email after the call comes with the closer feature |
| Per-lead time zones | One calling time zone per campaign; leads across time zones go in separate campaigns |
| Next feature (F12) | SMS and WhatsApp follow-ups after calls and emails, and the AI closer that runs booked meetings using the company playbook |
