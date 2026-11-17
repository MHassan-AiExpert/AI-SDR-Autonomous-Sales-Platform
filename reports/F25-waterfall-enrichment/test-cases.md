# F25 — Waterfall Enrichment: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/waterfall.test.mjs`) | `npm test` | **9 passed, 0 failed** |
| Agent (`agents/tests/waterfall.test.ts`) | `cd agents && npm test` | **13 passed, 0 failed** |
| Web unit (`web/tests/enrichment.test.ts`) | `cd web && npm test` | **7 passed, 0 failed** |
| Type checks | `npx tsc --noEmit` in `agents` and `web` | Passed |
| Full regression | agents 305, web 158, database 234 | **All passed.** Six infrastructure tests (INF-12, 13, 20, 24, 25, 26) fail on Windows only, because they build paths from `URL.pathname` (`D:\D:\…`). They are unrelated to this feature and are unchanged by it |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WFD-01 | A new workspace's order | Apollo, Hunter, People Data Labs | Pass |
| WFD-02 | An admin reorders; a rep tries to | The admin's order is saved; the rep's update matches no rows | Pass |
| WFD-03 | Orders with a repeated provider, an unknown one, four entries; an empty order | The first three refused by the check constraint; the empty one (websites only) allowed | Pass |
| WFD-04 | Connecting Hunter and People Data Labs | Both connected, through the same vault function as every other tool | Pass |
| WFD-05 | A lead with a provider outside the list | Refused | Pass |
| WFD-06 | An owner writes an attempt; a viewer and another workspace read | The write is refused; the viewer sees only their workspace; the other workspace sees nothing | Pass |
| WFD-07 | "found" with no contacts, "no_match" with contacts, an attempt pointing at another workspace's company | All refused | Pass |
| WFD-08 | Stats over found, no-match, error and website attempts | Errors counted apart, not as attempts; match rate 50% for 1 of 2; another workspace gets no rows | Pass |
| WFD-09 | Deleting a company | Its attempts stay, with no company, so past match rates do not change | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WF-01 | Five companies: one each for Apollo, Hunter, People Data Labs and the website, one for nobody | Each lead found by the first provider that has someone, with its provider and source line; the fifth company marked no contact found | Pass |
| WF-02 | Which domains later providers were asked about | Hunter: the four Apollo missed. People Data Labs: the three both missed, in one request | Pass |
| WF-03 | Hunter returns a confident intern and a less confident owner | Only the owner is saved | Pass |
| WF-04 | Attempts and stats after the run | 14 attempts; match rates Apollo 20%, Hunter 25%, People Data Labs 33.3%, website 50%, read by a rep | Pass |
| WF-05 | The job result | Tried, found and credits per provider; 4 leads added, 1 company with no contact | Pass |
| WF-06 | Where the keys go | Hunter and People Data Labs keys only in headers; no key in any URL or job result | Pass |
| WF-07 | Apollo finds a named person without an email | Hunter's Email Finder supplies it; the lead stays Apollo's, with "(email from Hunter)"; Hunter's Domain Search is not called | Pass |
| WF-08 | Order set to People Data Labs, then Hunter | Apollo's people search is never called; People Data Labs is asked before Hunter; the lead is Hunter's | Pass |
| WF-09 | Hunter returns 500 for everything | People Data Labs still finds one company; the company nobody found stays pending; Hunter is not flagged as broken | Pass |
| WF-10 | Apollo refuses its key | Apollo is flagged on the setup screen, the error is named in the result, and the website still finds the contact | Pass |
| WF-11 | People Data Labs on a free plan | Nothing saved from it; the run notes say a Pro plan is needed | Pass |
| WF-12 | Hunter ranking | A requested title, then a decision maker, then an executive; anyone else dropped | Pass |
| WF-13 | People Data Labs query | Filters by company website and needs a senior level or a requested title | Pass |

Existing enrichment tests EN-01 to EN-13 pass unchanged, except EN-09, whose note now names all three providers.

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WFW-01 | Positions with a gap; no positions | Read in order with the gap skipped; empty order allowed | Pass |
| WFW-02 | A provider chosen twice; an unknown one | Refused, naming the provider | Pass |
| WFW-03 | A saved order with junk; the sentence | Junk dropped; only connected providers are named | Pass |
| WFW-04 | Stats rows as Postgres strings; a provider never asked | Numbers; "Not asked yet" | Pass |
| WFW-05 | The onboarding plan | An optional "More contact finders" step, done once either tool is connected | Pass |
| WFW-06 | Hunter's connection test | Key in the X-API-KEY header; credits left read from the account | Pass |
| WFW-07 | People Data Labs' connection test | 404 from a search built to match no one proves the key; 401 refused; 402 out of credits | Pass |

CT-01 to CT-03 and ONB-01 now cover the two new tools as well.

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-49 | Migration applied; `enrichment_attempts` has row security; the stats function is `security invoker`; a visitor is refused | **Pass** — also verified: signed-in users cannot edit attempts, both new columns exist, the tool list keeps all 16 earlier tools plus `hunter` and `pdl`, and the security advisor reports nothing new |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-96 | Connect Hunter; run enrichment on a campaign with companies Apollo cannot match | New leads marked Hunter; Settings shows Hunter's match rate |
| ACC-97 | Put Hunter first, then run again on fresh companies | Hunter is asked first; Apollo only about the rest |
| ACC-98 | Connect a free People Data Labs key | The connection test passes without spending a credit; the run note explains the plan limit |
