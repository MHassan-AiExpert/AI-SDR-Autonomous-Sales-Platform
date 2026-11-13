# F19 — Monitoring, Alerts and Notifications: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Choose alerts, quiet hours and safety limits |
| Rep | Takes handoffs and follows up on alerts |
| Viewer | Reads notifications |
| Monitor | Checks each workspace every 15 minutes |
| Uptime monitor | Calls `/health` and `/ready` on the agent service |

## UC-F19-01 Take a handoff

| | |
| --- | --- |
| Actor | Rep |
| Trigger | The AI closer cannot reach a prospect for a meeting starting now |
| Main flow | 1. Slack shows "Meeting for your team" with a link to the lead. 2. The rep opens Notifications, Open handoffs. 3. Clicks I'll take it, then Join meeting. |
| Result | The handoff shows "Taken by you", and the lead is assigned to the rep. Other reps see who took it |
| Alternative | Another rep took it a moment earlier: "Someone has already taken this, or you cannot take handoffs." |

## UC-F19-02 Bounce spike

| | |
| --- | --- |
| Trigger | A bad lead list makes 7% of a campaign's 300 emails this week bounce |
| Main flow | Within 15 minutes the monitor pauses the campaign's emails and the Instantly campaign. A critical Slack alert goes out even though it is night: "Emails paused (Austin): Bounce rate 7.0% over the last 7 days (21 of 300 emails) reached the 5% limit." |
| Result | The campaign page shows "Paused automatically" with the reason. After cleaning the list, the owner clicks Resume email outreach |

## UC-F19-03 Quiet nights

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Sets quiet hours from 20:00 to 08:00 in Asia/Karachi. A positive reply at 23:00 is kept in Notifications and posted to Slack at 08:00, marked as held during quiet hours. |

## UC-F19-04 Provider outage

| | |
| --- | --- |
| Trigger | Apollo is down for a few minutes during lead sourcing |
| Main flow | The task runs again after 2 minutes and succeeds. Nobody is alerted |
| Alternative | Apollo stays down for all three attempts: "Lead sourcing failed (Austin): Apollo did not respond in time." is alerted once that day |

## UC-F19-05 Low credits

| | |
| --- | --- |
| Main flow | Apify has 40 credits left, below the workspace's level of 100. A "credits are low" alert with a link to Setup goes out once that day. |

## UC-F19-06 Morning summary

| | |
| --- | --- |
| Main flow | At 08:00 local time Slack shows the last 24 hours: new leads, emails, calls, replies, positive replies, meetings, wins and any failed tasks. |

## UC-F19-07 Fewer Slack messages

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Unticks audits opened and weekly learning reports. Those still appear in Notifications but no longer in Slack. |

## UC-F19-08 Agent service stuck

| | |
| --- | --- |
| Actor | Uptime monitor |
| Main flow | `/ready` returns 503 "queue backlog" when tasks have waited more than 15 minutes. Each affected workspace also gets an "Agent tasks are waiting" alert |
