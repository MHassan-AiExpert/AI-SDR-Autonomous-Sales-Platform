# F10 — Answers and Booking: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/booking.test.mjs`) | `npm run test:db` | **6 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-23) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/booking.test.ts`) | `cd agents && npm test` | **13 passed, 0 failed** |
| Web unit (`web/tests/replies.test.ts`, RIN-05 and 06) | `cd web && npm test` | **2 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (meetings added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 139, agents 146, web 73 | **358 passed, 0 failed**; agent suite run 3 times in a row with no failures |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| BK-01 | Rep edits and approves an answer | Approver recorded; sender job queued by trigger | Pass |
| BK-02 | Owner marks an answer sent; edits the prospect's text or classification; edits a sent answer | All refused | Pass |
| BK-03 | Approve an empty answer; viewer approves | Refused; no rows changed | Pass |
| BK-04 | Owner and admin read Calendly subscriptions | Permission denied | Pass |
| BK-05 | Same Calendly booking twice; cancel link to another site; non-Calendly event type | Stored once; both rejected; valid event type accepted | Pass |
| BK-06 | Kill switch with an answer job queued | Not claimed while paused; claimed after resume | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-23 | Calendly events workflow | Webhook at `calendly/:token` with raw body, reads the binary body, forwards it with the Calendly signature header, signed with the shared secret; agent service gets `WEBHOOK_BASE_URL` | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| BKU-01 | Calendly signature: valid, changed body, wrong key, 10 minutes old, malformed, missing | Only the first accepted | Pass |
| BKU-02 | Tracked link, answer HTML with a Calendly link and another link, subject prefixes | Lead id added; only the Calendly link clickable; text escaped; footer added; "Re:" normalised | Pass |
| BKJ-01 | Interested reply at 95% in autopilot | Booking link made and added; answer approved and sent in the thread with mailbox, email id, "Re: idea", HTML link and footer | Pass |
| BKJ-02 | First and second booking link in a workspace | Webhook registered once, with the right address, events, scope and a 64-character key; second answer also sent | Pass |
| BKJ-03 | Objection at 95%; interested at 60% | Both left as drafts; nothing sent | Pass |
| BKJ-04 | Rep edits and approves the objection answer | Edited text sent | Pass |
| BKJ-05 | Approval mode; lead suppressed after approval | Not sent; "The lead asked not to be contacted" | Pass |
| BKJ-06 | Kill switch on, answer approved | Held; sent after resume | Pass |
| BKJ-07 | Instantly answers 500, then approve again | "Not sent" with the reason, then sent | Pass |
| BKJ-08 | Signed booking from the tracked link with another email; repeat; cancellation | Meeting with join link, AI closer, invitee and campaign; lead Meeting booked; Slack message; repeat is a duplicate; cancel marks it cancelled and lead back to Interested | Pass |
| BKJ-09 | Wrong Calendly key, malformed signature, unknown workspace | 401, 401, 404; nothing stored | Pass |
| BKJ-10 | Calendly disconnected | Answer drafted without a link | Pass |
| BKJ-11 | All stored data | No credential and no signing key | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RIN-05 | Answer labels; meeting links; event type addresses | Every state labelled; only https links; only Calendly event type addresses | Pass |
| RIN-06 | Answer sending results | One readable line each, including a paused note | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-21 | Job type and event provider extended; 8 reply columns; guard and send triggers; 2 campaign columns; Calendly table with row-level security and no signed-in access; 10 meeting columns; booked via Calendly; claim holds answers under the kill switch | Pass (inside a rolled-back block) |
| LIVE-22 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-40 | Connect Calendly (paid plan), set `N8N_PUBLIC_URL`, reply "interested" to a test email | Inbox shows an answer with a calendly.com link; in autopilot it arrives in the same email thread |
| ACC-41 | Book a time with the link | Meetings shows it with the Zoom link; lead is Meeting booked; Slack alert |
| ACC-42 | Cancel the booking in Calendly | Meeting Cancelled; lead back to Interested |
| ACC-43 | Approval mode: edit an answer and approve | The edited answer arrives in the thread |
