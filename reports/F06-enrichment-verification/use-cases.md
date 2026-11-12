# F06 — Enrichment and Verification: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Start enrichment on demand, connect tools |
| Any member | Sees verification results on leads and campaigns |
| Agent service | Runs the enrichment agent and the daily schedule |
| Tools | Apollo, ZeroBounce, Twilio, and the companies' own websites |

## UC-F06-01 A business found without a contact gets one

| | |
| --- | --- |
| Preconditions | LLM search found "Bright Teeth" (brightteeth.com) with no email or phone |
| Main flow | 1. Sourcing finishes and hands over to enrichment. 2. Apollo finds Kim Bright, Practice Owner, still at brightteeth.com. 3. Kim becomes a lead linked to Bright Teeth, tagged LLM search, with the query "Apollo decision maker at brightteeth.com". 4. Bright Teeth is marked enriched. |
| Alternatives | 2a. Apollo has no one or is not connected: the website's contact page gives hello@quietclinic.com and a phone, which become the lead. 2b. Nothing anywhere: the company is marked "no contact found" and not retried. |

## UC-F06-02 Every email is checked before outreach

| | |
| --- | --- |
| Preconditions | ZeroBounce connected, email channel on |
| Main flow | Each new email is checked; the lead shows Verified, Invalid, Catch-all or Risky, and its timeline says "Email checked: invalid (invalid)". |
| Result | Outreach later sends only to verified addresses. |

## UC-F06-03 Phones are ready for calls and SMS

| | |
| --- | --- |
| Preconditions | Twilio connected; calls, SMS or WhatsApp on |
| Main flow | Each phone is looked up; the lead shows "+15125550101 · Mobile, US". Landlines are recognised so SMS is not sent to them later. |

## UC-F06-04 Run enrichment now

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Presses "Enrich and verify" on the campaign. Within a minute Agent activity reports what was found and checked. |
| Alternatives | Already running: "The agent is already working on this." |

## UC-F06-05 Campaigns run themselves every day

| | |
| --- | --- |
| Main flow | Each active campaign gets a sourcing run and an enrichment run every 24 hours with no clicks. Paused campaigns, draft campaigns and paused workspaces get none. |

## UC-F06-06 A tool runs out of credits

| | |
| --- | --- |
| Main flow | ZeroBounce reports no credits. Verification stops, the run still finishes, Setup shows ZeroBounce in error with "ZeroBounce reports the account is out of credits or needs a plan upgrade", and the emails are checked on the next run once credits are added. |

## UC-F06-07 A company has not connected the tools yet

| | |
| --- | --- |
| Main flow | The run still reads company websites and reports "Connect ZeroBounce to verify emails before any email is sent" and "Connect Twilio to check phone line types before calls and SMS." Nothing is marked as checked. |

## UC-F06-08 Cold email only

| | |
| --- | --- |
| Preconditions | Calls, SMS and WhatsApp switched off in Settings |
| Main flow | Emails are verified; no phone lookups are made and no Twilio cost is incurred. |

## UC-F06-09 The daily limit is reached during enrichment

| | |
| --- | --- |
| Main flow | Limit 2, three companies with contacts found. The first two in found order become leads; the third company stays pending and is picked up the next day. |

## UC-F06-10 Filter leads by email check

| | |
| --- | --- |
| Actor | Any member |
| Main flow | Opens Leads, chooses "Verified" in Email check, and sees only safe-to-email leads; the link keeps the filter. |

## UC-F06-11 A hostile domain in scraped data

| | |
| --- | --- |
| Main flow | A scraped record's website resolves to an internal address or redirects to one. The reader refuses the request; no internal service is ever contacted. |
