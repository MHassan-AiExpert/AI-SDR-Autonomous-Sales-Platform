# F06 — Enrichment and Verification: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/enrichment.test.mjs`) | `npm run test:db` | **8 passed, 0 failed** |
| Agent service: adapters (`agents/tests/verify.test.ts`) | `cd agents && npm test` | **14 passed, 0 failed** |
| Agent service: end-to-end enrichment (`agents/tests/enrichment.test.ts`) | `cd agents && npm test` | **13 passed, 0 failed** |
| Agent service: hand-off and schedule setting (PIPE-14, CFG-02) | `cd agents && npm test` | **2 passed, 0 failed** |
| Web unit (`web/tests/campaigns.test.ts`, CMP-09 and CMP-10) | `cd web && npm test` | **2 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 114, agents 84, web 58 | **256 passed, 0 failed**; agent suite run 10 times in a row with no failures |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| ENR-01 | Daily run with active, draft, paused and niche-less campaigns | Sourcing and enrichment queued for the active campaign only, with no requester | Pass |
| ENR-02 | Run again; after jobs finish; after 25 hours | Nothing while waiting or recent; both queued again after the interval | Pass |
| ENR-03 | Workspace paused | No scheduled jobs; jobs queued once resumed | Pass |
| ENR-04 | Sourcing hands over to enrichment twice | Queued once | Pass |
| ENR-05 | Signed-in owner calls the scheduling functions | Permission denied | Pass |
| ENR-06 | Owner queues enrichment; unknown job type | Allowed; rejected | Pass |
| ENR-07 | Company with campaign and source; another workspace's campaign; unknown source; campaign deleted | Stored as pending; cross-workspace rejected; bad source rejected; company kept with campaign cleared | Pass |
| ENR-08 | Phone country `US` and `usa` | Accepted; rejected | Pass |

## Agent service: website reader

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WEB-01 | Private, loopback, link-local, metadata, NAT, multicast and IPv6 local addresses | All recognised as non-public; public ones allowed | Pass |
| WEB-02 | Public host; host resolving to 10.x; mixed public and loopback; IP host; port 8443; ftp; credentials in URL | Only the first allowed | Pass |
| WEB-03 | Home page links an agency email; contact page has the company email (HTML-encoded @) and a tel: link | Company email and E.164 phone returned; two pages read | Pass |
| WEB-04 | Redirect to an internal hostname | Refused; internal host never requested | Pass |
| WEB-05 | JSON page, page with only other companies' emails, server error | No email taken | Pass |

## Agent service: verification and Apollo

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VER-01 | Every ZeroBounce status | Mapped to valid, catch-all, invalid or risky | Pass |
| VER-02 | Verify an email | Company key and email sent; verdict returned | Pass |
| VER-03 | ZeroBounce "out of credits" and "invalid key" answers | Status 402 and 401 with fixed messages, no key | Pass |
| VER-04 | Every Twilio line type | Mapped to mobile, landline, VoIP or unknown | Pass |
| VER-05 | Lookup of a valid and an unknown number | Basic auth; E.164, country and type returned; 404 means not valid | Pass |
| APO-01 | Decision makers at a domain, including a former employee and a third person | Two current employees kept; former employee dropped; domain and titles sent | Pass |
| APO-02 | Organisation enrichment with and without data | Details returned; empty answer gives none | Pass |
| HLP-01 | Names in capitals, lower case with apostrophe and hyphen, mixed case, blank | "John McDonald", "Mary O'Neil-Smith", unchanged, none | Pass |
| HLP-02 | Seven tasks, three at a time | Never more than three running; results in order | Pass |

## Agent service: end-to-end enrichment

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| EN-01 | Company with a domain and no contact; Apollo connected | Named lead (name tidied) linked to the company, tagged with the company's source; company enriched with industry and size | Pass |
| EN-02 | Company Apollo cannot match | Website email and phone become the lead | Pass |
| EN-03 | Company with nothing found; company without a domain | No contact found; skipped | Pass |
| EN-04 | Five emails, old and new | Valid, invalid, catch-all, risky set; check time stored; timeline entry | Pass |
| EN-05 | Phones with and without a country code; website phone | Mobile + US; unknown and checked; landline; Twilio called with the company's credentials | Pass |
| EN-06 | Job result | Companies, emails and phones counted correctly; Apollo credits reported | Pass |
| EN-07 | Second run | No ZeroBounce, Twilio or Apollo enrichment calls | Pass |
| EN-08 | ZeroBounce out of credits | Job succeeds; error reported; tool flagged; emails left unchecked | Pass |
| EN-09 | Workspace with no enrichment tools | Notes say what to connect; no tool calls; company without domain skipped | Pass |
| EN-10 | All channels off | No verification calls; nothing marked checked; note explains why | Pass |
| EN-11 | Daily limit 2, four companies, one contact suppressed | Two leads; suppressed company skipped; held-back company stays pending | Pass |
| EN-12 | Agent tick with the schedule on | Sourcing and enrichment queued for an active campaign | Pass |
| EN-13 | All results, timeline entries and tool errors | No credential anywhere | Pass |
| PIPE-14 | Sourcing job succeeds | Enrichment queued for the same campaign | Pass |
| CFG-02 | `SCHEDULE_HOURS` 0, 12, 9999, text | 0, 12, capped at 168, off | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CMP-09 | Enrichment results: full, tool error with a note, empty | One readable line each | Pass |
| CMP-10 | Email check filter | Read, kept in links, unknown values ignored | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-13 | Job type constraint includes enrichment; 4 new company columns and 3 new lead columns exist; scheduling functions callable by the backend only; daily scheduler runs (0 campaigns due) | Pass (inside a rolled-back block) |
| LIVE-14 | Security advisor after the migration | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-24 | Connect ZeroBounce, press "Enrich and verify" on a campaign with leads | Emails show Verified, Invalid, Catch-all or Risky; credits drop by the number checked |
| ACC-25 | Connect Twilio, run again | Phones show line type and country |
| ACC-26 | Campaign with LLM-search companies, Apollo connected | "Companies awaiting contacts" falls and named leads appear |
| ACC-27 | Leave an active campaign for a day | Agent activity shows a scheduled "Find leads" and "Enrich and verify" run |
