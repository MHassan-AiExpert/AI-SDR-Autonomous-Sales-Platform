# F22 — Conditional Branching and A/B Testing: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/sequence.test.mjs`) | `npm run test:db` | **13 passed, 0 failed** |
| Agent (`agents/tests/sequence.test.ts`, plus LRN-26) | `cd agents && npm test` | **21 passed, 0 failed** |
| Web unit (`web/tests/sequence.test.ts`) | `cd web && npm test` | **14 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed**, run twice |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 216, agents 284, web 137 | **637 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SEQB-01 | A viewer and a rep try to add a step; an owner adds a message | Both refused by row-level security; the owner's write succeeds; the viewer can read it | Pass |
| SEQB-02 | Another workspace reads the sequence and tries to write into this one | Sees nothing; the write is refused | Pass |
| SEQB-03 | A second step at position 1; a second message labelled `a`; a message labelled `d` | First two refused as duplicates, the third by the check constraint | Pass |
| SEQB-04 | The facts for a lead never contacted | No last touch; no emails sent; not replied; reachable by email; no steps run or done | Pass |
| SEQB-05 | A lead with a sent email 50 hours ago, a voicemail 3 hours ago, a text, then a reply | Counts right; last outcome `voicemail`; hours since last touch about 3, from the call; then replied with the classification | Pass |
| SEQB-06 | Leads that are won, on the do-not-contact list, and suppressed | None of the three is a candidate for another step | Pass |
| SEQB-07 | The same step recorded twice for one lead, with different messages | First returns true, second false; one row only; the first message is the one kept | Pass |
| SEQB-08 | Recording the step marked as the last one | The lead is reported as stopped | Pass |
| SEQB-09 | Recording the last step as **failed** | Not stopped, and not counted as a send, but not available to try again either | Pass |
| SEQB-10 | A member reads the record; an owner tries to change and delete it; another workspace reads it | Read allowed; change and delete refused; other workspace sees nothing | Pass |
| SEQB-11 | Deleting a step that has messages and history | Its messages and its run history go with it | Pass |
| SEQB-12 | The two new campaign switches | Both off by default; an owner can turn branching on | Pass |
| SEQB-13 | A visitor reads the tables, the facts function and the recording function | All five refused | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SEQ-01 | `is`, `not` and `in` comparisons | Correct in each case | Pass |
| SEQ-02 | A fact that is missing entirely | Reads as null, so `is null` holds and a number comparison does not | Pass |
| SEQ-03 | A lead never contacted, against `at_least` and `at_most` | Counts as long enough ago for `at_least`, and fails `at_most`; a real 47 hours fails `at_least: 48` | Pass |
| SEQ-04 | Counts arriving as strings from the driver | Still compared as numbers | Pass |
| SEQ-05 | `all`, `any`, an empty condition, and both together | All must hold; any needs one; empty always holds; both given means both | Pass |
| SEQ-06 | A condition naming a fact the system does not measure; malformed clauses | The unknown name is reported; a clause with no comparison, two comparisons, or an unexpected key is refused | Pass |
| SEQ-07 | The same lead and step asked twice; an inactive message; no active messages | Same answer each time; inactive never chosen; nothing to send reported | Pass |
| SEQ-08 | Three messages across 3,000 leads | Each lands between 850 and 1,150 | Pass |
| SEQ-09 | One lead across four steps | Not always in the same arm | Pass |
| SEQ-10 | A lead never contacted, one step | The first step runs with message A | Pass |
| SEQ-11 | A step already run | Never run again; reported as nothing left to do | Pass |
| SEQ-12 | A 48-hour wait with 12 hours elapsed, then 49 | Held back, then runs | Pass |
| SEQ-13 | **Branching:** after a voicemail, with an email step and a text step both waiting | The text step runs; with `no_answer` instead, the email step runs | Pass |
| SEQ-14 | A lead who replied, against steps conditioned on no reply | Nothing runs | Pass |
| SEQ-15 | A lead who has run the last step | Nothing runs; reported as stopped | Pass |
| SEQ-16 | A call step for a lead with no phone, then the phone arrives later | The email step runs first and the call step is **not** consumed; once the phone is there, the call step runs | Pass |
| SEQ-17 | A step whose condition cannot be parsed | It never runs; the next sound step runs instead | Pass |
| SEQ-18 | No steps at all; a lead reachable on no channel | Reported apart from one another | Pass |
| SEQ-19 | A sequence with no active message, an unknown fact, a missing subject, an opens condition without tracking, and no last step | All five reported in words a person can act on | Pass |
| SEQ-20 | A sound sequence, with and without open tracking | Nothing to report with tracking on; exactly one warning with it off | Pass |
| LRN-26 | An A/B message that clearly wins; too few leads; too small a difference; leads never in an A/B step | The winner is reported; the other three produce nothing | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WSEQ-01 | Each trigger converted to a stored condition | The shape the engine reads | Pass |
| WSEQ-02 | Every trigger stored and read back | Recognised again as the same trigger | Pass |
| WSEQ-03 | A condition this screen did not write, including one using `any` | Reported as custom, not mistaken for a trigger it is not | Pass |
| WSEQ-04 | Trigger labels, and which triggers need open tracking | All labelled; only the opens one needs tracking | Pass |
| WSEQ-05 | Waits of 0, 1, 4, 24 and 72 hours | "straight away", "after an hour", "after 4 hours", "after a day", "after 3 days" | Pass |
| WSEQ-06 | A step read back as a sentence, including the last step and a custom condition | "Email after 2 days, when they have not replied."; the last step says the sequence stops; a custom condition says so | Pass |
| WSEQ-07 | A share of nothing | Shown as a dash, not nought per cent | Pass |
| WSEQ-08 | A sound sequence | Nothing to report | Pass |
| WSEQ-09 | A step with no active message | Reported | Pass |
| WSEQ-10 | An email step with a blank subject; the same on SMS | Reported for email, not for SMS | Pass |
| WSEQ-11 | An opens condition with tracking off, then on | Reported, then clear | Pass |
| WSEQ-12 | No last step; an empty sequence | Reported; nothing reported for an empty sequence | Pass |
| WSEQ-13 | Positions 0 and 21, an unknown channel, a 721-hour wait, an unknown trigger | All refused | Pass |
| WSEQ-14 | A blank message, a label `d`, an over-long subject and body | All refused | Pass |

## Defects found and fixed during this feature

| Defect | How it was found | Fix |
| --- | --- | --- |
| `normalize()` read only `all` and dropped `any`, so a step using `any` displayed as "Always" and saving the form would have silently replaced a real condition | WSEQ-03 | Both combinators are kept when comparing conditions |
| `lead_step_runs` kept update and delete rights for signed-in users, because new tables here arrive with full rights and a `grant select` does not remove them | Comparing the live privileges against `audit_log` and `run_logs` | An explicit `revoke all ... from authenticated`, matching those tables |
| An unparseable condition would have been treated as no condition, so a broken sequence would have contacted everyone | Reviewing the decision function | Unparseable counts as unmet. SEQ-17 |
| The first draft of SEQB-01 asserted that an **owner** would be refused, after a bulk edit to the test file | The database suite failed with "missing expected rejection" | Restored to assert the rep is the one refused |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-45 | Three tables with row security, 5 policies, both campaign switches, both functions `security invoker`, the `sequence` job type, the `updated_at` trigger | **Pass** |
| LIVE-46 | A visitor cannot read the facts function; a signed-in user cannot call the recording function; `lead_step_runs` is read-only to signed-in users | **Pass** |
| LIVE-47 | Security advisor after the migration | **Pass** — no new warnings; the `security definer` entries listed are the earlier deliberate ones |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-86 | Build the four-step sequence from UC-F22-01 and turn branching on | The steps read back as sentences; no problems reported |
| ACC-87 | Run the sequence against leads with no history | Each gets step 1; the record shows which message |
| ACC-88 | Let a call reach voicemail, then run again | Those leads get the text step, not the email step |
| ACC-89 | Reply as a lead, then run again | Nothing further is sent to that lead |
| ACC-90 | Add a second message to step 1 and run against 60+ leads | Roughly even split; the learning report scores them once there are 30 each side |
