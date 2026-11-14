# F23 — Shared Template Library: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/templates.test.mjs`) | `npm test` | **15 passed, 0 failed** |
| Agent (`agents/tests/templates.test.ts`) | `cd agents && npm test` | **8 passed, 0 failed** |
| Web unit (`web/tests/templates.test.ts`) | `cd web && npm test` | **14 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed**, run twice |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 231, agents 292, web 151 | **674 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TPL-01 | An owner saves a campaign's sequence; a rep and a viewer try the same | The owner's template is written with the right scope and kind; both others refused by row-level security | Pass |
| TPL-02 | What the saved template holds | Both steps with their positions, channels, waits, conditions and ending; the switched-off message is **not** carried into it | Pass |
| TPL-03 | Saving a campaign that has no sequence | "That campaign has no sequence to save" | Pass |
| TPL-04 | Applying the template to another campaign | Two steps and three messages recreated in order, conditions intact, messages switched on | Pass |
| TPL-05 | A rep applies a template | "Only owners and admins can apply a template" | Pass |
| TPL-06 | Rewriting the source campaign after saving | The template is unchanged: it is a snapshot | Pass |
| TPL-07 | Applying over a campaign that has already sent a step, then saying so plainly | Refused with the count in the message; then it goes ahead, and the old record goes with the old steps | Pass |
| TPL-08 | A second snippet with the same name in another case; the same name for a different kind | The duplicate is refused; the other kind is allowed | Pass |
| TPL-09 | A template with both owners, and with neither | Both refused by the check constraint | Pass |
| TPL-10 | A workspace template marked as a default; an agency template marked as one | The workspace one is refused; the agency one is allowed | Pass |
| TPL-11 | Another workspace reads, writes and applies here | Sees nothing; the write and the apply are both refused | Pass |
| TPL-12 | A workspace outside the agency reads and writes the agency library; the agency owner reads it | Sees nothing and cannot write; the agency owner reads it | Pass |
| TPL-13 | A new client workspace created from the agency console | Starts with a copy of both default templates and **not** the non-default one; editing the copy leaves the agency original alone | Pass |
| TPL-14 | A workspace created outside any agency | Inherits nothing | Pass |
| TPL-15 | A visitor reads the table and calls both functions | All three refused | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TPLA-01 | Snippets passed to the writer | They appear in their own block, each with its name | Pass |
| TPLA-02 | No snippets | No empty block; the playbook still reaches the writer | Pass |
| TPLA-03 | A 5,000-character snippet | Cut, so the block stays under about 2,000 characters | Pass |
| TPLA-04 | A snippet carrying an instruction | Quoted as copy inside the block, where the system prompt's standing rule covers it | Pass |
| TPLA-05 | Objection answers passed to the reply agent | They appear in their own block, in the team's wording, before the reply | Pass |
| TPLA-06 | No objection answers | No empty block; the offer and the reply still reach the model | Pass |
| TPLA-07 | Twenty answers, each 900 characters | Twelve at most, each capped at 600 | Pass |
| TPLA-08 | A 9,000-character reply | The reply still comes last and is cut at 6,000 characters | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WTPL-01 | Steps out of order, with nulls and nonsense among them | Returned in order, the malformed ones ignored | Pass |
| WTPL-02 | A payload that is not a sequence | No steps, rather than an error | Pass |
| WTPL-03 | A snippet body, and a missing one | Read; missing gives an empty string | Pass |
| WTPL-04 | A three-step template across three channels | "3 steps — Email, AI call, SMS — 4 messages." | Pass |
| WTPL-05 | A template with no closing step | The summary says so | Pass |
| WTPL-06 | A template that uses email twice in a row | The channel is not repeated in the summary | Pass |
| WTPL-07 | An empty template | "No steps." rather than a misleading summary | Pass |
| WTPL-08 | Each step read back | "Step 1: Email straight away, when always, once the wait has passed. 2 messages, split evenly." and the last step says the sequence stops | Pass |
| WTPL-09 | A condition the library did not write | Named as set outside this screen, not guessed at | Pass |
| WTPL-10 | An inherited template against your own | Distinguished | Pass |
| WTPL-11 | Both kinds | Labelled | Pass |
| WTPL-12 | Saving a sequence with a blank, over-long or over-described name | All refused | Pass |
| WTPL-13 | A snippet with no name, no body, or an over-long body | All refused | Pass |
| WTPL-14 | Stray spaces around a name and body | Trimmed before saving | Pass |

## Defects found and fixed during this feature

| Defect | How it was found | Fix |
| --- | --- | --- |
| Applying a template would have silently deleted the record of which lead got which step, because `lead_step_runs` cascades from `sequence_steps` | Tracing the cascade before trusting the delete-and-rebuild approach | Refused unless the caller passes `p_replace_sent`, with the count in the message. TPL-07 |
| `templates` was added to the tenancy suite's tenant-table list, which requires a mandatory `workspace_id` | DB-03 failed | Removed: an agency template has no workspace, so it is dual-scope like `agency_brands`. Isolation is tested directly in TPL-11 and TPL-12 |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-48 | `templates` with row security, both scope constraints, both functions `security invoker`, the workspace-creation trigger, visitors refused | **Pending** — the database connector's confirmation went unanswered when the feature was finished |

The migration applies cleanly to a local Postgres on every test run, which is how all 15 database tests above execute.

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-91 | Save a working sequence as a template, then apply it to a fresh campaign | The steps and messages arrive intact and switched on |
| ACC-92 | Apply a template to a campaign that has already sent steps | Refused, with the count; allowed once the box is ticked |
| ACC-93 | Add a snippet, then run the copywriter | The snippet's idea appears in some drafts, never pasted into all of them |
| ACC-94 | Send an objection reply to a campaign with playbook objections | The drafted answer uses the team's wording |
| ACC-95 | Mark an agency template as a default, then create a client workspace | The new workspace starts with a copy; an older client is untouched |
