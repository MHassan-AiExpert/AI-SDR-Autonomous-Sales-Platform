# F11 — AI Voice Calling: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/voice.test.mjs`) | `npm run test:db` | **4 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-24) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/voice.test.ts`) | `cd agents && npm test` | **15 passed, 0 failed** |
| Web unit (`web/tests/voice.test.ts`) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (calls page added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 144, agents 161, web 78 | **383 passed, 0 failed**; agent suite run 3 times in a row with no failures |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VO-01 | Defaults; invalid rule, attempts, assistant id, window | Consent only, 10:00 to 16:00, 30 per day, 2 attempts; all invalid values rejected | Pass |
| VO-02 | Admin confirms registry screening with a fake date; then clears it | Database sets the time and the admin's id; clearing removes both | Pass |
| VO-03 | Same provider call twice; http recording | Stored once; rejected | Pass |
| VO-04 | Daily schedule for a live voice campaign; again after 61 minutes; kill switch | One job, then another an hour later; not claimed while paused | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-24 | Vapi call events workflow | Webhook at `vapi/:token`, signed forward to `/webhooks/vapi`; four workflows with unique ids | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VC-01 | Calling window: inside, before opening, other time zone, Saturday, invalid zone | Only the first is open | Pass |
| VC-02 | Mobile with consent; mobile without; landline with and without confirmation; landline under consent-only; suppressed; no country code | Called only with consent, or as a confirmed business landline | Pass |
| VC-03 | "Don't call me again" while the analysis says interested; "stop calling"; voicemail; no answer; meeting requested; pipeline error; wrong person | Do not call twice; then voicemail, no answer, interested with meeting, failed, wrong number | Pass |
| VC-04 | Opening line and instructions | AI disclosure first; rules for honesty, opt-out and voicemail; research wrapped as data | Pass |
| VC-05 | Call request | Company assistant and number, customer, results only for end-of-call and status, structured analysis plan, system prompt | Pass |
| VJ-01 | Six leads: consented mobile, landline (confirmed), mobile without consent, low score, unchecked number, suppressed | Only the first two called, with the AI opening, results address and company key; reasons counted; consent basis stored on the call | Pass |
| VJ-02 | Run again while calls are ringing | Nobody called twice | Pass |
| VJ-03 | Meeting requested result; same report again | Call ended with outcome, 150 s, https recording, summary and transcript; lead Interested; task; timeline "AI call: wants a meeting (2.5 min)…"; duplicate ignored | Pass |
| VJ-04 | Transcript says "please don't call me again", analysis says not interested | Do not call; number suppressed; lead Do not contact | Pass |
| VJ-05 | Voicemail, then a run soon after, then after 21 hours, then after the second attempt | Not called soon; called after 21 hours; not called after 2 attempts | Pass |
| VJ-06 | Call back in three days | Voice task at that exact time; lead Engaged | Pass |
| VJ-07 | Result for a call the platform did not start; unknown workspace | Ignored; 404 | Pass |
| VJ-08 | No calling days; calling paused | Clear notes; no calls | Pass |
| VJ-09 | Vapi rejects the key | Run failed; call failed; Vapi flagged in Setup | Pass |
| VJ-10 | All stored data | No credential and no webhook token | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VW-01 | Valid calling settings | Parsed with days and limits | Pass |
| VW-02 | Business landlines without and with the confirmation; unknown rule | Refused, accepted, refused | Pass |
| VW-03 | Bad ids, window, days, attempts, time zone | One clear message each | Pass |
| VW-04 | Launch checklist with each item missing | Not ready | Pass |
| VW-05 | Labels, recording links, calling run results | All present; only https links; readable lines | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-23 | Job type and provider extended; 12 campaign and 10 call columns; confirmation trigger; claim holds calls under the kill switch; hourly calling schedule | Pass (inside a rolled-back block) |
| LIVE-24 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-44 | Create a Vapi assistant and import a Twilio number; record consent on a test lead with your own mobile; launch calling with a window covering now | Your phone rings; the agent says it is an AI assistant for your company |
| ACC-45 | Ask for a meeting on the call | Call shows Interested with summary, transcript and recording; Slack alert; task created |
| ACC-46 | On a second test call say "please don't call me again" | Number suppressed; lead Do not contact; never called again |
| ACC-47 | Press the kill switch, then Call now | No call is placed |
