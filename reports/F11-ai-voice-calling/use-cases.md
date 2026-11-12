# F11 — AI Voice Calling: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Set up and launch calling, choose who may be called |
| Rep | Records consent on leads, reads call results |
| Voice agent | Places calls and handles results |
| Vapi | Runs the AI conversation on the company's Twilio number |
| Prospect | Answers the call |

## UC-F11-01 Set up AI calling

| | |
| --- | --- |
| Actor | Owner or admin |
| Preconditions | Vapi and Twilio connected; in Vapi, an assistant with the chosen voice and the Twilio number imported |
| Main flow | 1. Opens the campaign, AI calling, Calling settings. 2. Pastes the assistant and phone number ids, sets US Central, 10:00 to 16:00, weekdays, 30 calls per day, 2 attempts. 3. Keeps "Only leads with recorded consent". 4. Presses Launch AI calling. |
| Result | Calls start in the next calling window, every hour. |

## UC-F11-02 A prospect asks to be called

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Kim replied "call me on my mobile tomorrow". The rep opens Kim's profile and records consent "Asked us to call". In the next window the AI caller rings Kim. |

## UC-F11-03 The call goes well

| | |
| --- | --- |
| Main flow | The agent opens by saying it is an AI assistant for Acme Growth, mentions Kim's new location, and Kim agrees to a demo and to receive a booking link. The call ends; Kim becomes Interested, the team gets a task and a Slack alert "Kim Bright wants a meeting", and the transcript and recording are on Kim's profile. |

## UC-F11-04 "Don't call me again"

| | |
| --- | --- |
| Main flow | The prospect says "please don't call me again". The agent apologises and ends the call. The number is added to the do-not-call list, pending emails are cancelled and the lead becomes Do not contact, even if the call analysis missed it. |

## UC-F11-05 Voicemail

| | |
| --- | --- |
| Main flow | The call reaches voicemail; the agent hangs up without a message. The lead is called again the next day, and not again after the second attempt. |

## UC-F11-06 Call me back on Friday

| | |
| --- | --- |
| Main flow | The prospect is busy and asks for Friday at 11. A call-back task is created for that time and the lead becomes Engaged. |

## UC-F11-07 Calling business landlines

| | |
| --- | --- |
| Actor | Owner |
| Main flow | For a market where B2B calls to business lines are lawful, chooses "Also business landlines" and confirms the numbers were screened against the Do Not Call registry. The confirmation is saved with the owner's name and time. Business landlines are now called; mobiles still need consent. |
| Alternatives | Without the confirmation the setting is refused. |

## UC-F11-08 Stop all calls now

| | |
| --- | --- |
| Main flow | The kill switch, switching AI voice calls off in Settings, or Pause calling on the campaign stops new calls; calls already in progress finish normally. |

## UC-F11-09 Review every call

| | |
| --- | --- |
| Actor | Any member |
| Main flow | Opens Calls, filters by Interested, reads the summaries and plays recordings. |

## UC-F11-10 Vapi key stops working

| | |
| --- | --- |
| Main flow | Vapi rejects the key. The run fails with "Vapi rejected the stored credentials", the call is marked failed and Vapi is flagged in Setup. |
