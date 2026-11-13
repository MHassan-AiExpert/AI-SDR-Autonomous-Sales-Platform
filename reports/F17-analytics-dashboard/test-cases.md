# F17 — Reporting and Analytics Dashboard: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/analytics.test.mjs`) | `npm run test:db` | **4 passed, 0 failed** |
| Web unit (`web/tests/analytics.test.ts`) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** (Analytics page and CSV download added to E2E-03: both ask signed-out visitors to sign in) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 170, agents 229, web 103 | **502 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| AN-01 | Two campaigns with leads (one outside the period), emails, replies (one out-of-office), a held meeting, a won deal, a text, calls, an inbound call, an opened audit | Funnel 3, 3, 3, 2, 1, 1, 1, 1; revenue $499 USD; 1 won by the AI; channel figures; about 30 days; per-campaign row | Pass |
| AN-02 | Filter to one campaign | Every figure narrowed; only that campaign listed | Pass |
| AN-03 | Member of another workspace; visitor; a 17-month period; end before start | Zeros and no campaigns; permission denied; refused; refused | Pass |
| AN-04 | Admin and rep set the spend; bad currency; negative amount | Admin saved, rep changes nothing; rejected; rejected | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DW-01 | Periods and summary | Known ranges kept, unknown default to 30 days; exact dates; malformed summaries rejected | Pass |
| DW-02 | Rates, money, cost per meeting | 12.5%, dash for none; $499, €19.99; spend spread over the period; none without spend or meetings | Pass |
| DW-03 | Chart points | Series scaled into the box; empty series | Pass |
| DW-04 | CSV | Every cell quoted; formulas neutralised; header and row exact | Pass |
| DW-05 | Spend form | Amounts to cents; empty clears; one clear message for a bad amount or currency | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-35 | 2 workspace columns; function is security invoker; visitors cannot run it; it returns the expected shape | Pass |
| LIVE-36 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-67 | Open Analytics for the last 30 days | Figures match the Leads, Inbox, Meetings and Deals pages for the period |
| ACC-68 | Enter a monthly spend | Cost per meeting appears |
| ACC-69 | Download the CSV and open it in a spreadsheet | One row per campaign; no formulas run |
