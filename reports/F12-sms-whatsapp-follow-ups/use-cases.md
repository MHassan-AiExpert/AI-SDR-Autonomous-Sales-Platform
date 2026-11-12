# F12 — SMS and WhatsApp Follow-ups: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Set up and launch text follow-ups |
| Rep | Records consent, answers texts from the inbox |
| Text agent | Writes and sends follow-ups |
| Reply agent | Reads text replies |
| Twilio | Sends and receives the texts |
| Prospect | Receives the text and may reply |

## UC-F12-01 Set up SMS follow-ups

| | |
| --- | --- |
| Actor | Owner or admin |
| Preconditions | Twilio connected; a number registered for business texting |
| Main flow | 1. Opens the campaign, then Text follow-ups, then Text settings. 2. Chooses SMS and enters +15125550100. 3. Sets 3 days, 100 per day and 1 per lead. 4. Pastes the Twilio address from Settings into the number's "A message comes in" field in Twilio. 5. Presses Launch text follow-ups. |
| Result | Every hour inside contact hours, leads who are due and have consent get one text. |

## UC-F12-02 Record consent to text

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Kim filled in the website form agreeing to receive texts. The rep opens Kim's profile and, under Texts, records "Agreed in writing to receive messages" for SMS. |

## UC-F12-03 A lead who did not answer is followed up

| | |
| --- | --- |
| Main flow | Kim was emailed four days ago and has not answered. The agent sends "Hi Kim, it's Sam from Acme Growth. Saw the second clinic opening; want 15 minutes on keeping the new chairs full? Reply STOP to opt out." The text appears on Kim's timeline and under Texts, and becomes Delivered when Twilio confirms it. |

## UC-F12-04 The prospect texts back with a question

| | |
| --- | --- |
| Main flow | Kim replies "How much does it cost?". The reply agent classifies it as a question, moves Kim to Engaged, stops the remaining emails and drafts an answer. In autopilot the answer is sent as an SMS at once; otherwise it waits in the Inbox for approval. Slack shows "Question by text: Kim Bright". |

## UC-F12-05 STOP

| | |
| --- | --- |
| Main flow | A prospect replies "STOP". The phone number and email address are suppressed straight away, pending emails and answers are cancelled, and the lead becomes Do not contact. No text, email or call goes to them again. |

## UC-F12-06 WhatsApp follow-ups

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Chooses WhatsApp, enters the approved sender and the template's Content SID (template: "Hi {{1}}, {{2}}"). Leads with recorded WhatsApp consent get the template with their first name and the AI's line. |

## UC-F12-07 Stop all texts

| | |
| --- | --- |
| Main flow | The kill switch, switching SMS or WhatsApp off in Settings, or Pause texts on the campaign stops new texts. Approved answers on a switched-off channel wait until it is switched on again. |

## UC-F12-08 A number had opted out at Twilio

| | |
| --- | --- |
| Main flow | Twilio refuses a text because the number had replied STOP earlier. The text is marked "The recipient has replied STOP to this number" and the lead is suppressed. |

## UC-F12-09 Review all texts

| | |
| --- | --- |
| Actor | Any member |
| Main flow | Opens Texts and filters by Received to read everything leads sent back, or by Not delivered to see failures and why. |
