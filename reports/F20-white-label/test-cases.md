# F20 — White-Label Mode for Agencies: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/white-label.test.mjs`) | `npm run test:db` | **8 passed, 0 failed** |
| Agent (`PIPE-15` in `pipeline.test.ts`, `CR-06` and `CJ-10` in `crm.test.ts`, brand name check in `OJ-05`) | `cd agents && npm test` | **3 passed, 0 failed** |
| Web unit (`web/tests/white-label.test.ts`) | `cd web && npm test` | **6 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** (Agencies, the agency console and the usage download added to E2E-03: all ask signed-out visitors to sign in) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 192, agents 263, web 117 | **572 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WL-01 | Owner adds an admin, the admin adds staff; staff, an outsider and an unknown email try | Added; refused; refused; "No account uses that email"; team listed as owner, admin, staff; outsiders see no agency | Pass |
| WL-02 | Brand set by staff; non-https logo; named colour; upper-case domain; valid brand | Refused by row security; each check refuses; saved; team reads it; outsiders do not | Pass |
| WL-03 | Brand lookup by visitors | Public fields for the agency's domain; nothing for unknown or malformed hosts | Pass |
| WL-04 | Cadence and playbook defaults; a foreign key in the defaults; staff and an admin create a client | Foreign key refused; staff refused; client created with its plan, limits and defaults; the admin is its owner; playbook version 1 active; a new campaign gets the cadence (and keeps standard values elsewhere) | Pass |
| WL-05 | Client changes its seat limit or agency, or creates a workspace under an agency; renames itself; staff and the owner of an unrelated workspace set a plan; the agency owner does | Refused; refused; renamed; refused; plan and limits changed | Pass |
| WL-06 | Seat limit of 2 | Second member added; third refused with "This plan allows 2 team members" | Pass |
| WL-07 | Staff read usage; staff read client leads; outsider; a two-year period | One client with plan, 2 members, 1 lead, 1 win, USD 1,499 revenue; no leads visible; refused; refused | Pass |
| WL-08 | Visitors call the console functions | Permission denied | Pass |

## Agent

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| PIPE-15 | Monthly lead limit of 2 with a daily limit of 10 | 2 leads added; the next run adds none with the monthly-limit note | Pass |
| CR-06 | Note for a white-label client | "Logged by" the agency's app name, HTML-escaped | Pass |
| CJ-10 | CRM sync for a white-label client | The HubSpot note names the agency's app, never the platform | Pass |
| OJ-05 (extended) | Instantly campaign name without an agency | Uses the platform's own suffix; with an agency it uses the agency's app name | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WWL-01 | Reading a brand | Valid brand used; a `javascript:` logo or a missing brand falls back to the platform brand; colour becomes the page accent | Pass |
| WWL-02 | Host names | Lower-cased with the port removed; localhost and injection attempts ignored | Pass |
| WWL-03 | Brand form | Domain cleaned from a pasted URL; clear messages for an http logo, a named colour, a bad domain and an empty app name | Pass |
| WWL-04 | Client plan form | Empty limits mean no limit; a zero limit refused with a clear message | Pass |
| WWL-05 | Cadence defaults form | Only filled fields stored; out-of-range and bad times refused clearly | Pass |
| WWL-06 | Usage | Malformed rows rejected; revenue text; 92% flag; CSV row exact with formulas neutralised | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-41 | New tables with row security; visitors cannot read brands or run the console functions; brand lookup returns nothing for unknown hosts; workspace columns and triggers present | Pass |
| LIVE-42 | Security advisor: only the six expected console functions added (`brand_for_host` for visitors; `agency_member_add`, `agency_members_list`, `agency_create_workspace`, `agency_set_plan`, `agency_usage` for signed-in users, each checking the agency role itself) | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-78 | Create an agency, set a brand and a custom domain, point the domain at the app, open it signed out | Sign-in page shows the agency's name, logo and colour; no platform name |
| ACC-79 | Create a client workspace with limits; invite the client | The client sees only the agency brand; Team refuses members beyond the seat limit |
| ACC-80 | Download the usage CSV | One row per client, opens cleanly in a spreadsheet |
| ACC-81 | Connect HubSpot in a client workspace and sync | Notes say "Logged by" the agency's app name |
