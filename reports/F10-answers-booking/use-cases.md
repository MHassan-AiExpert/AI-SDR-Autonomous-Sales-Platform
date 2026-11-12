# F10 — Answers and Booking: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Prospect | Replies to an email and books a time |
| Rep, Owner, Admin | Edit and approve answers, set campaign reply settings |
| Reply agent | Drafts answers with booking links, sends approved answers |
| Calendly | Creates booking links and reports bookings |

## UC-F10-01 From "yes" to a booked meeting on autopilot

| | |
| --- | --- |
| Main flow | 1. Kim replies "Yes, keen to talk". 2. Classified interested at 95%. 3. A one-time Calendly link is made for Kim and added to the drafted answer. 4. Autopilot approves it and it is sent in Kim's thread within a minute. 5. Kim books Wednesday 15:00. 6. The meeting appears under Meetings with its Zoom link, Kim moves to Meeting booked, and Slack shows "Meeting booked". |

## UC-F10-02 Review answers in approval mode

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Opens the Inbox, reads the drafted answer, edits a line, and presses Approve and send. The answer goes out in the same thread; the badge changes to Sent. |
| Alternatives | Save draft keeps it for later. |

## UC-F10-03 An objection

| | |
| --- | --- |
| Main flow | "Looks too expensive." A draft is written with a booking link but is never sent automatically. A rep adjusts it and approves. |

## UC-F10-04 The prospect opts out before the answer goes

| | |
| --- | --- |
| Main flow | An approved answer is waiting, and the lead unsubscribes. At send time it is skipped and shown as "Not sent: The lead asked not to be contacted". |

## UC-F10-05 Pause everything

| | |
| --- | --- |
| Main flow | The owner presses the kill switch. Approved answers stay "Waiting to send" and go out when outreach is resumed. |

## UC-F10-06 The prospect books with a personal address

| | |
| --- | --- |
| Main flow | Kim books from kim.personal@gmail.com. The lead id in the link matches the booking to Kim anyway. |

## UC-F10-07 The prospect cancels

| | |
| --- | --- |
| Main flow | Kim cancels in Calendly. The meeting shows Cancelled and Kim returns to Interested, ready for a new answer or call. |

## UC-F10-08 Use a specific meeting type

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Under Replies and booking, enters the Calendly event type for a 20-minute demo. New booking links use it. |

## UC-F10-09 A forged booking notification

| | |
| --- | --- |
| Main flow | Someone posts a fake booking to the workspace's address. Without a valid Calendly signature made with the workspace's private key, it is refused and nothing is recorded. |

## UC-F10-10 Sending fails

| | |
| --- | --- |
| Main flow | Instantly is briefly unavailable. The answer shows "Not sent: Instantly returned an error (500)". The rep approves it again and it goes out. |
