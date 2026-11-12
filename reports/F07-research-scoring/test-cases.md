# F07 — Research and Scoring: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/research.test.mjs`) | `npm run test:db` | **3 passed, 0 failed** (ENR-01 to 03 updated for the research schedule) |
| Agent service (`agents/tests/research.test.ts`) | `cd agents && npm test` | **16 passed, 0 failed** |
| Web unit (`web/tests/campaigns.test.ts`, CMP-11 to 13) | `cd web && npm test` | **3 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (lead profile added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 117, agents 100, web 61 | **278 passed, 0 failed**; agent suite run 5 times in a row with no failures |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RES-01 | New campaign; admin and rep change the threshold; threshold 101 | Default 60; admin can, rep cannot; 101 rejected | Pass |
| RES-02 | Owner queues research; lead score 140 | Allowed; rejected | Pass |
| RES-03 | Company stores research; new lead | Research kept; lead not yet researched | Pass |

## Agent service: scoring

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SCO-01 | Fit 80, intent 60, target title, verified email, mobile | 92 with four reasons in order | Pass |
| SCO-02 | Named person with a non-target title; nameless business inbox | 69; 74 (no title penalty) | Pass |
| SCO-03 | Invalid email and no other contact; disqualified company | 49; capped at 30 with the reason | Pass |
| SCO-04 | Maximum and minimum inputs | 100 and 0 | Pass |

## Agent service: prompt and parsing

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RSP-01 | Website text containing an injection attempt; no website | Wrapped in `<website>` tags; system prompt says to ignore its instructions; web search requested without a site | Pass |
| RSP-02 | Strict schema; fit score 140; empty summary | Every property required; both rejected | Pass |
| RSP-03 | HTML with style, script, entities and comments | Clean readable text | Pass |

## Agent service: end-to-end research job

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| RJ-01 | Three companies, four leads, threshold 70 | One model call per company; owner scores 89 and qualifies; hygienist 69 and does not | Pass |
| RJ-02 | Company with a website; company without | Website text sent as data with no search; web search used without a site | Pass |
| RJ-03 | Company brief | Summary in `research_brief`, full research and time stored | Pass |
| RJ-04 | Disqualified company; company whose model call fails | Score 30; leads left unscored; result counts 2 researched, 1 failed, 1 qualified, 2 below | Pass |
| RJ-05 | Timeline | "Researched and scored 89/100 (qualified for outreach)" | Pass |
| RJ-06 | New lead at a researched company; failed company retried | No new call for the researched company; scored 89; failed company scored on retry (42) | Pass |
| RJ-07 | No language model; campaign not planned | Failed with "Connect OpenAI, Anthropic or Gemini…"; "Plan the campaign first…" | Pass |
| RJ-08 | Enrichment job succeeds | Research queued for the same campaign | Pass |
| RJ-09 | All reports and results | No credential stored | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CMP-11 | Research results with and without leads | One readable line each | Pass |
| CMP-12 | Threshold 75 and 120; min score and sort filters; bad values; colour bands | 75 accepted, 120 rejected; filters round-trip; bad values ignored; bands ok, warn, low, none | Pass |
| CMP-13 | Stored report with wrong types and extra fields | Only expected, well-typed fields read | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-15 | Job type includes research; threshold defaults to 60; research columns on companies and leads; daily schedule includes research and is callable by the backend only | Pass (inside a rolled-back block) |
| LIVE-16 | Security advisor after the migration | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-28 | On a campaign with verified leads, press "Research and score" | Within a minute or two, leads show scores; the campaign shows the qualified count |
| ACC-29 | Open a high-scoring lead | Summary, pain points and hooks match the company's real website |
| ACC-30 | Set the threshold to 80, open "Qualified leads only" | Only leads scoring 80 or more listed |
| ACC-31 | Leave an active campaign for a day | Agent activity shows sourcing, enrichment and research runs in order |
