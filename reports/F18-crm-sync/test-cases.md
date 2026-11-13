# F18 — CRM Sync with HubSpot: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/crm.test.mjs`) | `npm run test:db` | **6 passed, 0 failed** |
| Agent (`agents/tests/crm.test.ts`) | `cd agents && npm test` | **14 passed, 0 failed** |
| Web unit (`web/tests/crm.test.ts`) | `cd web && npm test` | **4 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed** |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 176, agents 243, web 107 | **526 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CRM-01 | Defaults; unknown scope; bad pipeline id; a stage map that is not an object or is too large | Off, engaged, default pipeline, empty map, never synced; each bad value rejected | Pass |
| CRM-02 | Admin, rep, viewer and another workspace's owner switch sync on | Admin saved; the others change nothing | Pass |
| CRM-03 | Member, other workspace, owner trying to insert, update or delete links | Member reads; other workspace sees nothing; writes denied | Pass |
| CRM-04 | Second link for the same record; non-numeric HubSpot id; bad fingerprint; unknown record type; two leads sharing one contact | Duplicate refused; checks refuse each; shared contact allowed | Pass |
| CRM-05 | Hourly schedule with sync off, on, within the hour, after an hour, with the kill switch on | 0, 1, still 1, 2, 0 | Pass |
| CRM-06 | Workspace deleted | Its links are deleted | Pass |

## Agent

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CR-01 | Contact properties | Names split; lead status by stage; Won sets Customer; no empty names | Pass |
| CR-02 | Stage map | Valid custom ids kept (trimmed), bad ones and unknown keys ignored | Pass |
| CR-03 | Deal input | "Bright Dental: Growth", amount 1499.00, Contract sent; falls back to the lead's name; no amount when unknown | Pass |
| CR-04 | Notes | HTML in a reply escaped; call note with minutes, outcome and summary; meeting note with time and AI closer | Pass |
| CR-05 | Fingerprint | Same input same hash; different input different hash; 64 hex characters | Pass |
| CJ-01 | Sync off; HubSpot not connected | "CRM sync is switched off"; "HubSpot is not connected"; no calls to HubSpot | Pass |
| CJ-02 | First sync of an engaged lead with a deal and a reply (a contacted lead and a phone-only lead also present) | One contact upserted by email with the token as bearer; deal in the default pipeline linked to the contact (type 3); note linked to the contact (type 202) with escaped text; three links saved; last sync time set | Pass |
| CJ-03 | Second run, nothing changed | No contact, deal or note calls; only the stage read-back | Pass |
| CJ-04 | Deal moves to negotiation | Existing HubSpot deal updated with PATCH to Decision maker bought in; none created | Pass |
| CJ-05 | Deal set to Closed won in HubSpot | Deal won and closed by a person; lead Won; "Marked won in HubSpot" logged; contact sent as Customer; closed deals no longer read back | Pass |
| CJ-06 | Scope changed to everyone contacted | The contacted lead is sent too | Pass |
| CJ-07 | HubSpot answers 429 | Run succeeds marked rate-limited with nothing lost; the next run sends the waiting note | Pass |
| CJ-08 | HubSpot answers 401 | Run fails with the reconnect message; no token in the job; HubSpot marked expired | Pass |
| CJ-09 | Hourly schedule | One crm_sync queued while on; none while off | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WCR-01 | Settings form | Default stages not stored; custom pipeline and stages stored; blank pipeline means default; unticked means off | Pass |
| WCR-02 | Bad input | Clear messages for a bad stage id, duplicate stages, an unknown scope and a bad pipeline id | Pass |
| WCR-03 | Showing saved stages | Custom id, or the default when missing or invalid | Pass |
| WCR-04 | Task history | "CRM sync" label; results in plain words, including skipped, up to date, rate-limited and failed | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-37 | 5 workspace columns; `crm_links` has row security, no visitor access and no member writes; `crm_sync` job type allowed; hourly schedule includes it | Pass |
| LIVE-38 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-70 | Connect HubSpot with a private app token, switch sync on, Sync now | Engaged leads appear as contacts, open deals in the pipeline, replies and calls as notes |
| ACC-71 | Move a deal to Closed won in HubSpot and wait for the next run | The deal shows Won on the Deals page |
| ACC-72 | Revoke the token in HubSpot | Next run fails with the reconnect message and Settings shows a warning |
