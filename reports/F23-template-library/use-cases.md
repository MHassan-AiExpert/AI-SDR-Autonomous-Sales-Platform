# F23 — Shared Template Library: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Save, apply, edit and remove workspace templates |
| Rep, Viewer | Read the library and see what each template does |
| Agency admin | Build the agency library and choose what new clients inherit |
| Agency staff | Read the agency library |
| Copywriting agent | Draws on the workspace's snippets |
| Reply agent | Draws on the playbook's objection answers |

## UC-F23-01 Keep a sequence that worked

| | |
| --- | --- |
| Actor | Owner |
| Trigger | The Austin campaign's four-step sequence is booking meetings |
| Main flow | 1. Campaign, Sequence. 2. Save this sequence as a template. 3. Names it "Dental four-touch" and describes it as "Email, then a call, then a text". |
| Result | "Saved as 'Dental four-touch'. Apply it to another campaign from the template library." Switched-off messages are not carried into it |

## UC-F23-02 Start a new campaign from it

| | |
| --- | --- |
| Actor | Owner |
| Main flow | 1. Templates. 2. Opens "Dental four-touch" and reads the step-by-step breakdown. 3. Apply to a campaign, picks Dallas. |
| Result | "4 steps written to the campaign. Check them before turning branching on." The messages arrive switched on |

## UC-F23-03 Applying over a campaign that is already running

| | |
| --- | --- |
| Trigger | The chosen campaign has already sent sequence steps |
| Main flow | The application is refused with a plain explanation that the record of what was sent would go with the old steps. |
| Result | Nothing is changed. If the owner really means it, they tick the box and apply again |

## UC-F23-04 Improving a template does not rewrite live campaigns

| | |
| --- | --- |
| Main flow | The owner rewrites step 1 on the Austin campaign after saving the template. |
| Result | The template is unchanged, and so is every campaign already built from it. To roll the change out, they save a new template or re-apply |

## UC-F23-05 Give the writer a case study to use

| | |
| --- | --- |
| Actor | Admin |
| Main flow | 1. Templates, Add a snippet. 2. Names it "Case study line" and writes the result in one sentence. |
| Result | "Snippet 'Case study line' saved. The copywriter will draw on it from the next run." The writer uses it where it fits rather than pasting it into every email |

## UC-F23-06 A prospect pushes back on price

| | |
| --- | --- |
| Actor | Reply agent |
| Trigger | A reply says the price looks high |
| Main flow | The agent classifies it as an objection. The team's own answer to "Too expensive" is in the prompt, taken from the active playbook. |
| Result | The drafted answer uses the team's wording instead of something invented. The same answers the AI closer has always used on calls |

## UC-F23-07 An agency builds its standard sequence

| | |
| --- | --- |
| Actor | Agency admin |
| Main flow | 1. Builds and proves the sequence in one client workspace. 2. Saves it as a template there. 3. Agency console, Template library, copies it up and ticks "give it to every new client workspace". |
| Result | "…is in the agency library and every new client workspace will start with it." |

## UC-F23-08 A new client starts with the agency's library

| | |
| --- | --- |
| Actor | Agency admin |
| Main flow | Creates the workspace for Bright Dental from the agency console. |
| Result | The workspace is created with its own copy of every default template, next to the default playbook and cadence it already inherited. Non-default agency templates are not copied |

## UC-F23-09 A client tailors what it inherited

| | |
| --- | --- |
| Actor | Client owner |
| Main flow | Edits the inherited snippet to mention their own city. |
| Result | Their copy changes. The agency's original is untouched, and other clients are unaffected |

## UC-F23-10 A client cannot edit the agency's library

| | |
| --- | --- |
| Actor | Client owner |
| Main flow | Tries to change an agency template directly. |
| Result | Refused by row-level security. They can read it, and they own their copy |

## UC-F23-11 Reusing a name

| | |
| --- | --- |
| Main flow | A second snippet is named "case study line" in lower case. |
| Result | "A snippet already uses that name. Pick another." A sequence may still use the same name, because the two kinds are counted separately |

## UC-F23-12 Removing a template

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Removes a template that is no longer used. |
| Result | "…removed from the library. Campaigns already built from it are untouched." |

## UC-F23-13 A rep looks for the sequence

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Opens Templates. |
| Result | Reads every template and what each one does. No save, apply or edit controls appear, and the database refuses the write regardless |
