# F30 — Website Visitor Identification: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/visitors.test.mjs`) | `npm test` | **8 passed, 0 failed** |
| Agent (`agents/tests/visitors.test.ts`) | `cd agents && npm test` | **9 passed, 0 failed** |
| Web unit (`web/tests/visitors.test.ts`) | `cd web && npm test` | **7 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **20 passed, 0 failed**, including E2E-20; E2E-03 now also covers the Visitors page |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 283, agents 389, web 197 | **869 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VIS-01 | Two workspaces; a view while tracking is off | Distinct random keys; off by default; nothing recorded | Pass |
| VIS-02 | Views from the listed host, `www.`, a subdomain, and four other hosts | First three recorded with the query and fragment removed and the own-site referrer dropped; the rest refused | Pass |
| VIS-03 | A wrong key, a malformed key, a malformed or hostile address, no address | Nothing recorded | Pass |
| VIS-04 | 61 views in an hour from one network; another network | The 61st refused; the other accepted | Pass |
| VIS-05 | Owners, viewers and visitors reading raw views, the cache and the claim | All refused | Pass |
| VIS-06 | Claiming twice; after ten minutes; a resolved view; a view a day old | Held for ten minutes; reclaimed; its IP erased; skipped and erased | Pass |
| VIS-07 | Reading identified companies; editing them; a bad domain | Own workspace only; refused; refused | Pass |
| VIS-08 | A rep and an admin replacing the key; the old and new key; 11 hosts; a guessable key | Rep refused; old key dead, new key works; both refused | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| VID-01 | A business and an education network | Company, domain without `www.`, upper-case country | Pass |
| VID-02 | VPN, Tor, mobile, data centre, crawler, private, ISP, hosting, no domain, bad domain, empty | Each discarded with its reason | Pass |
| VID-03 | The lookup; a bad key; a used-up quota | The documented POST with the key in the body; 403 and 429 raised | Pass |
| VID-04 | Cache key, ISO week across a year end, the team's own domain | Stable; 2026-W47 and 2026-W53; matched | Pass |
| VIDJ-01 | ipapi.is not connected | Skipped, IP erased, no request | Pass |
| VIDJ-02 | Three views from a known company, one from an ISP, one from the team | Three networks looked up once each; the company counted with its paths and matched; one signal; the ISP and the team skipped; no IP left | Pass |
| VIDJ-03 | The same network next day; eight days later | From the cache with no new signal; then a second signal | Pass |
| VIDJ-04 | A company not in the pipeline | Listed, no signal | Pass |
| VIDJ-05 | Quota used up; then a rejected key | Views kept for later with their IPs; ipapi.is flagged in Setup | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WVIS-01 | Address headers | Platform header first; invalid values ignored | Pass |
| WVIS-02 | Origin headers | Host read; `null` and non-web origins refused | Pass |
| WVIS-03 | Beacon bodies | Path and referrer read; bad referrer dropped; absolute URLs, non-JSON and oversized bodies refused | Pass |
| WVIS-04 | GPC, Do Not Track and bot user agents | Not counted | Pass |
| WVIS-05 | Website hosts | Cleaned and de-duplicated; invalid and more than 10 refused | Pass |
| WVIS-06 | Snippet and script | Correct tag; the script checks GPC and DNT and uses no cookies or storage | Pass |
| WVIS-07 | Setup | ipapi.is an optional step, checked with the key in the body | Pass |

## Browser

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-20 | `/v.js`, and beacons to a well-formed and a malformed key, signed out; a GET | Script served with no cookie; 204 with no body and no cookie for both; 405 | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-60 | 33 migrations; three tables with row security and 3 policies; signed-in users read only the company summary; visitors read nothing; visitors may call only `visit_record`; nobody but the agent service may claim views; every existing workspace has a distinct, well-formed key; tracking off everywhere | **Pass** |
| LIVE-61 | Security advisor | **Pass**: new entries are `visit_record` (callable without signing in by design: the public site key only records views) and `workspace_rotate_site_key` (checks for owner or admin itself) |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-116 | Connect a free ipapi.is key, switch tracking on, add the script to a test site | Views accepted |
| ACC-117 | Visit from an office network of a company in a campaign | The company appears and a signal is raised |
| ACC-118 | Visit from a phone on mobile data | Nothing identified |
| ACC-119 | Visit with Global Privacy Control on (Brave, or the Firefox setting) | Nothing sent |
