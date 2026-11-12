# F08 — Email Outreach: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Configure and launch email outreach, pause it |
| Rep | Reviews, edits, approves and rejects drafts |
| Viewer | Reads emails and status |
| Copywriting agent | Writes sequences |
| Outreach agent | Hands sequences to Instantly and keeps it paused or active |
| Instantly | The company's own sending account and mailboxes |

## UC-F08-01 Set up and launch email outreach

| | |
| --- | --- |
| Actor | Owner or admin |
| Preconditions | Instantly connected; mailboxes connected and warmed up in Instantly |
| Main flow | 1. Opens the campaign, expands Email settings. 2. Enters sender name "Sam Lee", mailboxes, footer "Acme Growth, 1 Main St, Austin TX. Reply 'stop' to opt out.", US Central, 09:00 to 17:00, Monday to Friday, 40 new leads per day, 2 follow-ups, 3 days apart. 3. The checklist turns green; presses Launch email outreach. 4. Within a minute the Instantly campaign is created and active, and the first approved sequences are added. |
| Alternatives | 3a. Footer missing: "Before launching: footer with company name, postal address and opt-out." |

## UC-F08-02 Autopilot from lead to inbox

| | |
| --- | --- |
| Main flow | A new lead is found, verified, researched and scores 82. The copywriting agent writes three emails mentioning the clinic's new location. Being autopilot, they are approved; the next outreach run adds the lead to Instantly, which sends the first email in the next sending window. The lead shows stage Contacted. |

## UC-F08-03 Review drafts in approval mode

| | |
| --- | --- |
| Actor | Rep |
| Main flow | 1. Opens Review emails. 2. Reads Kim's sequence, rewrites one line of the first email, presses Approve on each step. 3. Rejects follow-up 2 for another lead. 4. Kim's sequence is sent on the next run; the other lead is held back. |
| Alternatives | Presses Approve all drafts to approve everything waiting. |

## UC-F08-04 Stop everything now

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Presses the kill switch on the overview. Within a minute every Instantly campaign of the workspace is paused. New sourcing and writing stop; switching the kill switch off reactivates sending. |

## UC-F08-05 Pause one campaign's emails

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Presses Pause email outreach. The Instantly campaign is paused within a minute; other campaigns keep sending. Resume reactivates it. |

## UC-F08-06 Cold email off for a while

| | |
| --- | --- |
| Main flow | The email channel is switched off in Settings. No emails are written, and every live Instantly campaign is paused until email is switched back on. |

## UC-F08-07 Someone unsubscribes before their turn

| | |
| --- | --- |
| Main flow | A lead with an approved sequence is added to the suppression list. At send time the outreach agent skips them; they stay New and are never emailed. |

## UC-F08-08 The AI writes something unacceptable

| | |
| --- | --- |
| Main flow | A draft includes a link or a "[First Name]" placeholder. It is rejected in code before being stored; the next connected model tries; if all fail, the lead is retried next run. |

## UC-F08-09 Instantly key stops working

| | |
| --- | --- |
| Main flow | Instantly rejects the key. The run fails with "Instantly rejected the stored credentials", Instantly is flagged in Setup, and no email is marked as sent. |

## UC-F08-10 The daily limit is reached

| | |
| --- | --- |
| Main flow | 40 sequences have been started today. The remaining approved sequences wait; tomorrow's runs continue in score order. |
