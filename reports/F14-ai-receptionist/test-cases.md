# F14 — Inbound AI Receptionist: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/receptionist.test.mjs`) | `npm run test:db` | **3 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-24 updated) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/receptionist.test.ts`) | `cd agents && npm test` | **12 passed, 0 failed** |
| Web unit (`web/tests/receptionist.test.ts`) | `cd web && npm test` | **4 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 158, agents 206, web 92 | **456 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RC-01 | Default status; valid settings; invalid status, number id, team number, long notes | Off; saved; all invalid values rejected | Pass |
| RC-02 | Second campaign for the same number in one workspace; same number in another workspace | Rejected; allowed | Pass |
| RC-03 | Answered, put through and spam outcomes; unknown outcome | Accepted; rejected | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-24 | Vapi call events workflow | Signed forward to `/webhooks/vapi`, the agent's answer returned to Vapi (last node, first entry), within 7.5 seconds | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RR-01 | Greeting and prompt | AI disclosure; known callers asked to confirm; notes and prices from the company; contact details never shared; transfer or message rule; text only with agreement; no card details | Pass |
| RR-02 | "Don't call me" with a meeting outcome; forwarded call; call back; unknown outcome with speech; silence | Do not call; put through; call back; question answered; no conversation | Pass |
| RJ-01 | Assistant request for the number from a known caller; unknown number; receptionist off with and without a team number | Receptionist with greeting, notes, transfer tool and results address; not set up; put through; unavailable | Pass |
| RJ-02 | New caller wants a meeting and agrees to a text | Call confirmed with Vapi using the company key; new lead (name, cleaned email, Interested, Inbound call, campaign); SMS consent from the call; call stored with length and recording; booking link texted with STOP; Slack | Pass |
| RJ-03 | Same report again | Duplicate; no second call record or text | Pass |
| RJ-04 | Report unknown to Vapi; for another number; for an outbound call | All ignored; no leads | Pass |
| RJ-05 | Known caller asks for a call back on a date | Same lead; Interested; call consent from the call; call-back task at that time | Pass |
| RJ-06 | Wants a meeting, did not agree to a text | No text; no SMS consent; task "Send a booking link" | Pass |
| RJ-07 | Spam; silent call from unknown numbers | Not added as leads | Pass |
| RJ-08 | "Stop calling me, don't call me again" | Number suppressed; Do not contact | Pass |
| RJ-09 | Kill switch on | Still answered; no text; task "outreach is paused" | Pass |
| RJ-10 | All stored calls, leads, events and texts | No Vapi key, Twilio token, Calendly token or webhook token | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RW-01 | Valid settings; empty optional fields | Parsed; saved as empty | Pass |
| RW-02 | Bad assistant id, number id, team number, long notes | One clear message each | Pass |
| RW-03 | Checklist | Required and optional items; booking by text needs Calendly and an SMS sender | Pass |
| RW-04 | Vapi server address; outcome labels | Built only from a valid token; labels present | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-29 | 5 campaign columns; one campaign per number; new call outcomes | Pass |
| LIVE-30 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-56 | Set up the receptionist and call the number from your phone | "Thanks for calling ... This is the AI assistant" |
| ACC-57 | Ask for a meeting and agree to a text | A booking link arrives by SMS; you appear as a new lead with the recording |
| ACC-58 | Ask for a person | The call is put through to the team number |
| ACC-59 | Switch the receptionist off and call again | The call goes straight to the team number |
