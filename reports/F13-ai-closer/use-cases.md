# F13 — AI Closer: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Write the playbook and set up the closer |
| Rep | Takes meetings and deals the closer hands over |
| AI closer | Runs meetings and sends proposals |
| Vapi | The meeting call |
| Stripe | Payment links and payments |
| PandaDoc | Proposals and e-signature |
| Prospect | Attends the meeting and pays |

## UC-F13-01 Write the sales playbook

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Opens Playbook and writes the offer. Adds Starter at 199 USD a month and Growth at 499 USD a month. Adds two questions, the objection "too expensive \| most clinics recover the fee with two new patients a month", the handoff rule "they ask for a custom contract", and the PandaDoc template ID. Saves. |
| Result | Version 1 is live. The closer quotes only these plans and prices. |

## UC-F13-02 Set up the closer for a campaign

| | |
| --- | --- |
| Main flow | In Vapi, creates a closer assistant with the chosen voice. Pastes its ID into the campaign's AI closer section. Sets the Calendly event to "Phone call: we will call you". The checklist shows everything required as Done. |

## UC-F13-03 The closer runs the meeting and the prospect agrees

| | |
| --- | --- |
| Main flow | At 15:00 the closer calls Kim: "Hi Kim, this is the AI assistant from Acme Growth, calling for the meeting you booked." Kim asks about cost; the closer answers with the playbook's objection answer. Kim chooses Growth. Within a minute a Stripe payment link for $499 a month is created and the PandaDoc proposal is sent to Kim with the link inside. The deal shows Proposal sent and Payment link sent. Slack shows "Proposal sent". |

## UC-F13-04 The prospect pays

| | |
| --- | --- |
| Main flow | Kim signs and pays through the link. Stripe reports the completed payment. The deal becomes Won (paid, closed by the AI), Kim becomes Won, and Slack shows ":tada: Deal won: Kim Bright paid for Growth ($499)". |

## UC-F13-05 The prospect asks for a discount

| | |
| --- | --- |
| Main flow | The prospect asks for 20% off. The closer says a person from the team will follow up and ends the meeting. The deal shows Needs your team, the team gets a task, and Slack shows "needs your team: Asked for 20% off". |

## UC-F13-06 A meeting without a phone number

| | |
| --- | --- |
| Main flow | A prospect booked a Zoom meeting and gave no phone number. At the meeting time the meeting goes to the team, with the note "The prospect did not give a phone number for this meeting", a task, and a Slack alert. |

## UC-F13-07 The team takes a meeting

| | |
| --- | --- |
| Actor | Rep |
| Main flow | On Meetings, presses "Hand to my team" for tomorrow's meeting with a key account. The closer will not call. "Let the AI closer run it" gives it back while the meeting has not started. |

## UC-F13-08 No answer

| | |
| --- | --- |
| Main flow | The prospect does not answer. The meeting is marked No show, the team gets a task to reschedule, and Slack is alerted. |

## UC-F13-09 PandaDoc is not connected

| | |
| --- | --- |
| Main flow | The prospect agrees to Starter. The payment link is created in Stripe, and the team gets a task and a Slack alert with the link to send with their own proposal. |
