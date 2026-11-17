# F28 — Salesforce and Pipedrive: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Connect a CRM, choose it, map stages, switch sync on |
| CRM agent | Runs the hourly sync |
| Pipedrive, Salesforce | The team's CRM |

## UC-F28-01 Connect Pipedrive

| | |
| --- | --- |
| Actor | Admin |
| Main flow | 1. Setup, External CRM, Pipedrive. 2. Pastes the API token. |
| Result | Checked live with `users/me` before saving; stored in the vault, only the last four characters shown |

## UC-F28-02 Connect Salesforce

| | |
| --- | --- |
| Actor | Owner |
| Preconditions | An external client app or connected app with the client credentials flow and a run-as user |
| Main flow | Enters `acme.my.salesforce.com`, the consumer key and the consumer secret |
| Result | A token is requested from that host to prove it works. A Lightning address or any other host is refused before any request |

## UC-F28-03 Choose Pipedrive and map stages

| | |
| --- | --- |
| Main flow | 1. Settings, CRM sync, Pipedrive. 2. Saves: the old HubSpot stages are reset, not rejected. 3. Enters pipeline 4 and the stage numbers for the four open stages, and switches sync on. |
| Result | "CRM sync is on. Leads, deals and activity go to Pipedrive every hour." |

## UC-F28-04 A lead replies

| | |
| --- | --- |
| Result | Within the hour: a person in Pipedrive (or a contact in Salesforce), the deal or opportunity linked to them, and the reply as a note (or completed task) |

## UC-F28-05 The deal is won in the CRM

| | |
| --- | --- |
| Trigger | A rep marks the Pipedrive deal won, or moves the Salesforce opportunity to a won stage |
| Result | The next run closes it here as won, the lead becomes won, the activity reads "Marked won in Pipedrive", and the team is told once |

## UC-F28-06 A custom Salesforce stage

| | |
| --- | --- |
| Main flow | The org calls its proposal stage "Proposal Sent (custom)"; the owner types that for Proposal sent |
| Result | Opportunities at that stage use it. Won and lost are still read correctly, from `IsWon` and `IsClosed` |

## UC-F28-07 The person already exists in Pipedrive

| | |
| --- | --- |
| Result | Found by exact email and updated; the emails a rep added are kept |

## UC-F28-08 Switch from HubSpot to Salesforce

| | |
| --- | --- |
| Result | Salesforce starts clean; HubSpot links are kept for a switch back; nothing is sent to HubSpot any more |

## UC-F28-09 The consumer secret is rotated in Salesforce

| | |
| --- | --- |
| Result | The run fails with "Salesforce rejected the stored credentials. Reconnect Salesforce in Setup." and Salesforce is flagged in Setup. The secret never appears in the task history |
