# F28 — Salesforce and Pipedrive

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| | |
| --- | --- |
| Feature ID | F28 |
| SRS reference | M9 (CRM sync), M23 (integrations) |
| Location | `supabase/migrations/20261117050000_crm_providers.sql`, `agents/src/crm.ts`, `agents/src/sources/pipedrive.ts`, `agents/src/sources/salesforce.ts`, `agents/src/store.ts`, `agents/src/http.ts`, `web/src/lib/crm.ts`, `web/src/lib/integrations.ts`, `web/src/lib/connection-tests.ts`, `web/src/app/w/[workspaceId]/settings/page.tsx` |
| Automated tests | 2 new database (and CRM-04 updated), 19 agent, 8 web unit: **29 passed, 0 failed**. The 16 HubSpot agent tests and 6 CRM web tests from F18 still pass unchanged in what they check |
| Live checks | Passed: migration applied to the hosted database and verified in place (LIVE-56, LIVE-57) |

## 1. Summary

CRM sync (F18) sent leads, deals and activity to HubSpot. A workspace now chooses **one CRM: HubSpot, Pipedrive or Salesforce**. The same hourly job does the same four things for each:

1. Reads back deals **won or lost in the CRM** and closes them here, before anything is pushed.
2. Sends contacts, **matched by email**, only when what would be sent changed.
3. Sends deals, linked to the contact, created once and updated after that.
4. Logs replies, meetings and calls on the contact, once each.

## 2. One sync, three small clients

F18's sync was written against HubSpot directly. It was split into the sync itself, which is shared, and a **client per CRM** with seven operations: build a contact, save contacts, build a deal, create it, update it, read outcomes, log an activity. Each client builds its own payloads, and those payloads are what is fingerprinted, so "unchanged" means unchanged *for that CRM*.

HubSpot's client produces exactly the payloads F18 produced, so existing HubSpot workspaces see no resend: their fingerprints still match.

| | HubSpot | Pipedrive | Salesforce |
| --- | --- | --- | --- |
| Contact | Contact, batch upsert by email | Person: exact email search, then update or create | Contact: SOQL by email, then sObject Collections update or create |
| Deal | Deal in the chosen pipeline and stage | Deal in the chosen pipeline and stage; **won and lost are the deal status** | Opportunity with a stage name, plus a primary **contact role** |
| Activity | Note (HTML) | Note (HTML) | **Completed task** (plain text) |
| Won or lost read back | The deal's stage against the mapped won and lost stages | The deal's status | `IsWon` and `IsClosed`, which follow the org's own stage settings |
| Sign-in | Private app token | API token in the `x-api-token` header | OAuth 2.0 client credentials flow on the org's My Domain |

## 3. Verified against each provider first

As with Instantly (F22) and Apollo (F26), no endpoint was assumed.

**Pipedrive.** Endpoint paths, field names and the authentication header were read from **Pipedrive's official Node.js client, generated from its OpenAPI specification**:

- **API v2** at `https://api.pipedrive.com/api/v2`: `POST /persons` and `PATCH /persons/{id}` (`name`, `emails[{value, primary, label}]`, `phones`, `job_title`), and `GET /persons/search` (`term`, `fields=email`, `exact_match`; results at `data.items[].item` with `emails`).
- **Deals:** `POST` and `PATCH /deals` (`title`, `person_id`, `value`, `currency`, `pipeline_id`, `stage_id`, `status`). `GET /deals?ids=` takes up to 100 ids, and `status` is open, won, lost or deleted.
- **API v1** at `https://api.pipedrive.com/v1`: `POST /notes` (`content`, `person_id`, `add_time`), and `GET /users/me` for the connection check.
- **Authentication:** both versions take the `x-api-token` header, so the token never appears in a URL.

**Salesforce.** Taken from Salesforce's developer documentation:

- **Token:** `POST https://{MyDomain}.my.salesforce.com/services/oauth2/token` with `grant_type=client_credentials`, `client_id` and `client_secret`. The response has `access_token` and `instance_url`, and no refresh token is issued, so a token is requested each run. Only the My Domain host serves this endpoint, not the Lightning host.
- **sObject Collections** (`/composite/sobjects`): up to 200 records per request, `allOrNone` defaulting to false, and results returned in request order with `id`, `success` and `errors[{statusCode, message}]`.
- **Single updates:** a `PATCH` to `/sobjects/{type}/{id}` returns no body.
- **Opportunity:** `Name` and `CloseDate` are required; `IsWon` and `IsClosed` are read-only and follow the stage. `OpportunityStage` carries those two flags per stage.

## 4. Decisions

**Salesforce signs in server to server.** The client credentials flow needs no user password and no browser redirect. The team creates an external client app or connected app with the flow enabled and a run-as user, then gives the platform the My Domain, the consumer key and the consumer secret. The agent only ever calls that My Domain host: the field accepts nothing else (`acme.my.salesforce.com`, or a sandbox such as `acme--uat.sandbox.my.salesforce.com`), and the agent checks it again before any request.

**Salesforce outcomes come from `IsWon` and `IsClosed`, not from stage names.** Orgs rename stages; the two flags always follow the org's own settings. The stage map is only used to *send* a stage.

**An open opportunity has no close date in its payload.** Salesforce requires one on create, so a date 30 days out is added at creation only. Leaving it out of the fingerprinted payload stops an open opportunity from being re-sent every day as "today + 30" moved on.

**A failed contact role never makes a second opportunity.** The opportunity's id is saved even if the contact role is refused (for example by an org validation rule); the failure is logged.

**Pipedrive updates leave a person's emails alone.** The person was found by that email; sending the list again would remove addresses a rep added in Pipedrive.

**A Pipedrive search hit is double-checked.** `exact_match` is Pipedrive's own matching; the returned addresses are compared again before the person is used, so a near match is never updated.

**SOQL is built from escaped literals.** Emails and ids are validated, then quoted with backslashes and quotes escaped, so data cannot change a query.

**Links are kept per CRM.** Switching CRM starts the new one clean, keeps the old links for a switch back, and never points a new record at another system's id. The settings form resets the pipeline and stages to the new CRM's defaults when the CRM changes, rather than rejecting the old CRM's values.

## 5. Stage mapping

| Our stage | HubSpot default | Pipedrive | Salesforce default |
| --- | --- | --- | --- |
| Meeting booked | `appointmentscheduled` | Stage number, or the pipeline's first stage | Qualification |
| Meeting held | `presentationscheduled` | Stage number | Needs Analysis |
| Proposal sent | `contractsent` | Stage number | Proposal/Price Quote |
| Negotiation | `decisionmakerboughtin` | Stage number | Negotiation/Review |
| Won | `closedwon` | Deal status `won` | Closed Won |
| Lost | `closedlost` | Deal status `lost` | Closed Lost |

## 6. Database changes

| Change | Purpose |
| --- | --- |
| `workspaces.crm_provider` | hubspot (default, so existing workspaces are unchanged), pipedrive or salesforce |
| `integrations` tools | `pipedrive` and `salesforce` may be connected |
| `crm_links.provider` | Now any of the three |
| `crm_links.external_id` | Letters and digits, up to 30, for Salesforce's 15- and 18-character ids |

## 7. Screens

| Screen | Change |
| --- | --- |
| Setup | Pipedrive (API token) and Salesforce (My Domain, consumer key, consumer secret) under External CRM, each checked live before saving |
| Settings → CRM sync | Choice of CRM; counts, help and stage fields follow the chosen CRM; Pipedrive shows no won or lost stage; Salesforce shows no pipeline |
| Task history | Results name the CRM: "Pipedrive is up to date." |

## 8. Defects found and fixed during this feature

| Defect | How it was found | Fix |
| --- | --- | --- |
| An open Salesforce opportunity would have been updated every day, its required close date moving with the calendar | Design review of the fingerprint | The close date is added at creation only |
| Switching CRM would have rejected the form, because the page still held the old CRM's stage ids | WCRP-03 | The form resets the pipeline and stages when the CRM changes |
| F18's "Sync now" and campaign notices named HubSpot whatever the CRM | Search for HubSpot-specific text | They name the chosen CRM |

## 9. Limits of this feature

- Salesforce contacts are created without an account. Orgs that require one on every contact (a validation rule) will refuse them; the refusals are logged and the rest continue.
- Salesforce amounts are sent without a currency. Multi-currency orgs use the run-as user's currency.
- Salesforce tasks use the standard `Completed` status; an org that removed it from the picklist will refuse them.
- Pipedrive has no bulk upsert: each person costs a search and a write, so at most 200 per run (the existing limit) keeps within its rate limits.
