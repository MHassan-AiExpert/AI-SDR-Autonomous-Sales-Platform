# F19 — Monitoring, Alerts and Notifications: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/notifications.test.mjs`) | `npm run test:db` | **8 passed, 0 failed** |
| Agent (`agents/tests/monitoring.test.ts`, `agents/tests/server.test.ts` SRV-07) | `cd agents && npm test` | **17 passed, 0 failed** |
| Web unit (`web/tests/notifications.test.ts`) | `cd web && npm test` | **4 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** (Notifications page and its handoff view added to E2E-03: both ask signed-out visitors to sign in) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 184, agents 260, web 111 | **555 passed, 0 failed**. All earlier Slack alert tests pass unchanged through the new notifier |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| NF-01 | Defaults; unknown event; half-set or equal quiet hours; unsafe time zone; zero bounce limit | 11 events, no quiet hours, UTC, 5%, 3%, 100; each bad value rejected | Pass |
| NF-02 | Viewer, other workspace, owner trying to insert, edit or delete | Viewer reads; other workspace sees nothing; writes denied | Pass |
| NF-03 | Same key twice; link outside the workspace; unknown event; non-https join link | Duplicate refused; each check refuses | Pass |
| NF-04 | Viewer, other workspace, rep accepting in someone else's name, rep, admin after the rep, accepting a non-handoff | Nothing; nothing; refused; accepted by the rep; nothing; nothing | Pass |
| NF-05 | A rep's own last-seen time; setting it for someone else; another workspace's owner | Saved; refused; refused; admins do not see others' rows | Pass |
| NF-06 | Retry with a wait, then two more attempts; members calling the retry function | Queued with the error and a wait; not claimed early; third attempt cannot retry; permission denied | Pass |
| NF-07 | Monitor claims | Both workspaces, then none, then only the one due again; members denied | Pass |
| NF-08 | Automatic pause reason | Saved; over 300 characters refused | Pass |

## Agent

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| NT-01 | Slack text to in-app text | Emoji, bold and link markup removed, escapes undone | Pass |
| NT-02 | Quiet hours and time zones | Overnight and daytime ranges; Karachi hour and day; unknown zone falls back to UTC | Pass |
| NT-03 | Pause decision | Under 50 emails never; 4.5% no; 5.0% bounce yes with the exact reason; 3.0% opt-out yes | Pass |
| NT-04 | What is retried | Unreachable, 503 and 429 yes; 401, 400 and settings errors no | Pass |
| NT-05 | Daily summary text | Exact text, with a warning line for failed tasks | Pass |
| MN-01 | Same alert twice | Posted to Slack once, kept once in the app with plain text and a link | Pass |
| MN-02 | Event switched off for Slack | Kept in the app; no Slack call | Pass |
| MN-03 | Quiet hours | Normal alert held; critical alert sent at once; still held at night; posted at 08:05 marked as held | Pass |
| MN-04 | Slack channel missing | Recorded as failed with a clear message; no exception | Pass |
| MN-05 | 6 of 60 emails bounced | Emails paused with the exact reason; Instantly pause queued; critical Slack alert with a campaign link; not repeated on the next check | Pass |
| MN-06 | A broken tool and a tool low on credits | One alert each with a Setup link; none repeated the same day | Pass |
| MN-07 | A task waiting 20 minutes | "Agent tasks are waiting" alert | Pass |
| MN-08 | Daily summary | Not before 8am local; sent at 9am with the day's figures; not sent again that day | Pass |
| MN-09 | Monitor sweep | Two workspaces checked, then none within 15 minutes | Pass |
| MN-10 | A model provider down on every attempt | Retried after a wait (not claimed early), retried again, then failed after 3 attempts; one "Campaign planning failed" alert linked to the campaign | Pass |
| MN-11 | Readiness counts | A task waiting 30 minutes counts as stuck | Pass |
| SRV-07 | `/ready` | 200 with counts; 503 "queue backlog"; 503 when the database is down | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WNF-01 | Settings form | Chosen events, quiet hours, time zone and limits saved; no events and no quiet hours allowed | Pass |
| WNF-02 | Bad input | Clear messages for half-set and equal quiet hours, an unknown time zone, limits out of range and a negative credit level; real zones accepted | Pass |
| WNF-03 | Links | Only this workspace's paths and https join links | Pass |
| WNF-04 | New count | Only notifications after the last visit | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-39 | Row security on both new tables; no visitor access; members cannot insert or edit the title but can set acceptance; members cannot run the retry or monitor functions; 8 new workspace columns; the claim function waits for retries | Pass |
| LIVE-40 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-73 | Book a test meeting; open Notifications | The alert is in Slack and in the app with a new count; the count clears after viewing |
| ACC-74 | Make the closer hand off a meeting; take it as a rep | "Taken by you"; the lead is assigned to the rep; Join meeting opens the meeting |
| ACC-75 | Set quiet hours covering now; trigger a reply alert | Held, then posted when quiet hours end |
| ACC-76 | Lower the bounce limit below a campaign's current rate | Emails and the Instantly campaign pause within 15 minutes; critical alert; Resume clears the notice |
| ACC-77 | Point an uptime monitor at `/ready` | 200 while the queue moves |
