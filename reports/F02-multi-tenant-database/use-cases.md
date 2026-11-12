# F02 — Multi-Tenant Database: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner | Subscribed the company; full control of the workspace |
| Admin | Manages configuration, settings, reps and viewers |
| Rep | Works leads, follow-ups, meetings and deals |
| Viewer | Reads everything, changes nothing |
| Backend worker | n8n workflow acting for a workspace through the service role |
| Outsider | A signed-in user of another company, or an anonymous visitor |

## UC-F02-01 A company subscribes and gets its workspace

| | |
| --- | --- |
| Actor | Owner |
| Trigger | The user creates a workspace |
| Main flow | 1. A workspace row is created with default settings: autopilot, email, voice, SMS and WhatsApp on, outreach not paused. 2. The creator is added as owner. 3. The membership is written to the audit log. |
| Result | The company has an isolated workspace and one owner |
| Rule | A user cannot create a workspace in someone else's name |

## UC-F02-02 Build the team

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | 1. The owner adds admins, reps and viewers. 2. An admin adds or removes reps and viewers. 3. Every change is audited. |
| Rules | Only an owner grants owner or admin. A rep cannot add members or promote themselves. The last owner cannot be removed or demoted. |

## UC-F02-03 Ten companies use the platform at the same time

| | |
| --- | --- |
| Actor | Users of different workspaces |
| Main flow | Each user queries leads, deals and timelines at the same moment. |
| Result | Each sees only their own company's rows. Requests for another company's row by its ID return nothing. Inserts, updates and deletes aimed at another workspace are rejected or affect zero rows. |

## UC-F02-04 Agents store leads from every channel

| | |
| --- | --- |
| Actor | Backend worker, Rep |
| Main flow | 1. Leads from Apollo, Google Maps, social media, LLM search, CSV, inbound calls or manual entry are inserted with their source channel and query. 2. The lead is linked to its campaign and company in the same workspace. |
| Rules | One lead per email per workspace. At least one contact method. Score between 0 and 100. Unknown channels and stages are rejected. |
| Result | Leads are categorised by source and ready for filtering and reporting by channel |

## UC-F02-05 Record a lead's full journey

| | |
| --- | --- |
| Actor | Backend worker, Rep |
| Main flow | 1. Each email, call, SMS, WhatsApp message, reply and meeting is stored in its own table. 2. An activity row is added to the lead's timeline for each event. 3. Audit report and proposal are stored as assets with view counts. 4. The next follow-up is scheduled with channel and cadence step. |
| Result | The lead profile shows a complete, ordered timeline; viewers can read it; other companies cannot |

## UC-F02-06 Retry a job without sending twice

| | |
| --- | --- |
| Actor | Backend worker |
| Trigger | A send or call job fails midway and is retried |
| Main flow | The worker inserts the email, message or call with the same idempotency key. |
| Result | The database rejects the duplicate, so the prospect is contacted once |

## UC-F02-07 Close a deal

| | |
| --- | --- |
| Actor | Backend worker (AI closer), Rep |
| Main flow | 1. A deal is opened for the lead. 2. It moves through meeting held, proposal sent and negotiation. 3. Agreement and payment status are updated and the deal is marked won or lost with who closed it. |
| Rules | One sales record per lead. Only valid pipeline stages. Value stored in cents with a currency. |

## UC-F02-08 Honour an opt-out on every channel

| | |
| --- | --- |
| Actor | Backend worker, Rep |
| Trigger | A prospect unsubscribes, asks not to be called, bounces, or is a customer or competitor |
| Main flow | 1. The email, phone or whole domain is added to the suppression list. 2. Before any touch, `app.is_suppressed` is checked. |
| Result | The contact is skipped on every channel. The list is private to the workspace and cannot be probed by another company. |

## UC-F02-09 Switch channels, approval mode or the kill switch

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | The user changes enabled channels, automation mode, the AI closer switch or pauses all outreach. |
| Result | The setting is stored on the workspace and the change is audited with the actor |
| Rule | Reps and viewers cannot change these settings |

## UC-F02-10 Connect a tool

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | The tool is registered once for the workspace with its status and a reference to the encrypted secret. |
| Result | Workflows load the workspace's own credentials at run time. The secret itself is never in this database. |

## UC-F02-11 Publish a new playbook version

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | 1. A new version is saved. 2. The previous version is deactivated and the new one activated. |
| Rule | Exactly one version is live per workspace, so agents never pitch from two playbooks |

## UC-F02-12 Review who changed what

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | The user reads the audit log of their workspace. |
| Result | Member, channel, automation and kill-switch changes are listed with actor and time. The log cannot be edited or deleted by users. |

## UC-F02-13 A company cancels

| | |
| --- | --- |
| Actor | Owner |
| Main flow | The owner deletes the workspace. |
| Result | All of its data is removed in one step. Other companies' data is untouched. |

## UC-F02-14 An outsider tries to reach data

| | |
| --- | --- |
| Actor | Outsider |
| Main flow | An anonymous visitor or a user of another company queries any table. |
| Result | Anonymous access is denied. Other users get empty results and their writes are rejected. |
