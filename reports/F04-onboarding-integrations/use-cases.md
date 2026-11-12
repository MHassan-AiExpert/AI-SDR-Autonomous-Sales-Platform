# F04 — Guided Onboarding: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Connect tools and tick off manual steps |
| Rep, Viewer | See setup status only |
| Backend worker | n8n workflow that uses stored credentials and runs health checks |
| Tool | The third-party service being connected |

## UC-F04-01 See what is left to set up

| | |
| --- | --- |
| Actor | Any member |
| Main flow | 1. Opens the workspace; the overview shows "Finish setup: N% complete". 2. Opens Setup. 3. Sees one card per step the enabled channels need, each marked Required, Optional or Done. |
| Result | The member knows exactly what is missing. Steps for channels that are off are listed as not needed. |

## UC-F04-02 Connect a tool

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | 1. Opens a tool card and enters its credentials. 2. Presses "Test and connect". 3. The platform makes one read-only request to the tool. 4. On success the credentials are encrypted in the vault and the card shows Connected with a masked key. |
| Alternatives | Empty or malformed field: named in the message, nothing sent. Rejected credentials, unknown account, rate limit, service error or unreachable: clear message, nothing saved, typed values kept. |

## UC-F04-03 Choose a provider for a shared step

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Connects Anthropic instead of OpenAI, or Apify instead of Apollo. |
| Result | The step is complete with any one tool. Connecting more than one gives the agents a backup. |

## UC-F04-04 Replace credentials

| | |
| --- | --- |
| Actor | Owner, Admin |
| Trigger | A key was rotated or a tool shows Expired or Needs attention |
| Main flow | Opens "Replace credentials", enters the new values, presses "Test and connect". |
| Result | The vault entry is replaced; there is still one row and one secret per tool |

## UC-F04-05 Disconnect a tool

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Presses "Disconnect and delete credentials". |
| Result | The encrypted credentials are deleted, the card shows Not connected, the step returns to Required if no other tool covers it, and the action is audited |

## UC-F04-06 Tick off manual setup steps

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | After finishing domain authentication, warm-up, A2P registration or WhatsApp template approval in the provider's dashboard, ticks the step and saves. |
| Result | Progress updates. Only steps for enabled channels are shown. |

## UC-F04-07 Run cold email only

| | |
| --- | --- |
| Actor | Owner, Admin |
| Precondition | Settings: only email on, AI closer off |
| Main flow | Opens Setup. |
| Result | Only language model, lead sources, email verification, email sending, meetings, calendar and alerts are required, plus domain and warm-up steps. Twilio, Vapi, WhatsApp, PandaDoc and Stripe are listed as not needed. |

## UC-F04-08 A rep or viewer opens Setup

| | |
| --- | --- |
| Actor | Rep, Viewer |
| Result | Sees every status and the progress, but no connection forms, disconnect buttons or editable checklist |

## UC-F04-09 Agents use the company's own accounts

| | |
| --- | --- |
| Actor | Backend worker |
| Main flow | Before a job, the worker reads the workspace's credentials for the tool through the service-role function. |
| Result | Each company's calls, emails and messages run on its own accounts. Disconnected tools return nothing. |

## UC-F04-10 A stored key stops working

| | |
| --- | --- |
| Actor | Backend worker |
| Trigger | Scheduled health check finds a key expired or rejected |
| Main flow | The worker records `expired` or `error` with a message and remaining credits. |
| Result | The card shows the problem, the step returns to Required, and progress drops until the credentials are replaced |

## UC-F04-11 A company cancels

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Deletes the workspace. |
| Result | Every encrypted credential of that workspace is deleted; other companies' credentials are untouched |
