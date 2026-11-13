# F21 — CSV Import and Bulk Actions: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Import, bulk-edit and undo imports |
| Rep | Import and bulk-edit; cannot undo |
| Viewer | Reads the lead list; no import, no bulk actions |

## UC-F21-01 Bring your own list

| | |
| --- | --- |
| Actor | Rep |
| Trigger | The team already has 800 leads in a spreadsheet |
| Main flow | 1. Leads, Import CSV. 2. Picks the file. The columns are matched automatically. 3. Checks the preview: 800 rows read, 764 with a usable contact. 4. Picks the Austin campaign. 5. Imports. |
| Result | "712 leads added, 38 already here, 14 on the suppression list, 36 without a usable contact." The leads appear with the source Imported file, ready for enrichment and research |

## UC-F21-02 Columns the system does not recognise

| | |
| --- | --- |
| Main flow | The file uses "Contact Person" and "Biz Phone". Automatic matching misses them, so the rep picks them by hand from the dropdowns. The preview updates as each is chosen. |

## UC-F21-03 Someone who opted out is on the list

| | |
| --- | --- |
| Trigger | A bought list contains an address that unsubscribed last month |
| Result | That row is counted as suppressed and no lead is created. Nobody has to remember who opted out |

## UC-F21-04 Wrong file

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Realises the file was last quarter's list. Opens Import, finds it under Recent imports, clicks Undo. |
| Result | The leads that were still untouched are removed. Any that had already been emailed or called stay, with their history |
| Alternative | A rep tries: "Only owners and admins can undo an import." |

## UC-F21-05 A file with no usable rows

| | |
| --- | --- |
| Main flow | The file holds only company names and addresses, no email, phone or LinkedIn. The preview says no row has a usable contact and the import button is replaced by a note to check the column matching. |

## UC-F21-06 Tidy up a list

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Filters leads to Not interested, selects them all, chooses Change stage and sets Do not contact. |
| Result | "24 leads moved to Do not contact." |

## UC-F21-07 Suppress a competitor's staff

| | |
| --- | --- |
| Actor | Admin |
| Main flow | Searches the list for a competitor's domain, selects those leads, chooses Suppress. |
| Result | Their emails and phones go on the suppression list and their stage becomes Do not contact. No agent contacts them on any channel, and a future import of the same list skips them |

## UC-F21-08 Share the work

| | |
| --- | --- |
| Actor | Rep |
| Main flow | Selects the leads scoring over 80 and chooses Assign owner, Me. |
| Result | "31 assigned to you." |
