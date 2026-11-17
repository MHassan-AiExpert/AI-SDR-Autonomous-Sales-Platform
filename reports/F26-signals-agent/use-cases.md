# F26 — Signals Agent: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Turn signals on per campaign, choose the kinds, see the signal address |
| Rep | Reads signals, dismisses ones that do not fit |
| Viewer | Reads signals |
| Signals agent | Looks for funding, news, hiring, technology changes and job changes |
| A paid or social tool | Sends signals to the workspace's address |
| Sequence agent | Contacts a lead about a signal, through a step that waits for one |

## UC-F26-01 Turn signals on

| | |
| --- | --- |
| Actor | Owner |
| Main flow | 1. Campaign, Sequence, Signals. 2. Ticks "watch this campaign's leads for signals". 3. Leaves funding, news, hiring and technology ticked; leaves job changes off because each check costs an Apollo credit. 4. Saves. |
| Result | "Signals are on. The agent looks at this campaign's companies once a day." |

## UC-F26-02 A company raises money

| | |
| --- | --- |
| Actor | Signals agent |
| Main flow | The daily web search finds "Bright Teeth raises $4M to open three clinics", dated two weeks ago, with a news link. |
| Result | A funding signal about Bright Teeth, with the link, reaches every lead at the company |

## UC-F26-03 Re-opening a finished conversation

| | |
| --- | --- |
| Actor | Owner, then the sequence agent |
| Trigger | Kim's sequence ended a month ago with no reply |
| Main flow | 1. The owner adds a step: email, run when "a new signal arrived and they have not replied", body starting with `{{signal}}`. 2. The funding signal arrives. |
| Result | Kim gets one email opening "Congratulations on the news: Bright Teeth raises $4M to open three clinics." The signal is marked used, so the next message needs a new one |

## UC-F26-04 A new tool on their website

| | |
| --- | --- |
| Main flow | Last week the site ran Shopify. Today it runs Shopify and HubSpot. |
| Result | "Bright Teeth started using HubSpot." The first look at a site is never a signal, so nobody is told a company "started using" everything it already had |

## UC-F26-05 Your contact changes job

| | |
| --- | --- |
| Actor | Owner, then the signals agent |
| Main flow | The owner turns job changes on. Apollo says Kim now works at Northwind Ortho as COO. |
| Result | "Kim Bright moved to Northwind Ortho as COO", with a note that the email on file may belong to the previous employer |

## UC-F26-06 Buying intent from Bombora

| | |
| --- | --- |
| Actor | Admin, then Bombora through Zapier |
| Main flow | 1. Signals page, copies the address. 2. Points a Zapier step at it with the example body. 3. Bombora reports Bright Teeth researching scheduling software. |
| Result | A buying-intent signal from bombora, matched by domain, appears on the Signals page and can trigger a step like any other |

## UC-F26-07 A tool sends something about a stranger

| | |
| --- | --- |
| Trigger | The listening tool sends a post from a company that is not in the workspace |
| Result | Not stored: "No company or lead in this workspace matches that domain or email." The address cannot be used to collect data about people the team is not working with |

## UC-F26-08 A story with no source

| | |
| --- | --- |
| Trigger | The web search returns an item with no date, or a link to a search page |
| Result | Dropped. Only events a person could check reach a message |

## UC-F26-09 The same story twice

| | |
| --- | --- |
| Trigger | Next week's search finds the same article, now with tracking parameters on the link |
| Result | Recognised as the same event and not stored again |

## UC-F26-10 A signal that does not fit

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Sees a news signal about an award that has nothing to do with the offer, and dismisses it. |
| Result | "Signal dismissed. No step will use it." It can be restored later |

## UC-F26-11 The Apollo key is rejected

| | |
| --- | --- |
| Result | Job-change checks stop for that run, Apollo is flagged in Setup, and the run still records everything else it found |

## UC-F26-12 The address leaks

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Replaces the webhook address in Settings. |
| Result | The old address stops working for signals and every other webhook at once |
