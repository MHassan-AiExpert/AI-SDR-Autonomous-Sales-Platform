# F15 — Website and Marketing Audits: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/audits.test.mjs`) | `npm run test:db` | **4 passed, 0 failed** |
| Agent service (`agents/tests/audit.test.ts`) | `cd agents && npm test` | **12 passed, 0 failed** |
| Web unit (`web/tests/audit.test.ts`) | `cd web && npm test` | **3 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** (E2E-17 added for shared audit links) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 162, agents 218, web 95 | **475 passed, 0 failed** (two earlier tests that attach a team member's own audit link pass after the guard was narrowed) |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| AU-01 | Audits off by default; second audit for the same lead and campaign; invalid token, status, web address, score | Off; rejected; all rejected | Pass |
| AU-02 | Owner creates a shared audit; admin changes one; rep attaches their own audit link, then tries to make it shared; rep adds a proposal | Refused; refused; allowed, refused; allowed | Pass |
| AU-03 | Visitor reads by link; unknown, malformed and empty links; expired audit; visitor reads the table | Only the expected fields, no email or phone; nothing; nothing; nothing; permission denied | Pass |
| AU-04 | Two opens, 5000 s and 45 s pings, unknown link, negative seconds; expired audit opened | 2 opens and 645 s; one timeline entry; lead Engaged; one alert job; expired not counted | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| AT-01 | Well-built site with good reviews | All 13 checks pass; score 100 | Pass |
| AT-02 | Weak site over HTTP, slow, no rating; poor reviews | Each check measured as expected; unknown reviews not counted; score from the rest; poor reviews fail | Pass |
| AT-03 | Standard and AI recommendations | Top three failures first; AI recommendations only for failed checks; links rejected; unmatched rejected | Pass |
| AT-04 | Prompt and email line | Results and research wrapped as data; the line names the business | Pass |
| AT-05 | Home page over HTTP after HTTPS fails; private address | Falls back with the time measured; private address never fetched | Pass |
| AJ-01 | Four leads: good site, weak site, no site, below the score threshold | Two audits ready with private links (good: 100 and no recommendations; weak: AI recommendations for failed checks only); no site recorded; low score skipped; the AI called only for the weak site | Pass |
| AJ-02 | Run again | No duplicates; copywriting queued next | Pass |
| AJ-03 | Copywriting after audits | First email ends with the audit line and link; later emails and leads without an audit have none | Pass |
| AJ-04 | New lead not yet audited | No emails written yet | Pass |
| AJ-05 | Lead opens the audit; run twice | One Slack alert with the score; none the second time | Pass |
| AJ-06 | Audits off | Clear note; no audit; emails written without waiting | Pass |
| AJ-07 | All stored audits and job results | No credentials | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| AW-01 | Shared page data: valid, empty, out-of-range score, unknown status, missing content | Only valid data shown; defaults for missing parts | Pass |
| AW-02 | Tokens, visit pings, site links | Only 48 lowercase hex; whole seconds 0 to 600; only plain home page addresses | Pass |
| AW-03 | Score bands, labels, audit run results | Good, fair, poor; labels present; readable lines | Pass |

## Browser

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-17 | Unknown and malformed audit links; a visit ping for an unknown link | Not-found page with status 404 and no sign-in redirect; the ping answers 204 | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-31 | Job type; 11 asset columns; guard; visitors can call the two shared-page functions but cannot read assets; unknown link returns nothing | Pass |
| LIVE-32 | Security advisor | Two expected findings for the shared-page functions (callable by link only, no contact data); nothing else new | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-60 | Turn audits on for a campaign with qualified leads | Each lead profile shows an audit with a score and link |
| ACC-61 | Open an audit link in a private browser window | The audit page; the lead profile shows 1 open; Slack "Audit opened" |
| ACC-62 | Open the same link while signed in | Not counted |
| ACC-63 | Approve the first email for a lead with an audit | The email ends with the audit line and link |
