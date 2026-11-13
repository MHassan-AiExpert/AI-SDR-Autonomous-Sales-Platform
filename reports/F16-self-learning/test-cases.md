# F16 — Self-Learning: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/learning.test.mjs`) | `npm run test:db` | **4 passed, 0 failed** |
| Agent service (`agents/tests/learning.test.ts`) | `cd agents && npm test` | **11 passed, 0 failed** |
| Web unit (`web/tests/learning.test.ts`) | `cd web && npm test` | **3 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** (Learning page added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 166, agents 229, web 98 | **493 passed, 0 failed** (EN-12, ENR-01 and ENR-03 updated to include the weekly learning run) |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| LN-01 | Defaults; 9 lessons; over 1600 characters; threshold suggestion without a value; bad finding id | None and off; all rejected | Pass |
| LN-02 | Viewer reads; other workspace reads; owner writes suggestions or reports directly; same lesson twice | Allowed; nothing; permission denied; rejected | Pass |
| LN-03 | Rep and other-workspace owner apply; admin applies a lesson, again; owner applies a threshold; dismiss; remove | Refused; added to the campaign, then "already decided"; threshold 70; dismissed; removed from the campaign with who and when | Pass |
| LN-04 | Weekly schedule; after 100 hours; after 169 hours | One run; no new run; a second run | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| LL-01 | Two-proportion test: 20 vs 5 of 100; equal; empty; 6 vs 4 of 50 | p below 0.005; 1; 1; above 0.3 | Pass |
| LL-02 | 15 of 60 vs 3 of 60; 20-lead groups; a 1-point gap | One finding with exact figures; nothing; nothing | Pass |
| LL-03 | Better question subjects; weaker lowest score band; source difference | Copy lesson; threshold to 70; no lesson from sources | Pass |
| LL-04 | AI summary with measured figures; with an unmeasured figure; with a link; no data | Kept; rejected; rejected; standard text | Pass |
| LL-05 | Copywriter prompt with and without lessons | Lessons listed below the rules; nothing when none | Pass |
| LJ-01 | 120 leads in the database (15 of 60 vs 3 of 60) | Report with the finding and figures; one lesson waiting; summary by the AI; Slack with a Review link; nothing applied | Pass |
| LJ-02 | Run again | No duplicate suggestion | Pass |
| LJ-03 | AI summary inventing 40.0% | Standard summary used | Pass |
| LJ-04 | Auto-apply on | Lesson applied to the campaign; Slack "1 new lesson was applied" | Pass |
| LJ-05 | Copywriting after the lesson | The model's prompt includes the lesson | Pass |
| LJ-06 | Campaign with no emails | Plain report; no AI call; no alert | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| LW-01 | Findings with bad entries | Only valid findings shown | Pass |
| LW-02 | Labels, confidence, percentages | Present; very clear or clear; safe formatting | Pass |
| LW-03 | Learning run results | Readable lines | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-33 | Job type; 2 campaign columns; row security on both tables; members read but cannot update; visitors cannot decide; weekly schedule | Pass |
| LIVE-34 | Security advisor | One expected finding for `learning_decide` (checks the caller's role itself); nothing else new | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-64 | On a campaign with at least 60 emailed leads, press "Learn from results now" | A report with figures, and findings where the differences are clear |
| ACC-65 | Apply a lesson, then let the copywriter run | New first emails follow the lesson |
| ACC-66 | Turn on automatic lessons | The next lesson is applied and announced in Slack |
