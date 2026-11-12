# F04 — Guided Onboarding: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/integrations.test.mjs`) | `npm run test:db` | **18 passed, 0 failed** |
| Unit: catalog and plan (`web/tests/integrations.test.ts`) | `cd web && npm test` | **16 passed, 0 failed** |
| Unit: connection tests (`web/tests/connection-tests.test.ts`) | `cd web && npm test` | **10 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (Setup page added to E2E-03) |
| Build and type check | `npm run build`, `npm run typecheck` | Passed |

The database tests run against a stand-in vault with the same functions and permissions as Supabase Vault; the live checks below confirm the real one.

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INT-01 | Owner connects OpenAI | Status connected, check time set, hint stored; key absent from the table; service role reads it back | Pass |
| INT-02 | Admin connects Slack; rep, viewer, another company and an outsider try Twilio | Admin succeeds; all others refused; no Twilio row | Pass |
| INT-03 | Reconnect OpenAI with a new key | New key stored; one row and one vault entry | Pass |
| INT-04 | Two companies connect OpenAI | Each reads back only its own key | Pass |
| INT-05 | Owner, admin and another owner read the secret function, decrypted view and vault table | Permission denied on all | Pass |
| INT-06 | Anonymous visitor calls the four functions | Permission denied on all | Pass |
| INT-07 | Owner inserts, updates (re-pointing `secret_ref`) and deletes integration rows directly | Permission denied | Pass |
| INT-08 | Viewer and outsider list integrations | Viewer sees the company's two tools; outsider sees none | Pass |
| INT-09 | Store a failed test result | Status error with its message | Pass |
| INT-10 | Store credits reported by the tool | Credits saved | Pass |
| INT-11 | Unknown tool, empty credentials, 9,000-character credentials, status "disconnected" | Each rejected; no vault entries left behind | Pass |
| INT-12 | Admin disconnects Slack | Row disconnected, reference cleared, secret deleted from the vault | Pass |
| INT-13 | Rep and another company try to disconnect OpenAI | Refused; key still stored | Pass |
| INT-14 | Backend records expired then connected; owner tries the health function | Status, message and credits updated then cleared; owner refused | Pass |
| INT-15 | Health check reports a disconnected tool as connected | Stays disconnected | Pass |
| INT-16 | Audit log after connect and disconnect | Both recorded; no secret in the log | Pass |
| INT-17 | Delete a workspace | All of its vault entries removed; other company's kept | Pass |
| INT-18 | Admin ticks a checklist step; rep tries to clear it | Admin saved; rep affects zero rows | Pass |

## Unit: catalog, credential form and plan

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| ONB-01 | Compare the app's tool list with the database constraint | Identical | Pass |
| ONB-02 | Each tool's name, docs link and fields | Complete; HTTPS docs; at least one secret field | Pass |
| ONB-03 | Known and unknown tool ids | Unknown rejected | Pass |
| ONB-04 | Twilio form | Both values to the vault; SID and masked token hint to metadata; token not in metadata | Pass |
| ONB-05 | Key with surrounding spaces | Trimmed | Pass |
| ONB-06 | Missing key; bad Twilio SID, Slack user token, Stripe publishable key, WhatsApp ID, key with spaces | Each rejected with the field named | Pass |
| ONB-07 | Identifiers containing `/`, `?`, `#`, `@` | Rejected | Pass |
| ONB-08 | Masking long and short secrets | `•••• abcd` and `••••` | Pass |
| ONB-09 | All core channels and AI closer on | 12 required tool steps and 4 manual steps; 0% | Pass |
| ONB-10 | Each of three models; Apify alone | Each completes its step | Pass |
| ONB-11 | Models with error and expired status | Step not done | Pass |
| ONB-12 | Email only, AI closer off | 7 required steps; domain and warm-up only | Pass |
| ONB-13 | Email only, AI closer on | Voice agent, agreements, payments required; phone numbers not | Pass |
| ONB-14 | External CRM | Always optional | Pass |
| ONB-15 | All tools connected, checklist empty; then checklist done | 75% and not ready; then 100% and ready | Pass |
| ONB-16 | Checklist values "yes" and 1 | Not counted | Pass |

## Unit: connection tests (network mocked)

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CT-01 | All 16 tools with an accepting service | Pass | Pass |
| CT-02 | Address of every request | HTTPS, the tool's own domain, redirects refused, timeout set | Pass |
| CT-03 | Where secrets travel | Headers only; never in the address except ZeroBounce | Pass |
| CT-04 | Zoom and Twilio requests | Zoom POST with Basic client credentials; Twilio GET with Basic | Pass |
| CT-05 | 401 and 403 for all 16 tools | "rejected these credentials"; no secret in any message | Pass |
| CT-06 | 404, 429, 503 | Account not found; rate limited; service error with code | Pass |
| CT-07 | Network failure and timeout | Clear message, no crash | Pass |
| CT-08 | Slack `ok: false`, ZeroBounce credits -1, Apollo not logged in, Twilio suspended, Slack HTML body | Each reported as failed | Pass |
| CT-09 | Details returned | ZeroBounce credits, Slack team, WhatsApp number | Pass |
| CT-10 | Probe coverage | One probe per tool | Pass |

## Live checks on the hosted database

| ID | Check (inside a rolled-back transaction) | Expected result | Actual |
| --- | --- | --- | --- |
| LIVE-06 | Owner connects OpenAI; service role reads it back | Same key returned | Pass |
| LIVE-07 | Search the integrations row and the raw vault value for the key | Not in the row; vault value encrypted | Pass |
| LIVE-08 | Owner calls the secret function; another company calls connect on this workspace | Both refused | Pass |
| LIVE-09 | Owner disconnects; service role reads; count vault entries | Nothing returned; zero entries | Pass |
| LIVE-10 | Supabase security advisor | Only the expected definer-function notices for connect and disconnect; none for the secret function | Pass |

## Acceptance walkthrough (real accounts)

| ID | Step | Expected result |
| --- | --- | --- |
| ACC-11 | Open a new workspace | Overview shows "Finish setup: 0% complete" |
| ACC-12 | Setup: connect OpenAI with a real key | "OpenAI is connected."; masked key and check time shown |
| ACC-13 | Connect OpenAI with a wrong key | "OpenAI rejected these credentials."; nothing saved |
| ACC-14 | Connect Slack with a real bot token | Connected; Slack workspace name shown |
| ACC-15 | Settings: email only, AI closer off; reopen Setup | Twilio, Vapi, WhatsApp, PandaDoc, Stripe listed as not needed |
| ACC-16 | Tick sending domains and warm-up, save | Progress increases |
| ACC-17 | Disconnect Slack | Not connected; alerts step back to Required |
| ACC-18 | Sign in as a rep and open Setup | Statuses visible; no forms |
