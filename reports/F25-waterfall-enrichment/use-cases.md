# F25 — Waterfall Enrichment: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Connect contact providers and choose their order |
| Rep, Viewer | See the order and each provider's match rate |
| Enrichment agent | Runs the chain for companies found without a contact |

## UC-F25-01 Reach companies Apollo does not know

| | |
| --- | --- |
| Actor | Owner |
| Trigger | LLM search found 40 dental clinics; Apollo has people at only 15 of them |
| Main flow | 1. Setup, More contact finders. 2. Connects Hunter; the key is tested before it is saved. 3. The next enrichment run asks Hunter about the 25 Apollo missed. |
| Result | More clinics get a named contact. Each lead says which provider found it |

## UC-F25-02 Put the best provider first

| | |
| --- | --- |
| Actor | Admin |
| Trigger | After a month, the Settings table shows Hunter matching more companies than Apollo in this niche |
| Main flow | 1. Settings, Contact finders. 2. Sets Hunter first, then Apollo. 3. Save order. |
| Result | "Contact finder order saved. The next enrichment run uses it." The sentence above the form now reads "The agent asks Hunter, then Apollo, then reads the company website…" |

## UC-F25-03 Stop paying for a provider

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Sets the People Data Labs position to "Nobody" and saves. |
| Result | The provider is never asked again, even though it stays connected |

## UC-F25-04 A named person with no email

| | |
| --- | --- |
| Actor | Enrichment agent |
| Trigger | Apollo knows the practice owner's name and LinkedIn, but not their address |
| Main flow | The agent asks Hunter's Email Finder for that person's work address at the company domain. |
| Result | The lead is saved with the email. Its source line reads "Apollo decision maker at … (email from Hunter)" |

## UC-F25-05 A provider is down

| | |
| --- | --- |
| Actor | Enrichment agent |
| Trigger | Hunter returns server errors all morning |
| Main flow | The companies Hunter failed on go on down the chain to People Data Labs and the website. |
| Result | Companies found further down are saved. Companies nobody found stay pending and are tried again tomorrow, rather than being written off |

## UC-F25-06 A key stops working

| | |
| --- | --- |
| Trigger | The Apollo key is revoked |
| Main flow | Apollo refuses it; the agent marks Apollo as needing attention on the setup screen and carries on with the next provider. |
| Result | The run still produces leads. The job result names the error: "Apollo: Apollo rejected the stored credentials" |

## UC-F25-07 A free People Data Labs plan

| | |
| --- | --- |
| Trigger | The workspace connected a free People Data Labs key |
| Main flow | People Data Labs returns people, but their email and phone come back as yes/no flags. |
| Result | Nothing unusable is saved, and the run notes say a Pro plan is needed to receive emails and phones |

## UC-F25-08 Compare providers fairly

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Opens Settings, Contact finders. |
| Result | For each provider: companies asked, found someone, match rate, leads added and failed lookups. A note explains that providers further down only see the harder companies |

## UC-F25-09 No provider connected

| | |
| --- | --- |
| Trigger | A new workspace has connected none of the three |
| Result | The agent reads company websites only, as before, and the run notes say which tools to connect |
