# F08 — Email Outreach: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/outreach.test.mjs`) | `npm run test:db` | **8 passed, 0 failed** (ENR-01 to 03 updated for the copywriting schedule) |
| Agent service (`agents/tests/outreach.test.ts`) | `cd agents && npm test` | **18 passed, 0 failed** |
| Web unit (`web/tests/outreach.test.ts`) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (email review page added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 125, agents 118, web 66 | **309 passed, 0 failed**; agent suite run 3 times in a row with no failures |

A defect found by OUT-W01 was fixed before release: sending mailboxes were de-duplicated before being lower-cased, so `Sam@…` and `sam@…` were both kept.

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| OUT-01 | Rep edits and approves a draft, then rejects it | Saved; approver and time recorded; cleared on rejection | Pass |
| OUT-02 | Owner sets an email to queued or sent; edits a queued email | All refused with clear messages | Pass |
| OUT-03 | Owner changes step, provider id or idempotency key; empties the subject | Refused | Pass |
| OUT-04 | Viewer and another company approve; backend queues | No rows changed; backend succeeds | Pass |
| OUT-05 | Bad sending window, limit 0, 5 follow-ups, accounts not a list, unknown outreach status; defaults | All rejected; defaults not started, 50, 2, weekdays | Pass |
| OUT-06 | Kill switch on; email channel off; campaign outreach paused; renamed campaign; campaign without Instantly | Sync queued for the first three; none for a rename or a campaign never sent | Pass |
| OUT-07 | Kill switch on with a sync and a copywriting job queued | Only the sync is claimed | Pass |
| OUT-08 | Daily schedule with live and not-started outreach | Sending queued only for live; copywriting for both | Pass |

## Agent service: copy checks and Instantly mapping

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CPY-01 | Clean sequence with messy whitespace | Accepted and tidied | Pass |
| CPY-02 | Link, www link, [placeholder], {{placeholder}}, HTML, unsubscribe text, capitals, exclamation, too short, too long, wrong count | Each rejected with its reason | Pass |
| CPY-03 | Prompt | Research and playbook wrapped as data; right number of emails and spacing; system prompt says to ignore instructions in data | Pass |
| INS-01 | Campaign body | One step per email with per-lead variables and delays; schedule, days and time zone; stop on reply; tracking off | Pass |
| INS-02 | Text with `<`, `&`, quotes and line breaks plus footer | Escaped HTML paragraphs with a small footer | Pass |
| INS-03 | Names with a title, one word, none | First and last name split | Pass |

## Agent service: end to end

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| OJ-01 | Autopilot with six leads (three qualified, one low score, one catch-all, one already contacted) | Three approved 3-email sequences; others untouched; timeline entry | Pass |
| OJ-02 | Write again | Nothing new | Pass |
| OJ-03 | Outreach not launched | Nothing sent; reason given | Pass |
| OJ-04 | Launched without a footer | Run fails with the footer message | Pass |
| OJ-05 | Launched, daily limit 2 | Instantly campaign created with mailbox, limit, 3 steps and time zone; two leads added in score order with six variables and the escaped footer; campaign activated | Pass |
| OJ-06 | After hand-over | Emails "With Instantly" with the lead id; lead Contacted; editing refused; campaign state active | Pass |
| OJ-07 | Kill switch | Sync queued by trigger; one pause call; state paused | Pass |
| OJ-08 | Next day, resumed, next lead suppressed | Campaign reactivated; suppressed lead skipped and still New | Pass |
| OJ-09 | Approval mode; two steps approved, one rejected | Drafts stored; the next ready lead is sent, the held-back sequence is not | Pass |
| OJ-10 | Model returns emails with a link | Nothing stored; run fails with a clear message | Pass |
| OJ-11 | Instantly rejects the key | Run fails; Instantly flagged in Setup | Pass |
| OJ-12 | All results, emails and timeline | No credential stored | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| OUT-W01 | Valid settings with repeated, mixed-case mailboxes | Lower-cased, de-duplicated; days and numbers parsed | Pass (after fix) |
| OUT-W02 | Ten kinds of mistakes | One clear message each | Pass |
| OUT-W03 | Time zone list | Only values the sending service accepts, no repeats | Pass |
| OUT-W04 | Launch checklist with each required item missing | Not ready; warm-up only recommended | Pass |
| OUT-W05 | Copywriting and sending results | One readable line each | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-17 | Job types and email statuses extended; 13 campaign and 5 email columns; guard and sync triggers present; claim holds sourcing and copywriting under the kill switch; daily schedule includes sending | Pass (inside a rolled-back block) |
| LIVE-18 | Security advisor after the migration | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-32 | Switch the workspace to approval mode, press Write emails now on a campaign with qualified leads | Drafts appear in Review emails, specific to each company |
| ACC-33 | Approve two sequences, fill in email settings, launch | A campaign named "… (AI SDR)" appears in Instantly, active, with two leads whose emails show the AI text and footer |
| ACC-34 | Press the kill switch | The Instantly campaign shows paused within a minute or two |
| ACC-35 | Reply to one of the test emails | Instantly stops that lead's sequence (reply handling in the app comes with F09) |
