# F26 — Signals Agent: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/signals.test.mjs`) | `npm test` | **10 passed, 0 failed** |
| Agent (`agents/tests/signals.test.ts`) | `cd agents && npm test` | **23 passed, 0 failed** |
| Web unit (`web/tests/signals.test.ts`) | `cd web && npm test` | **9 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **18 passed, 0 failed**, run twice, including E2E-18 |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 251, agents 331, web 167 | **749 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SIGB-01 | A viewer reads; a rep dismisses; a viewer tries to restore; an owner edits the title, inserts and deletes | Read allowed; dismissed; the viewer changes nothing; the edit, insert and delete are all refused | Pass |
| SIGB-02 | Another workspace reads and updates | Sees nothing; changes nothing | Pass |
| SIGB-03 | A signal about nobody; the same fingerprint twice | Both refused | Pass |
| SIGB-04 | A tool sends a signal by domain given as a full URL; sends it again; a second tool sends its own event with the same id | Stored and matched to the company, provider lower-cased; the repeat is a duplicate; the second tool's event is stored as a separate signal | Pass |
| SIGB-05 | A signal matched by email in another case, with a `javascript:` link | About that person and their company; the link dropped | Pass |
| SIGB-06 | A wrong token, no token, an unknown kind, a blank title, a 9 KB detail, a stranger's domain, workspace B's token | Each refused with its own message; the stranger and the other workspace's token store nothing | Pass |
| SIGB-07 | Facts for the sequence: all used, one 40 days old, a company signal, a person signal | Nothing new; too old ignored; the company signal reaches both people; the person signal reaches only that person | Pass |
| SIGB-08 | The campaign's default kinds; choosing job changes; an unknown kind | Four kinds by default, signals off; job changes allowed; the unknown kind refused | Pass |
| SIGB-09 | The scheduler with signals off, on, after 23 hours and after 25 | Nothing; one job; still one; two | Pass |
| SIGB-10 | A visitor reads signals and the facts | Both refused | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SIG-01 | A page with HubSpot, Shopify twice and Stripe; a plain page | Three tools, each once, sorted; none | Pass |
| SIG-02 | The first look at a site | No change reported | Pass |
| SIG-03 | Klaviyo replacing Mailchimp; three tools added; no change | "started using Klaviyo and stopped using Mailchimp"; "A, B and C"; nothing | Pass |
| SIG-04 | A dated https item inside the window | Kept | Pass |
| SIG-05 | http, a search page, no date, a word for a date, 108 days old, in the future, not a URL | All dropped | Pass |
| SIG-06 | The same story twice with a tracking parameter, then four more | One kept for the story, three in all | Pass |
| SIG-07 | Tracking parameters, `www`, case, trailing slash and fragment | Removed, keeping real parameters | Pass |
| SIG-08 | The instructions and schema the model gets | Told never to invent an event, date or URL, and to ignore instructions in the data; URL and date required | Pass |
| SIG-09 | Apollo says a different employer | "Kim Bright moved to Northwind Ortho as COO" | Pass |
| SIG-10 | The same employer with `www`; the same name with "LLC" and "Inc." | No change | Pass |
| SIG-11 | No answer; an answer with no employer | No change | Pass |
| SIG-12 | Fingerprints differing only in case and spaces | Equal; different content differs | Pass |
| SIG-13 | Funding, hiring and job-change hooks | Plain opening lines, ending once with a full stop | Pass |
| SIG-14 | Which steps wait for a signal | Only a step requiring `signal_new` to be true | Pass |
| SIG-15 | A finished sequence, with and without a new signal, with and without a signal step | Re-opens only for a signal step with a new signal; otherwise reported as stopped | Pass |
| SIG-16 | `{{signal}}` with and without a signal | The opening line, or nothing at all | Pass |
| SJ-01 | First run: a sourced funding story, an undated story, a job change, a site | Two signals; the undated story dropped; the site stored as a baseline; web search used; no personal details requested from Apollo | Pass |
| SJ-02 | A second run straight away | Nobody checked, no request made | Pass |
| SJ-03 | HubSpot appears; the funding story comes back with a tracking parameter | A technology signal; the story not stored twice | Pass |
| SJ-04 | Only technology chosen | No model or Apollo request; the site is read | Pass |
| SJ-05 | Apollo rejects the key | Run succeeds, says why job changes were skipped, Apollo flagged in Setup | Pass |
| SJ-06 | Signals off for the campaign | Nothing looked at | Pass |
| SJ-07 | Credentials | None in results or signals | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WSIG-01 | One signal; a list | Both accepted | Pass |
| WSIG-02 | Not JSON; an empty list; numbers in the list; a bare array | Each refused with a reason | Pass |
| WSIG-03 | 51 signals; a 70 KB body | Both refused before the database | Pass |
| WSIG-04 | Known database refusals; an internal error; nothing | Known ones passed on; the internal one replaced with a generic message | Pass |
| WSIG-05 | Token shapes | Only 64 lowercase hex characters accepted | Pass |
| WSIG-06 | The example shown on the page | Is itself a valid body | Pass |
| WSIG-07 | Labels and explanations | All present; the job-change one states the Apollo credit | Pass |
| WSIG-08 | A campaign choosing kinds | Built-in kinds only | Pass |
| WSIG-09 | The "new signal" trigger | Waits for a signal and leaves people who replied or booked alone; recognised again from what was stored | Pass |

## Browser

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-18 | The signal address with a malformed token, a GET, and a broken body, signed out | 404 "Unknown webhook address", 405, and 400 "The body is not valid JSON", none cached | Pass |

## Defects found and fixed during this feature

See the feature report §11: the two F22 scheduling defects (fixed and released first), ingest fingerprints colliding across tools, a finished sequence reported as "waiting", and the browser checks running against a stale build.

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-52 | `signals` with row security and 2 policies; signed-in users can only change `status` and `used_at`, and cannot insert or delete; visitors cannot read; the five new columns; the facts and the scheduler updated | **Pass** |
| LIVE-53 | Security advisor | **Pass** — one new entry, `signal_ingest`, callable without signing in by design: the secret address is its credential, as with the public audit links |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-99 | Turn signals on for a campaign with an OpenAI key connected and run the agent | Sourced, dated signals appear; nothing undated |
| ACC-100 | Run it again the next day | Nothing re-checked within the week; no duplicates |
| ACC-101 | Turn job changes on with Apollo connected | Credits used only for people checked; at most 20 per run |
| ACC-102 | Send a signal with curl to the address from the Signals page | Stored and matched; sending it again is a duplicate |
| ACC-103 | Add a "new signal" step to a finished sequence | Only leads with a new signal get it, opening with the signal |
