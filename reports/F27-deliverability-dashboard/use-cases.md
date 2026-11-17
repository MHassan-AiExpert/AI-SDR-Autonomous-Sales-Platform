# F27 — Deliverability Dashboard: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Read the dashboard, ask for a check, set a DKIM selector |
| Rep, Viewer | Read the dashboard |
| Monitoring agent | Runs the daily check and raises alerts |
| Instantly | Supplies mailbox status and warm-up health |

## UC-F27-01 First look at a new sending domain

| | |
| --- | --- |
| Actor | Owner |
| Trigger | Adds `sam@outreach-acme.io` to a campaign's mailboxes |
| Main flow | 1. Opens Deliverability and presses "Check now". 2. Within 15 minutes the domain appears. |
| Result | Score 25, at risk: "No SPF record", "No DMARC record", "No MX record", each with the record to add. A Slack alert names the domain |

## UC-F27-02 SPF over the lookup limit

| | |
| --- | --- |
| Trigger | A new tool's include pushes the record to 11 lookups |
| Result | SPF fails: "SPF needs 11 DNS lookups; the limit is 10", with the advice to drop unused includes or use ip4 ranges |

## UC-F27-03 Google Workspace mailbox, Outlook-only SPF

| | |
| --- | --- |
| Trigger | Instantly reports the mailbox as Google, but SPF only includes Microsoft 365 |
| Result | "SPF does not include Google Workspace", fix: add `include:_spf.google.com` |

## UC-F27-04 A provider with an uncommon DKIM selector

| | |
| --- | --- |
| Actor | Admin |
| Main flow | 1. Sees "No DKIM key at the common selectors" as a warning. 2. Enters `mx2026` from the provider's settings. |
| Result | The next check finds the key: DKIM passes, "found at mx2026" |

## UC-F27-05 The domain is blocklisted

| | |
| --- | --- |
| Trigger | Spamhaus lists the domain for spam |
| Result | A critical alert, sent even in quiet hours: "Listed on Spamhaus DBL: spam domain", with what to do. Tomorrow's check does not repeat it |

## UC-F27-06 A mailbox stops

| | |
| --- | --- |
| Trigger | Instantly can no longer connect to `lee@acme.com` |
| Result | "Mailbox needs attention: Instantly cannot connect to it; reconnect it in Instantly". The mailbox row turns red |

## UC-F27-07 Which mailbox is bouncing

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Opens the mailbox table |
| Result | Each mailbox's sends, bounce rate and reply rate for 30 days. Sends Instantly did not attribute to a mailbox are counted in a note |

## UC-F27-08 Spamhaus refuses the query

| | |
| --- | --- |
| Result | Spamhaus shows "not checked", with the reason. It never shows as clear, and costs no score |

## UC-F27-09 Instantly rejects the key

| | |
| --- | --- |
| Result | Instantly flagged in Setup; yesterday's mailboxes stay on the page; domains are still checked |

## UC-F27-10 A domain stops being used

| | |
| --- | --- |
| Trigger | The last campaign using it is archived and Instantly no longer lists its mailboxes |
| Result | It disappears from the page at the next check |
