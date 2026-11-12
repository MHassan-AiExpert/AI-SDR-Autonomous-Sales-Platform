# F05 — Lead Sourcing: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database: job queue (`tests/db/agent-jobs.test.mjs`) | `npm run test:db` | **15 passed, 0 failed** |
| Agent service (`agents/tests/*.test.ts`) | `cd agents && npm test` | **55 passed, 0 failed** |
| Web unit (`web/tests/campaigns.test.ts`) | `cd web && npm test` | **8 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-15 to INF-21) | `npm run test:infra` | **7 passed, 0 failed** (INF-01, 04, 09 and 13 updated for the new services) |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (campaign and lead pages added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 106, agents 55, web 56 | **217 passed, 0 failed** |

The pipeline tests run the agent service's own database client against the real migrations (PGlite served over the Postgres protocol). Every third-party API is replaced by a recorded fake, so the tests check exactly what is sent to each provider.

## Database: job queue

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| JOB-01 | Owner and admin queue jobs | Job queued and recorded as requested by them | Pass |
| JOB-02 | Queue the same work twice | Second insert rejected while the first is queued or running | Pass |
| JOB-03 | Rep, viewer, another company and an anonymous visitor queue a job | All refused | Pass |
| JOB-04 | Client inserts a job marked succeeded, with a result, or for another user | Refused | Pass |
| JOB-05 | Job pointing at another company's campaign | Rejected by the composite foreign key | Pass |
| JOB-06 | Client updates or deletes a job | Permission denied | Pass |
| JOB-07 | Members and outsiders list jobs | Members see their company's jobs; others see none | Pass |
| JOB-08 | Signed-in user calls claim or finish | Permission denied; only the backend may | Pass |
| JOB-09 | Two claims in a row | Jobs marked running, attempt counted, never handed out twice | Pass |
| JOB-10 | Several queued jobs | Claimed oldest first | Pass |
| JOB-11 | Finish a job, then finish it again | Result stored once; second call changes nothing | Pass |
| JOB-12 | Queue again after a job finished | Allowed | Pass |
| JOB-13 | Job left running past the timeout | Re-queued; after 3 attempts marked failed with a message | Pass |
| JOB-14 | Workspace paused with a sourcing and a planning job queued | Only planning is claimed | Pass |
| JOB-15 | New campaign | `source_plan` defaults to empty and is stored per campaign | Pass |

## Agent service: normalisation and de-duplication

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| NRM-01 | Mixed-case, `mailto:` and junk emails | Lower-cased; noreply, example, image-name and malformed addresses dropped | Pass |
| NRM-02 | Instagram bio with two spellings of one email | One lower-cased email extracted | Pass |
| NRM-03 | US, `00`-prefixed, dotted, too short and too long phones | `+15125550182`, `+442079460958`, `5125550182`; short and long rejected | Pass |
| NRM-04 | Websites, Instagram, Linktree, Facebook, WhatsApp links | Own site reduced to a domain; profile and link pages ignored | Pass |
| NRM-05 | Instagram handles and URLs, LinkedIn profile and company links | One handle form; profile URL normalised; company page rejected; text trimmed | Pass |
| DED-01 | Raw candidate | Every field normalised, rating rounded to one decimal | Pass |
| DED-02 | Candidates with and without contacts | Only those with email, phone, LinkedIn or a handle count as leads | Pass |
| DED-03 | Batch with repeated email (case), phone (format), handle (with @) | 3 duplicates removed; a named person at the same domain kept; shared keys catch a later source too | Pass |
| DED-04 | Candidate already stored | Treated as a duplicate | Pass |
| DED-05 | Suppressed email, email domain, phone and company domain | All blocked; an unrelated lead allowed | Pass |

## Agent service: language models

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| LLM-01 | Plain, fenced and wrapped JSON answers | Parsed; non-JSON rejected | Pass |
| LLM-02 | OpenAI call | Responses API, web search tool, strict JSON schema, bearer key; text read from the message output | Pass |
| LLM-03 | Anthropic call | Web search tool, `x-api-key`; final text block read after search steps | Pass |
| LLM-04 | Gemini call | Google Search grounding when searching, JSON mode otherwise; model in the URL | Pass |
| LLM-05 | Clients from connected keys | Only connected providers; Anthropic only with a model id set | Pass |
| LLM-06 | OpenAI rate-limited, Gemini answers | Fails over to Gemini | Pass |
| LLM-07 | Every provider rejects its key | One error naming each provider; no key in the message; no providers gives a setup hint | Pass |

## Agent service: setup agent

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| PLN-01 | Model chooses its own locations | Replaced by the target areas everywhere | Pass |
| PLN-02 | Repeated terms, bad employee range, invalid hashtags | Removed; first spelling kept | Pass |
| PLN-03 | No tools, Apify only, Gemini only | Sources follow connected tools | Pass |
| PLN-04 | Model switched Apollo off | Stays off even with Apollo connected | Pass |
| PLN-05 | No target areas; no locations at all | Model locations used; Google Maps off without any | Pass |
| PLN-06 | Answers that break the schema | Rejected | Pass |
| PLN-07 | Strict JSON schema | Every object closed and every property required; prompt contains niche and areas | Pass |

## Agent service: lead sources (network faked)

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SRC-01 | Apollo search URL | Titles, locations, ranges, keywords, page and page size as query parameters | Pass |
| SRC-02 | 12 people found, limit 12 | Enriched in calls of 10 and 2; 12 leads with company data; credits reported | Pass |
| SRC-03 | Apollo rejects the key | Error with status 401 and a plain message, no key | Pass |
| SRC-10 | Short page with a repeated person | One search call; each person enriched once | Pass |
| SRC-04 | Google Maps with two areas | One actor run per area with contact scraping and closed places skipped; bearer token; limit respected | Pass |
| SRC-05 | One place | Email, phone, Instagram, domain, category, address, rating, reviews and Maps link | Pass |
| SRC-06 | Hashtag posts from a business and a personal account | Profiles looked up once per handle; business kept with bio email; personal skipped | Pass |
| SRC-07 | No posts | No profile lookup | Pass |
| SRC-08 | Two models, one returns 12 companies | Web search on; at most 10 per model; emails only when given | Pass |
| SRC-09 | One model fails; all models fail | Others continue with a note; all failing is an error | Pass |

## Agent service: end-to-end pipeline

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| PIPE-01 | Planning job | Plan saved with target areas; result names the provider and sources; run log success | Pass |
| PIPE-02 | Planning with no language model connected | Job failed with "Connect OpenAI, Anthropic or Gemini in Setup…" | Pass |
| PIPE-03 | Sourcing job on all four sources | 5 leads with correct channels, company, rating, title, query, handle and a timeline entry | Pass |
| PIPE-04 | Result of that run | Per-source found, added, duplicates, no-contact and credits; company-only record for a business without contacts | Pass |
| PIPE-05 | Same run again | Nothing added; all duplicates; no duplicate company | Pass |
| PIPE-06 | Suppressed email and customer domain | Neither stored; counted as suppressed | Pass |
| PIPE-07 | Daily limit 3 | 3 leads; next run reports the limit reached | Pass |
| PIPE-08 | Apify rejects the token | Job succeeds with Apollo leads; Google Maps error reported; Apify flagged in Setup | Pass |
| PIPE-09 | Every source down | Job failed naming each source; run log error | Pass |
| PIPE-10 | Second company runs the same niche | Only its own Apify key used; its own copy of the clinic; neither company sees the other's leads | Pass |
| PIPE-11 | Kill switch on | Planning runs, sourcing waits, then runs after resume | Pass |
| PIPE-12 | A broken job before a good one | Broken job failed with a message; good job still succeeds | Pass |
| PIPE-13 | Results, run logs and timeline after all runs | No credential anywhere | Pass |

## Agent service: HTTP and configuration

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| SRV-01 | Signatures | Valid accepted; changed body, wrong secret, expired, missing or malformed rejected | Pass |
| SRV-02 | Unsigned, wrong and 10-minute-old requests | 401; no jobs claimed | Pass |
| SRV-03 | Signed request | 200 with job outcomes | Pass |
| SRV-04 | Two signed requests at once | One runs, one gets 202 busy | Pass |
| SRV-05 | Health with database up and down; unknown path | 200, 503, 404 | Pass |
| SRV-06 | 20 KB body | 413 | Pass |
| SRV-07 | Request signed by the n8n workflow's own code | Accepted by the service | Pass |
| CFG-01 | Missing database URL, short secret, large jobs-per-run | Clear errors; limit clamped to 20; model defaults | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CMP-01 | Valid campaign form with repeated areas | Areas split by line or semicolon, de-duplicated | Pass |
| CMP-02 | Missing niche, no areas, 11 areas, limits 0, 5000 and 2.5 | Clear message for each | Pass |
| CMP-03 | "Find leads right away" unticked | Plan only | Pass |
| CMP-04 | Known and unknown filter values | Known kept; unknown, injected and negative ignored | Pass |
| CMP-05 | Search text with commas, brackets, wildcards and quotes | Neutralised so it cannot change the filter | Pass |
| CMP-06 | Filters to links | Round-trip into query strings for paging | Pass |
| CMP-07 | Job results | One readable line per run; unknown sources ignored | Pass |
| CMP-08 | Saved source plan | One row per source with its detail | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-15 | Agent service in Compose | Built from `agents/`, no published port, internal network, scalable, health check | Pass |
| INF-16 | Shared settings | Same signing secret as n8n; n8n has the service URL and may use `crypto` | Pass |
| INF-17 | Dockerfile | Pinned Node image, non-root user, production dependencies only, runs the source directly | Pass |
| INF-18 | Scheduler workflow | Every minute, HMAC over `timestamp.body`, POST to `/jobs/run` with the three headers, successful runs not stored | Pass |
| INF-19 | Workflow import job | Same n8n image and database, workflows mounted read-only, runs once, n8n waits for it to finish | Pass |
| INF-20 | Workflows in the repository | All valid, each with a fixed unique 16-character id; active ones published | Pass |
| INF-21 | Importer with bad and mixed files | Duplicate ids, short ids, missing name, empty nodes and non-boolean active rejected; only active workflows published; non-JSON ignored | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-11 | `agent_jobs` has row-level security and 2 policies; `source_plan` column exists; claim and finish are callable by the backend only (not anonymous or signed-in users); claim runs and finds an empty queue | Pass (inside a rolled-back block) |
| LIVE-12 | Security advisor after the migration | No new findings; only the 4 intended signed-in functions from F03 and F04 | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-19 | Connect OpenAI and Apify, create "Austin dentists" with one area | Within two minutes the plan shows Google Maps and LLM search on, and leads appear with ratings |
| ACC-20 | Connect Apollo, re-plan, Find leads now | Apollo leads with names and titles; Agent activity reports the Apollo count and no duplicates of earlier leads |
| ACC-21 | Add a found lead's email to suppressions, run again | That lead is not added again and the run counts one suppressed |
| ACC-22 | Pause outreach, press Find leads now, wait two minutes, resume | Run stays queued while paused, completes after resume |
| ACC-23 | Leads page: filter by Google Maps, search a clinic name, open page 2, copy the link to a private window | Same filtered list after sign-in |
