# F14 — Inbound AI Receptionist: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Set up the receptionist |
| Rep | Takes transfers and tasks |
| AI receptionist | Answers calls |
| Vapi | The phone line |
| Caller | Prospect, existing customer or anyone else |

## UC-F14-01 Set up the receptionist

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | 1. In Vapi, creates a receptionist assistant, imports the Twilio number, leaves its assistant empty and pastes the server URL from the campaign. 2. On the campaign, enters the assistant and number IDs, the team number +15125550199 and notes ("Open Monday to Friday 9 to 5, 1 Main St, Austin"). 3. Switches the receptionist on. |
| Result | Calls to the number are answered by the AI receptionist. |

## UC-F14-02 A new prospect calls and wants a meeting

| | |
| --- | --- |
| Main flow | Lee calls: "Thanks for calling Acme Growth. This is the AI assistant. How can I help you today?" Lee asks about online booking for his clinic. The receptionist answers from the playbook, offers a meeting and asks whether it may text a booking link. Lee agrees. After the call Lee receives "Hi Lee, thanks for calling Acme Growth. Pick a time that suits you here: https://calendly.com/... Reply STOP to opt out." Lee is a new lead (Interested, source Inbound call) with the call recording. Slack: "Lee Park wants a meeting. Booking link sent by text." |

## UC-F14-03 A known contact asks to be called back

| | |
| --- | --- |
| Main flow | Kim calls back after an email. "Am I speaking with Kim?" Kim is busy and asks for a call on Thursday at 10. Kim's existing lead gets the call, a call-back task for Thursday 10:00, and call consent recorded with the call as its source. |

## UC-F14-04 The caller asks for a person

| | |
| --- | --- |
| Main flow | A customer with a billing question asks for a person. The receptionist puts the call through to the team number. The call shows "Put through to the team" and Slack is alerted. |

## UC-F14-05 The receptionist is off

| | |
| --- | --- |
| Main flow | Out of hours the owner has switched the receptionist off. Calls go straight to the team number. With no team number, Vapi says the line is unavailable. |

## UC-F14-06 Spam

| | |
| --- | --- |
| Main flow | A robocall from an unknown number. No lead is created; the call is kept in the event log. |

## UC-F14-07 "Don't call me"

| | |
| --- | --- |
| Main flow | A caller says "stop calling me". The number is suppressed and the lead becomes Do not contact. |
