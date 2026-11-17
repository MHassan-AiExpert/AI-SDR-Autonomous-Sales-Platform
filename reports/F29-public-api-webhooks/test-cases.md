# F29 — Public API and Outbound Webhooks: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/public-api.test.mjs`) | `npm test` | **15 passed, 0 failed** |
| Agent (`agents/tests/webhooks-out.test.ts`) | `cd agents && npm test` | **8 passed, 0 failed** |
| Web unit (`web/tests/api.test.ts`) | `cd web && npm test` | **7 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **19 passed, 0 failed**, including E2E-19; E2E-03 now also covers the API page |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 275, agents 380, web 190 | **845 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| API-01 | Create keys as owner, admin, rep, viewer and another owner; read the hash; change scopes; bad scopes and names | Shown once and stored as a hash; reps, viewers and outsiders refused; the hash unreadable; scopes not editable; bad input refused | Pass |
| API-02 | A wrong, malformed, missing and revoked key; another owner revoking | All "Invalid API key"; the other owner refused | Pass |
| API-03 | A read key adding; a write key listing deals; an unknown action | 403-style scope errors; unknown action refused | Pass |
| API-04 | A lead with messy email, phone and domain; the same email; a suppressed domain; six invalid inputs; another workspace's campaign | Normalised, source api, company created; duplicate returns the lead; suppressed reported; each refused with its message | Pass |
| API-05 | Paging 5 leads 2 at a time; filters; another workspace's key; a hostile cursor; "yesterday"; a limit of 5000 | No repeats or gaps; filters apply; the other key sees nothing; refused; refused; capped | Pass |
| API-06 | Stage change; an unknown stage; do not contact; reopening | Recorded with the key's name; refused; email suppressed; reopening refused | Pass |
| API-07 | Deals, campaigns and meetings | Listed with their fields | Pass |
| API-08 | 121 requests in a minute; another key; a new minute | 121st refused; other key unaffected; allowed again | Pass |
| API-09 | Visitors on the three tables and the key and claim functions; an owner calling claim | All refused | Pass |
| WH-01 | Admin adds an endpoint; rep tries; read or change the secret; reveal and replace; rep and another owner reveal | Added; refused; unreadable; revealed and replaced; refused | Pass |
| WH-02 | http, another port, other schemes, spaces, 500+ characters, unknown or no events, an 11th endpoint | All refused | Pass |
| WH-03 | A lead created through the API, its stage changed, another field changed, a reply, a meeting, a deal won, an endpoint switched off, a workspace with no endpoints | Each event to the subscribed endpoints only, one event id across endpoints, previous stage included, no event for other fields, none for the switched-off endpoint or the other workspace | Pass |
| WH-04 | Claim, claim again, six failures with waits, a stuck "sending", a success | Claimed once; not due until the wait; dead after six; stuck one re-claimed after ten minutes; delivered resets failures | Pass |
| WH-05 | The 15th failure in a row; claiming afterwards; switching back on | Switched off with the reason; nothing claimed; count and reason cleared | Pass |
| WH-06 | History for owner and rep; editing history; deleting the endpoint | Owner only; refused; history removed with it | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WHO-01 | The signature | HMAC-SHA256 of `<t>.<body>`, in the documented header format | Pass |
| WHO-02 | A delivery | Signed POST of the stored event, event and delivery ids in headers, no redirects followed, secret not in headers | Pass |
| WHO-03 | Private address, http, port 8443, the metadata IP, localhost | Refused before any request | Pass |
| WHO-04 | 500, a redirect, a timeout, a refused connection | Each a failure with a short reason | Pass |
| WHO-05 | A stage change, then one job-loop cycle | Delivered within that cycle; the receiver can verify the signature with the revealed secret | Pass |
| WHO-06 | A 503, an immediate second cycle, then success after the wait | Pending with the error; nothing sent early; delivered on attempt 2 | Pass |
| WHO-07 | The 15th failure in a row | Endpoint switched off; one warning for the team linking to the API page | Pass |
| WHO-08 | An address resolving to a private network | Failure recorded, no request made | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WAPI-01 | Authorization headers | Only "Bearer sdr_<64 hex>" read | Pass |
| WAPI-02 | Every endpoint | The right action; only known query parameters; the path's id wins over the body's | Pass |
| WAPI-03 | Unknown paths, ids, nested paths, wrong methods | 404 or 405 before the database | Pass |
| WAPI-04 | Bodies | Empty, an object, an array, not JSON, over 16 KB handled | Pass |
| WAPI-05 | Database errors | 401, 403, 429, 404, 422 with safe messages; anything else a generic 500 | Pass |
| WAPI-06 | Key and endpoint forms | Valid ones accepted; bad scopes, addresses and events refused | Pass |
| WAPI-07 | The verification example | Constant-time comparison, five-minute window, the signed string | Pass |

## Browser

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-19 | `/api/v1/leads` with no key, a malformed key, and DELETE | 401 with the header to use, not cached, no CORS header; 401; 405 | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-58 | 32 migrations; three tables with row security and 6 policies; key hash and signing secret not readable by signed-in users; no visitor grants; visitors can call only `api_call`; signed-in users cannot claim deliveries; four event triggers | **Pass** |
| LIVE-59 | Security advisor | **Pass**: new entries are `api_call` (callable without signing in by design: the key is the credential, as with the signal address) and four functions for signed-in users that check for owner or admin themselves. The delivery functions are not listed: only the agent service can call them |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-112 | Create a key and `curl` `GET /api/v1/leads` | The workspace's leads |
| ACC-113 | Post a lead from a Zapier "Webhooks by Zapier" step | 201, lead visible in the app |
| ACC-114 | Add a webhook.site address, send a test event | Delivered; the signature verifies with the revealed secret |
| ACC-115 | Win a deal | `deal.won` arrives within a minute |
