# F09 — Reply Handling: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Connect the webhook and Slack, rotate the webhook address |
| Rep | Works the inbox and answers replies |
| Viewer | Reads the inbox |
| Instantly | Posts events to the workspace's webhook address |
| Reply agent | Reads and acts on events |

## UC-F09-01 Connect replies to the platform

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | 1. Opens Settings, copies the Instantly webhook address. 2. In Instantly adds a webhook with that address and all events. 3. Enters the Slack channel "#sales-alerts" and saves. 4. The next reply shows up in the Inbox within a minute and in Slack if it is hot. |

## UC-F09-02 A prospect wants to talk

| | |
| --- | --- |
| Main flow | Kim replies "Tuesday works for a quick call". The agent classifies it as interested (94%), moves Kim to Interested, cancels the remaining follow-ups, drafts "Great, Tuesday at 10 works…", and posts "Interested: Kim Bright (Bright Teeth): Wants a call on Tuesday. Open lead" in Slack. A rep opens the Inbox, copies the suggestion into Instantly with "Answer in Instantly", then marks it handled. |

## UC-F09-03 A prospect asks to stop

| | |
| --- | --- |
| Main flow | A reply says "Please remove me from your list". The safety rule catches it before any AI call. The address is suppressed on every channel, pending emails are cancelled, and the lead moves to Do not contact. No campaign can contact them again. |

## UC-F09-04 An email bounces

| | |
| --- | --- |
| Main flow | Instantly reports a bounce. The email is marked bounced, the rest cancelled, the address marked invalid and suppressed, protecting the sending domain. |

## UC-F09-05 Not now

| | |
| --- | --- |
| Main flow | "Maybe next quarter." The lead becomes Engaged and a follow-up task is created for 30 days later; no answer is drafted. |

## UC-F09-06 Out of office

| | |
| --- | --- |
| Main flow | An automatic reply arrives. It is recorded, the lead's stage is unchanged, and the sequence carries on. |

## UC-F09-07 Someone updates the lead in Instantly

| | |
| --- | --- |
| Main flow | A rep marks a lead "Meeting booked" in Instantly. The platform updates the stage and records it as a human action on the timeline. |

## UC-F09-08 The webhook address leaks

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Presses "Create a new address" in Settings and pastes the new one into Instantly. Requests to the old address are refused. |

## UC-F09-09 Slack is not set up correctly

| | |
| --- | --- |
| Main flow | The app has not been invited to the channel. Replies are still processed; Agent activity shows "Slack alert failed: Add the Slack app to the alert channel, or check the channel name in Settings." |

## UC-F09-10 The kill switch is on

| | |
| --- | --- |
| Main flow | Outreach is paused, but replies, bounces and unsubscribes that arrive are still recorded and acted on, so no opt-out is ever missed. |
