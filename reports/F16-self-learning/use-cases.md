# F16 — Self-Learning: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Apply or dismiss suggestions |
| Rep, Viewer | Read the results |
| Learning agent | Measures results weekly |
| Copywriter agent | Follows the lessons |

## UC-F16-01 The weekly report

| | |
| --- | --- |
| Main flow | On Monday the learning agent looks at 120 leads emailed in the last 90 days. Subject lines written as a question won interest 25.0% of the time (15 of 60) against 5.0% (3 of 60). Slack shows "Weekly learning (Austin)" with the summary and "1 suggestion is waiting for you: Review". |

## UC-F16-02 Apply a lesson

| | |
| --- | --- |
| Actor | Owner or admin |
| Main flow | Opens Learning, reads "Lesson for the copywriter: Write the first subject line as a short question", with the evidence, and presses Apply. From the next writing run, the copywriter follows it. |

## UC-F16-03 Raise the score threshold

| | |
| --- | --- |
| Main flow | Leads scoring 60 to 69 won interest far less often than higher-scoring leads. The suggestion "Raise the score threshold to 70" is applied, and the campaign now writes only to leads scoring 70 or more. |

## UC-F16-04 Not enough data

| | |
| --- | --- |
| Main flow | A new campaign has 25 leads emailed. The report says no difference was large enough to trust yet, and suggests nothing. |

## UC-F16-05 Automatic lessons

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Turns on "Apply new lessons automatically". The next lesson found is applied straight away and Slack says "1 new lesson was applied to the copywriter". Threshold changes still wait for approval. |

## UC-F16-06 Remove a lesson

| | |
| --- | --- |
| Main flow | The owner removes a lesson from "Lessons the copywriter follows"; new emails are written without it. |
