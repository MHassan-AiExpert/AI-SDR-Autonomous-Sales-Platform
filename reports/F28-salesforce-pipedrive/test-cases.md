# F28 — Salesforce and Pipedrive: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/crm.test.mjs`) | `npm test` | **CRM-07 and CRM-08 added, CRM-04 updated: all 8 passed** |
| Agent (`agents/tests/crm-providers.test.ts`) | `cd agents && npm test` | **19 passed, 0 failed** |
| Agent, HubSpot regression (`agents/tests/crm.test.ts`) | `cd agents && npm test` | **16 passed**, unchanged |
| Web unit (`web/tests/crm-providers.test.ts`) | `cd web && npm test` | **8 passed, 0 failed** |
| Web, earlier CRM and connection tests | `cd web && npm test` | Passed; fixtures extended for the two new tools, WCR-01 now expects the `crm_provider` field |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **18 passed, 0 failed** |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 260, agents 372, web 183 | **815 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CRM-04 (updated) | A link id with spaces or punctuation; 31 characters | Refused (letters and digits are now accepted, for Salesforce) | Pass |
| CRM-07 | The default CRM; an unknown CRM; a rep changes it; an owner changes it; a Salesforce stage name with a slash | HubSpot; refused; unchanged; changed; stored | Pass |
| CRM-08 | Connect Pipedrive and Salesforce; link one lead in all three CRMs; twice in Salesforce; an unknown CRM | Both connected; three links; the second Salesforce link refused; refused | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CRP-01 | Stage maps with values valid and invalid for each CRM | Only valid values kept; defaults otherwise | Pass |
| CRP-02 | A Pipedrive person and deal, open, won, default pipeline | Name falls back to email; won is a status with no stage; unmapped open deals have no stage | Pass |
| CRP-03 | Salesforce contact and opportunity | LastName always present; open opportunity has no close date; won one has the close date | Pass |
| CRP-04 | A task from a reply containing HTML | Plain text, the lead's text kept literally | Pass |
| CRP-05 | SOQL literals with a quote and a backslash | Escaped | Pass |
| CRP-06 | My Domain hosts, sandbox, Lightning, look-alikes | Only My Domain hosts accepted | Pass |
| CRP-07 | Pipedrive person found, updated, a near match, created | Found by exact email; update leaves emails alone; near match ignored; created with email and phone; token never in a URL | Pass |
| CRP-08 | 150 deal ids and one invalid | Two requests of at most 100; invalid id left out | Pass |
| CRP-09 | Salesforce sign-in; bad credentials; a non-Salesforce host | Form-encoded client credentials to the org's host; 400 read as rejected; no request made | Pass |
| CRP-10 | Three contacts: one existing, one new, one refused as duplicate | Updated, created, and the refusal reported; SOQL exactly as expected | Pass |
| CRP-11 | A collection answer shorter than the request | An error, not mismatched ids | Pass |
| CRP-12 | Opportunity with a refused contact role | Opportunity id still returned, with the close date 30 days out | Pass |
| CRP-13 | Outcomes for won, lost, open, a 15-character id and an invalid id | Read from IsWon and IsClosed, matched to the stored id; the invalid id never reaches the query | Pass |
| CRPJ-01 | Pipedrive chosen but not connected | Skipped, naming Pipedrive; nothing sent | Pass |
| CRPJ-02 | First Pipedrive run | Person, deal in pipeline 2 at stage 9, and note; three links | Pass |
| CRPJ-03 | Second run; deal won in Pipedrive | Nothing resent; closed as won, activity names Pipedrive, one alert | Pass |
| CRPJ-04 | Switch to Salesforce | Contact, opportunity at Negotiation/Review, completed task in plain text; no Pipedrive request; Pipedrive links kept | Pass |
| CRPJ-05 | Deal value changes; opportunity won in Salesforce | Updated with a PATCH; closed as won naming Salesforce | Pass |
| CRPJ-06 | Salesforce credentials rejected | Run fails with the reconnect message, Salesforce flagged, secret not in the record | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WCRP-01 | Pipedrive form: numbers, a name, a named pipeline, a duplicate | Stored; each refused with its own message; no won or lost stage | Pass |
| WCRP-02 | Salesforce form: names with slashes; a name with markup | Only non-defaults stored; markup refused | Pass |
| WCRP-03 | Switching CRM with the old CRM's values on the form | Reset to the new CRM's defaults; an unknown CRM refused | Pass |
| WCRP-04 | Help text and result messages | Present for every CRM; results name the CRM; an unknown name falls back | Pass |
| WCRP-05 | My Domain field and stored metadata | Only My Domain hosts; the consumer secret stored as a secret, only its hint shown | Pass |
| WCRP-06 | Salesforce connection check, good, 400, no token | Passes; "rejected these credentials"; fails | Pass |
| WCRP-07 | Pipedrive connection check | `users/me` with the token in a header | Pass |
| WCRP-08 | Setup | All three CRMs offered under one optional step | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-56 | 31 migrations; links accept the three CRMs and Salesforce ids; the two tools may be connected; `crm_provider` defaults to hubspot, and every existing workspace is still on HubSpot | **Pass** |
| LIVE-57 | Security advisor | **Pass**: no new entries |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-108 | Connect a Pipedrive trial, choose Pipedrive, sync | People, deals and notes appear; rerun sends nothing new |
| ACC-109 | Mark the deal won in Pipedrive | Won here within the hour |
| ACC-110 | Create an external client app in a Salesforce Developer Edition org with the client credentials flow, connect it, sync | Contacts, opportunities with contact roles, and completed tasks appear |
| ACC-111 | Move the opportunity to Closed Won | Won here within the hour |
