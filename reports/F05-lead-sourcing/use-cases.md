# F05 — Lead Sourcing: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Create campaigns and start agent runs |
| Rep, Viewer | See campaigns, runs and leads |
| Scheduler | n8n workflow that wakes the agent service every minute |
| Agent service | Runs the setup agent and the lead-finder agents |
| Lead sources | Apollo, Apify (Google Maps, Instagram), OpenAI, Anthropic, Gemini |

## UC-F05-01 Start from a niche

| | |
| --- | --- |
| Actor | Owner or admin |
| Preconditions | At least one language model and one lead source tool connected in Setup |
| Main flow | 1. Opens Campaigns, then New campaign. 2. Types "Independent dental clinics", target areas "Austin, Texas, United States", leads per day 100. 3. Leaves "Find leads right away" ticked and creates the campaign. 4. Lands on the campaign page; two agent runs show as queued. 5. Within about a minute the plan appears, then the leads. |
| Result | Profile, source plan and the first leads exist without any further input (FR-1.6, FR-14.1 to 14.4). |
| Alternatives | 3a. Box unticked: only the plan is made; the admin reviews it and presses Find leads now. |

## UC-F05-02 Review the plan

| | |
| --- | --- |
| Actor | Any member |
| Main flow | Opens the campaign and reads the profile (decision makers, industries, size, pain points, buying triggers) and each source with its titles, search terms, hashtags or questions. |
| Result | The team sees exactly what the agents will search. Sources that are off say why: not suited to the niche, or the tool is not connected. |

## UC-F05-03 Find more leads on demand

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Presses Find leads now. The run starts within a minute and its line in Agent activity reports "N new leads (Apollo 5, Google Maps 12, …)". |
| Alternatives | A run is already waiting or running: "The agent is already working on this." The daily limit is reached: the run reports it and adds nothing. |

## UC-F05-04 Connect a tool later

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | 1. Campaign shows Google Maps off because Apify is not connected. 2. Connects Apify in Setup. 3. Presses Re-plan campaign. 4. Google Maps and Instagram switch on if they suit the niche. |

## UC-F05-05 A tool's key stops working

| | |
| --- | --- |
| Actor | Agent service |
| Main flow | 1. Apify rejects the stored token during a run. 2. Apollo and LLM search still run and their leads are saved. 3. The run reports "Google Maps failed: Apify rejected the stored credentials". 4. Apify is marked as an error in Setup with the same message. |
| Result | Partial results are kept and the company knows exactly what to fix. |

## UC-F05-06 Every source fails

| | |
| --- | --- |
| Main flow | All providers are down. The run is marked Failed with one message naming each source and its error, and the run log records the failure. |

## UC-F05-07 Same business from several sources

| | |
| --- | --- |
| Main flow | Google Maps returns Smile Dental with hello@smile1.com; an LLM search also names Smile Dental. The lead is stored once, from Google Maps; the LLM result counts as a duplicate. Running the campaign again stores nothing new. |

## UC-F05-08 Never contact a suppressed person

| | |
| --- | --- |
| Preconditions | The company suppressed ana@ruizdental.com (unsubscribed) and the domain smile2.com (existing customer) |
| Main flow | Both are found by the agents and dropped before storage; the run counts them as suppressed. |

## UC-F05-09 Pause everything

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Presses the kill switch. Queued sourcing runs wait; planning still runs. Resuming lets the waiting runs start on the next minute. |

## UC-F05-10 Work the lead list

| | |
| --- | --- |
| Actor | Any member |
| Main flow | Opens Leads, clicks "Google Maps: 24" to filter by source, searches "smile", filters stage New, pages through 50 at a time, and shares the filtered link with a colleague, who signs in and lands on the same filtered list. |

## UC-F05-11 Two companies at once

| | |
| --- | --- |
| Main flow | Two subscriber companies both target dentists in Austin. Each run uses that company's own Apify and model keys. Each company gets its own copy of the same clinic; neither can see the other's leads, runs or plans. |

## UC-F05-12 A worker crashes mid-run

| | |
| --- | --- |
| Main flow | The container is restarted during a run. After 15 minutes the job returns to the queue and another worker takes it; after 3 unfinished attempts it is marked Failed with "Stopped after 3 attempts that did not finish". |
