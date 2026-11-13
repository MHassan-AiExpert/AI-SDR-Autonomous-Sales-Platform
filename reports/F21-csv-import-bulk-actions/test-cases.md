# F21 — CSV Import and Bulk Actions: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/csv-import.test.mjs`) | `npm run test:db` | **11 passed, 0 failed** |
| Web unit (`web/tests/csv-import.test.ts`) | `cd web && npm test` | **6 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **17 passed, 0 failed**, run twice |
| Type checks, lint and build | `npm run typecheck`, `npm run lint`, `npm run build` | Passed |
| Full regression | root 203, agents 263, web 123 | **589 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CSV-01 | A clean two-row file | Both added; email lower-cased and trimmed; phone reduced to digits; source `csv`; filename kept; linked to the campaign and the import | Pass |
| CSV-02 | No contact; malformed email; 3-digit phone; LinkedIn URL on another domain; a valid international phone | 4 invalid, 1 added, phone normalized to `+442079460958` | Pass |
| CSV-03 | A lead that already exists, and the same new address twice in one file | 1 added, 2 duplicates; the first occurrence wins; no second row for the existing lead | Pass |
| CSV-04 | A suppressed email, a suppressed phone, a suppressed domain, and one allowed | 3 suppressed, 1 added | Pass |
| CSV-05 | A viewer imports; another workspace's owner imports into this one | Both refused by row-level security; nothing written | Pass |
| CSV-06 | 5,001 rows; a payload that is not a list | "Import up to 5000 rows at a time"; "The rows must be a list" | Pass |
| CSV-07 | Undo an import where one lead was worked and one has an activity | Only the untouched lead is removed; the other two stay; the import is marked undone | Pass |
| CSV-08 | A rep undoes; an owner undoes; the owner undoes again | Refused; 1 removed; "already been undone" | Pass |
| CSV-09 | A viewer reads imports; another workspace reads; an owner deletes | Viewer reads; other workspace sees nothing; delete denied | Pass |
| CSV-10 | Files where **every** row is filtered: all suppressed, all invalid, all duplicates, then one of each | Counts correct in every case, including `{added: 1, duplicates: 1, suppressed: 1, invalid: 1}` | Pass |
| CSV-11 | Two rows naming the same company in different cases | One company created, both leads linked to it | Pass |

CSV-10 and CSV-11 were written after they each caught a real defect. See "Defects found" below.

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WCSV-01 | Quoted fields, embedded commas, doubled quotes, CRLF, byte order mark | Parsed exactly, quotes unescaped | Pass |
| WCSV-02 | Blank lines; no trailing newline; an empty file | Blanks dropped; last row kept; empty gives no rows | Pass |
| WCSV-03 | Headings as real exports write them; "Email Status" beside "Email Address"; headings that match nothing | All six matched; the exact heading preferred over a partial match; no guesses when nothing fits | Pass |
| WCSV-04 | Building rows from the mapping | Values trimmed; unmapped fields left out entirely | Pass |
| WCSV-05 | Usable by email, by phone, by LinkedIn; unusable with all three malformed | Correct in each case; preview counts right | Pass |
| WCSV-06 | Describing a result | "98 leads added, 15 already here, 7 on the suppression list, 3 without a usable contact."; singular for one; only what happened is mentioned | Pass |

## Defects found and fixed during this feature

| Defect | How it was found | Fix |
| --- | --- | --- |
| Counts were computed from a table holding only surviving rows, so a file where **everything** was suppressed reported 0 suppressed | Reviewing the restructure before trusting it | Every cleaned row is kept with a flag per decision; counts are counts of flags. Covered by CSV-10 |
| Companies were deduplicated case-sensitively, so "Northwind Dental" and "northwind dental" made two records | CSV-11 failed on first run | `distinct on (lower(name))`, ordered so the first spelling wins |
| A rep undoing an import would have marked it undone while deleting nothing, because deleting leads is owner-only | Reading the function against the delete policy | The function raises unless the caller is an owner or admin. Covered by CSV-08 |
| Browser checks reported 1 failure on the first run | Ran them again | The server was not warm after a fixed 6-second wait. Re-run against a ready server: 17/17 twice |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-43 | `lead_imports` with row security; `leads.import_id`; both functions security invoker; visitors refused | **Pending** — the database connector was unavailable when the feature was finished |

The migration applies cleanly to a local Postgres on every test run, which is how all 11 database tests above execute.

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-82 | Import a real CSV of 100+ leads | Counts match the file; leads appear with source Imported file |
| ACC-83 | Import the same file again | Every row reported as already here; no duplicates created |
| ACC-84 | Select leads and suppress them, then re-import them | They are reported as suppressed, not added |
| ACC-85 | Undo an import after emailing some of its leads | Only the untouched leads are removed |
