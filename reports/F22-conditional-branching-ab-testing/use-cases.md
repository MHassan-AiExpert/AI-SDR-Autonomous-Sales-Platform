# F22 — Conditional Branching and A/B Testing: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Build and change the sequence, turn branching and open tracking on or off, run what is due |
| Rep | Reads the sequence and the message comparison; cannot change either |
| Viewer | Reads the sequence |
| Sequence agent | Picks the step for each lead and sends it |

## UC-F22-01 Replace the fixed cadence with a real sequence

| | |
| --- | --- |
| Actor | Owner |
| Trigger | Emails every three days are being ignored, and the team wants calls in the mix |
| Main flow | 1. Campaign, Sequence. 2. Adds step 1: email, no wait, always. 3. Adds step 2: AI call after 2 days, when they were emailed and have not replied. 4. Adds step 3: SMS after a day, when the call reached voicemail. 5. Adds step 4: email after 3 days, when nothing has worked on any channel, marked as the last step. 6. Ticks "use the sequence instead of the fixed email cadence". |
| Result | "Branching is on. The sequence below now decides each step, instead of the fixed email cadence." The old cadence stops governing this campaign |

## UC-F22-02 A voicemail takes a different path

| | |
| --- | --- |
| Actor | Sequence agent |
| Trigger | Step 2 called a lead and reached voicemail |
| Main flow | On the next run the agent reads the lead's facts: emailed once, one call made, last outcome voicemail, no reply. Step 3's condition fits; step 4's does not. |
| Result | The lead gets the text. A lead whose call simply rang out skips the text and waits for step 4 instead |

## UC-F22-03 Someone replies and the chase stops

| | |
| --- | --- |
| Trigger | A lead answers the first email |
| Main flow | Every later step is conditioned on not having replied, so none of them fits any more. |
| Result | No further step is sent. Nothing had to be cancelled, and no step was consumed |

## UC-F22-04 Test two openers against each other

| | |
| --- | --- |
| Actor | Admin |
| Main flow | 1. Opens step 1. 2. Writes message A as it stands. 3. Adds message B with a different subject and first line. 4. Leaves both active. |
| Result | Leads are split evenly and which message each was sent is recorded. The sequence screen shows sends and the share per message; the weekly learning report says whether the difference is big enough to trust |

## UC-F22-05 A winner emerges

| | |
| --- | --- |
| Trigger | The learning report reports that message B won interest 25.0% of the time against 5.0% for the rest, on 60 leads each side |
| Main flow | The admin opens step 1 and unticks "send this message" on A. |
| Result | Only B is sent from now on. A's past results stay in the comparison, so the decision can still be seen later |

## UC-F22-06 A step the lead cannot receive

| | |
| --- | --- |
| Trigger | A lead has an email address but no phone, and step 2 is an AI call |
| Main flow | The call step does not fit, so the agent moves on and the lead takes the next step it can receive. The call step is not marked as used. |
| Result | If enrichment finds a phone next week, the call step is still there for that lead |

## UC-F22-07 A sequence that would never run

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Adds a step conditioned on "they opened an email and have not replied" while open tracking is off. |
| Result | The screen says: "Step 3 depends on email opens, so turn on open tracking below or the step will never run." Nothing is sent on a condition that cannot be met |

## UC-F22-08 Forgetting to end the sequence

| | |
| --- | --- |
| Main flow | Four steps, none marked as the last one. |
| Result | "No step is marked as the last one, so leads who reach the end are simply left alone." The sequence still runs; the warning is about what happens at the end |

## UC-F22-09 A rep tries to change the sequence

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Opens the sequence screen. |
| Result | Reads the steps, the messages and the comparison. No edit controls appear, and the database refuses the write regardless. A sequence decides who gets contacted on which channel, so it is treated as campaign settings |

## UC-F22-10 The agent is asked to run twice

| | |
| --- | --- |
| Trigger | The run button is pressed, and the scheduled run lands moments later |
| Main flow | The first run records each step it sent. The second reads the same leads, sees those steps already recorded, and moves past them. |
| Result | Nobody is contacted twice. The second run reports the leads it passed over and why |

## UC-F22-11 A lead who may not be texted

| | |
| --- | --- |
| Trigger | A step is an SMS, and the lead has no recorded consent for texts |
| Main flow | The same consent gate the text agent uses refuses it. |
| Result | Nothing is sent and the run reports "no recorded consent to receive texts" among its reasons. Branching is not a way around consent |

## UC-F22-12 Going back to the fixed cadence

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Unticks "use the sequence instead of the fixed email cadence". |
| Result | "Branching is off. The fixed email cadence is in charge again." The sequence and its history are kept, so it can be switched back on |
