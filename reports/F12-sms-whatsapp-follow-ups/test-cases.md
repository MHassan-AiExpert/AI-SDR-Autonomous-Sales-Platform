# F12 — SMS and WhatsApp Follow-ups: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/texting.test.mjs`) | `npm run test:db` | **4 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-25) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/texting.test.ts`) | `cd agents && npm test` | **17 passed, 0 failed** |
| Web unit (`web/tests/texting.test.ts`) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (Texts page added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 149, agents 178, web 83 | **410 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TX-01 | Defaults; valid number, Messaging Service and template; invalid channel, number, template, texts per lead and delay | SMS, not started, 3 days, 100 per day, 1 per lead; valid values saved; all invalid values rejected | Pass |
| TX-02 | Same Twilio message twice; invalid message id; unknown status; `read` status | Stored once; rejected; rejected; accepted | Pass |
| TX-03 | Rep logs a manual text; rep creates a fake Twilio record; admin edits a Twilio record; rep turns a manual note into a Twilio record; rep edits their manual note | Allowed; refused; refused; refused; allowed | Pass |
| TX-04 | Daily schedule for a live text campaign; again after 61 minutes; kill switch; paused campaign | One job, then another an hour later; not claimed while paused; no job for a paused campaign | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-25 | Twilio text events workflow | Webhook at `twilio/:token` with the raw body, empty TwiML response, forwards the X-Twilio-Signature signed to `/webhooks/twilio`; five workflows with unique ids | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TC-01 | Consent and number rules for SMS and WhatsApp | Only with consent for that channel; SMS only to mobiles; WhatsApp allowed on a landline with consent; suppressed and badly formatted numbers refused | Pass |
| TC-02 | STOP, "stop.", Unsubscribe, opt out, STOPALL, quit!, Cancel; sentences that contain those words; START | Keywords recognised only as the whole message | Pass |
| TC-03 | SMS wording; no sender name; links and line breaks; long lines; standard line | Sender named and opt-out line always added; links and breaks removed; at most 220 characters | Pass |
| TC-04 | Twilio request for a number, a Messaging Service and WhatsApp | From or MessagingServiceSid; whatsapp: prefixes; ContentSid and variables; status address | Pass |
| TC-05 | Twilio signature: matches an independent calculation; changed field; other address; other token; empty | Only the genuine signature passes | Pass |
| TC-06 | Twilio 400 with code 21610; 401 | Code kept, readable reason, Twilio's text not passed on; credentials rejected | Pass |
| TJ-01 | Six leads: due with consent; emailed yesterday; no consent; landline; never contacted; already replied | Only the first texted, with the sender, the AI's line and STOP; company Twilio account used; reasons counted; step and consent basis stored; timeline entry | Pass |
| TJ-02 | Run again straight away | Nobody texted again | Pass |
| TJ-03 | Delivery update with a bad Twilio signature; valid; a later "sent"; another account | 401; delivered; stays delivered; ignored | Pass |
| TJ-04 | Prospect texts a question | Stored as a received text; reply agent classifies it; lead Engaged; answer approved in autopilot and sent by SMS; Slack "Question by text" | Pass |
| TJ-05 | Same text again; text from an unknown number | Duplicate; ignored | Pass |
| TJ-06 | Prospect texts STOP | Phone and email suppressed; Do not contact; unsubscribe reply recorded; never texted afterwards | Pass |
| TJ-07 | Twilio refuses with 21610 | Text failed with the reason and code; lead suppressed | Pass |
| TJ-08 | SMS switched off; no contact days | Clear notes; nothing sent | Pass |
| TJ-09 | WhatsApp campaign | Template with name and line; whatsapp: numbers; template stored on the text | Pass |
| TJ-10 | Twilio rejects the account | Run failed with "Twilio rejected the stored credentials"; Twilio flagged in Setup | Pass |
| TJ-11 | All stored texts, events and job results | No auth token and no webhook token | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TW-01 | Valid SMS, Messaging Service and WhatsApp settings | Parsed; empty fields saved as empty | Pass |
| TW-02 | SMS without a sender; WhatsApp without a template; unknown channel | One clear message each | Pass |
| TW-03 | Bad number, template id, delay, daily limit, texts per lead | One clear message each | Pass |
| TW-04 | Launch checklist for SMS and WhatsApp with items missing | Not ready; lists exactly what is missing | Pass |
| TW-05 | Labels, Twilio address, text run results | All present; address built only from a valid token; readable lines | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-25 | Job type and provider extended; 8 campaign and 10 message columns; guard trigger; claim holds texts under the kill switch; hourly text schedule | Pass |
| LIVE-26 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-48 | Connect Twilio; set your number as the SMS sender; paste the Twilio address into the number; record SMS consent on a test lead with your own mobile that was emailed more than 3 days ago; Text now | You receive the follow-up with the sender's name and "Reply STOP to opt out." |
| ACC-49 | Reply "How much is it?" | Reply in the Inbox as SMS with a drafted answer; in autopilot you receive the answer |
| ACC-50 | Reply STOP | Lead Do not contact; number and email suppressed |
| ACC-51 | Switch the campaign to WhatsApp with an approved template and repeat ACC-48 with WhatsApp consent | You receive the template on WhatsApp |
