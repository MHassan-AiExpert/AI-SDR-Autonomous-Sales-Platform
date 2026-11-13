# F18 — CRM Sync with HubSpot: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Connect HubSpot, set up and run the sync |
| Rep, Viewer | See the sync status |
| CRM agent | Runs the hourly sync |
| Sales person in HubSpot | Works deals in HubSpot |

## UC-F18-01 Switch on sync

| | |
| --- | --- |
| Actor | Owner |
| Precondition | HubSpot connected in Setup with a private app token |
| Main flow | 1. Opens Settings, CRM sync. 2. Ticks "Sync with HubSpot", keeps "Leads who engaged" and the default pipeline. 3. Saves. 4. Clicks Sync now. |
| Result | Within a minute the engaged leads appear in HubSpot as contacts with their lead status, open deals appear in the sales pipeline, and replies and calls appear as notes. Settings shows the counts and the last sync time. |
| Alternative | HubSpot not connected: "Connect HubSpot in Setup before switching sync on." |

## UC-F18-02 Lead already in HubSpot

| | |
| --- | --- |
| Main flow | A lead the agents found is already a HubSpot contact with the same email. The sync updates that contact instead of creating a second one. |

## UC-F18-03 Deal moves forward

| | |
| --- | --- |
| Main flow | The AI closer sends a proposal, and the deal moves to Proposal sent. In the next hourly run the HubSpot deal moves to Contract sent. Nothing else is sent again. |

## UC-F18-04 Won in HubSpot

| | |
| --- | --- |
| Actor | Sales person in HubSpot |
| Main flow | Marks the deal Closed won in HubSpot after a call. On the next run the platform closes the deal as won (closed by a person), sets the lead to Won, logs "Marked won in HubSpot", and turns the HubSpot contact into a Customer. |

## UC-F18-05 Custom pipeline

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Enters the id of the "Agency sales" pipeline and its stage ids. Saves. New deals go to that pipeline. |
| Alternative | Two steps given the same HubSpot stage: "Each of your stages needs its own HubSpot stage." |

## UC-F18-06 Busy HubSpot account

| | |
| --- | --- |
| Main flow | HubSpot asks the agent to slow down partway through a large first sync. What was sent is kept, the run says "HubSpot asked to slow down; the rest syncs next hour", and the next run picks up where it stopped. |

## UC-F18-07 Token revoked

| | |
| --- | --- |
| Main flow | Someone deletes the private app in HubSpot. The next run fails with "HubSpot rejected the access token. Reconnect HubSpot in Setup." Setup shows HubSpot needs reconnecting, and Settings shows a warning. |

## UC-F18-08 Send everyone

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Chooses "Everyone the agents contacted". The next run also sends leads who were emailed but have not replied, with the status Attempted to contact. |
