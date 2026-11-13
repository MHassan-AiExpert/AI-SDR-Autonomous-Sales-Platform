# F15 — Website and Marketing Audits: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Turn audits on |
| Rep | Sees who opened their audit |
| Audit agent | Makes audits and sends alerts |
| Lead | Receives the email and opens the audit |

## UC-F15-01 Turn audits on

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Opens the campaign and presses "Turn audits on". Within a minute every qualified lead without one gets an audit. From now on, research is followed by audits, then emails. |

## UC-F15-02 A lead receives the audit

| | |
| --- | --- |
| Main flow | Slow Dental scores 15/100: the site is slow, has no search description, no mobile setting, no online booking and no tracking. The AI's top recommendations are "Let patients book online" and "Fit the page to phones". Kim's first email ends with "I put together a short, free audit of Slow Dental's website and marketing: https://app.example.com/a/…". |

## UC-F15-03 The lead opens it

| | |
| --- | --- |
| Main flow | Kim opens the link and reads for four minutes. Kim's timeline shows "Opened the website audit", Kim moves to Engaged, and Slack shows "Audit opened: Kim Owner opened their website audit (score 15/100)". The lead profile shows 1 open and 4 minutes. |

## UC-F15-04 A rep previews the audit

| | |
| --- | --- |
| Actor | Rep, signed in |
| Main flow | Opens the audit from the lead profile to check it before a call. The visit is not counted. |

## UC-F15-05 A lead without a website

| | |
| --- | --- |
| Main flow | The business has no known website. The audit is recorded as "No website is known for this business", and the emails are written without the audit line. |

## UC-F15-06 Someone guesses a link

| | |
| --- | --- |
| Main flow | Any link that is not an existing, unexpired audit shows the not-found page. Nothing about any lead is revealed. |
