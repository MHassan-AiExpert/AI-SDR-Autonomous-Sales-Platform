# F09 — Reply Handling: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/replies.test.mjs`) | `npm run test:db` | **6 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-22) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/replies.test.ts`) | `cd agents && npm test` | **15 passed, 0 failed** |
| Web unit (`web/tests/replies.test.ts`, WEB-25) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (inbox added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 132, agents 133, web 71 | **336 passed, 0 failed**; agent suite run 3 times in a row with no failures |

A defect found by WH-04 was fixed before release: on a bounce with no email marked sent yet, the last step was marked bounced instead of the first.

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| REP-01 | New workspaces | Each has a different 64-character token | Pass |
| REP-02 | Admin rotates; rep and another company try | New token stored; others refused | Pass |
| REP-03 | Same event twice | Stored once | Pass |
| REP-04 | Admin, rep and another company read events; owner inserts one | Admin sees it; others none; insert refused | Pass |
| REP-05 | Conversation link to another site; Slack channel formats | Rejected; `#sales-alerts` and channel IDs accepted, free text rejected | Pass |
| REP-06 | Rep marks a reply handled; backend cancels an email | Both allowed | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-22 | Instantly events workflow | POST webhook at `instantly/:token`, answers on receipt, signs token and event with the shared secret, forwards to the agent service, active, successful runs not stored | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RPL-01 | Opt-out, out-of-office and normal wording | Six opt-out phrasings and two absences caught; three normal replies left for the AI | Pass |
| RPL-02 | Nine stage transitions | Never backwards; opt-out always wins; won stays won; not interested returns only on interest | Pass |
| RPL-03 | AI says interested with a link in the answer; AI says negative | Link removed; no answer for a no; reply wrapped as data | Pass |
| RPL-04 | "Interesting, but please remove me"; no language model | Unsubscribe without calling the AI; question for a person | Pass |
| RPL-05 | Slack channel not found; token invalid; text with mentions | Clear messages; 401 for the token; mentions escaped | Pass |
| RPL-06 | Same delivery with different email case; different event | Same key; different key | Pass |
| WH-01 | Signed event delivered twice | Stored once without HTML copies; reply agent queued | Pass |
| WH-02 | Unknown token, malformed token, bad signature, unknown campaign | 404, 404, 401, ignored | Pass |
| WH-03 | Request produced by the n8n workflow's own code | Accepted | Pass |
| WH-04 | Six events: interested, objection (with a phishing link), opt-out, out-of-office, bounce, meeting label | Stages, email statuses, suppressions and replies exactly as designed; phishing link dropped; one Slack message containing only the hot reply with its link; counts in the result | Pass (after fix) |
| WH-05 | Event statuses and timeline | 7 processed, 2 ignored; "Email 1 sent" then the reply | Pass |
| WH-06 | Not-now reply; Slack channel missing | Follow-up in 30 days, no answer; job succeeds and reports the Slack reason | Pass |
| WH-07 | Reply from an address not in the workspace | Ignored | Pass |
| WH-08 | Kill switch on | Inbound events still processed | Pass |
| WH-09 | All stored data | No credential and no webhook token | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RIN-01 | Inbox filters | Defaults to replies to handle; unknown and injected values ignored | Pass |
| RIN-02 | Conversation links | Only https Instantly links shown | Pass |
| RIN-03 | Labels and colours | Every type covered | Pass |
| RIN-04 | Reply agent results | One readable line, including a Slack failure | Pass |
| WEB-25 | Slack channel setting | Name lower-cased, ID kept, empty means none, invalid rejected | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-19 | Job type and email status extended; token and channel columns; `inbound_events` with row-level security and no client insert; 7 reply columns; rotate function callable by signed-in users only | Pass (inside a rolled-back block) |
| LIVE-20 | Security advisor | One new notice, for `workspace_rotate_webhook_token`: intended, it checks the owner or admin role itself, like the F03 and F04 functions | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-36 | Add the webhook address in Instantly; reply "Interested, call me Tuesday" to a test email | Inbox shows Interested with a suggested answer; Slack shows the alert |
| ACC-37 | Reply "please remove me" | Lead becomes Do not contact and appears in suppressions |
| ACC-38 | Send to an address that does not exist | Lead's email marked invalid and suppressed after the bounce |
| ACC-39 | Rotate the webhook address and send a test event to the old one | Nothing recorded; the new address works |
