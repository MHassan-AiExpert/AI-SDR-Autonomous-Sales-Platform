# F30 — Website Visitor Identification: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Switch tracking on, list the website, install the script |
| Rep, Viewer | Read visiting companies |
| A website visitor | Anyone browsing the team's site |
| Visitor agent | Identifies companies and raises signals |

## UC-F30-01 Set up

| | |
| --- | --- |
| Actor | Owner |
| Main flow | 1. Setup, Website visitors, connects ipapi.is. 2. Visitors, ticks "Record company visits", lists `acme.com`, saves. 3. Pastes the script into the site's footer. |
| Result | "Tracking is on for acme.com." |

## UC-F30-02 A prospect reads the pricing page

| | |
| --- | --- |
| Trigger | Someone at Bright Dental, already in a campaign, opens `/pricing` and `/case-studies` from the office |
| Result | Within minutes: Bright Dental under "In your pipeline", and one signal "Bright Dental visited your website". A sequence step waiting for a signal emails the lead, opening with the signal |

## UC-F30-03 A new company visits

| | |
| --- | --- |
| Result | Listed under "All" with its domain and pages; no signal, because nobody there is in the pipeline yet |

## UC-F30-04 Someone visits from home, a phone or a VPN

| | |
| --- | --- |
| Result | Discarded. The network says nothing about an employer, so nothing is guessed |

## UC-F30-05 A visitor sends Global Privacy Control

| | |
| --- | --- |
| Result | The script sends nothing; if a request arrives anyway, the server drops it |

## UC-F30-06 The team browses its own site

| | |
| --- | --- |
| Result | Skipped as "your own team" |

## UC-F30-07 Someone copies the site key to another website

| | |
| --- | --- |
| Result | Views from hosts that are not listed are dropped; the owner can replace the key |

## UC-F30-08 The daily lookup quota runs out

| | |
| --- | --- |
| Result | Lookups pause and views wait; networks already known are still identified from the cache. Views not resolved within a day are erased |
