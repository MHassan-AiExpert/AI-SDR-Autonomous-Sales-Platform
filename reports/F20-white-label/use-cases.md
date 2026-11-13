# F20 — White-Label Mode for Agencies: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Agency owner | Created the agency; full control |
| Agency admin | Manages clients, brand, defaults and the agency team |
| Agency staff | Follows client usage |
| Client | The agency's customer, working in its own workspace |
| Visitor | Anyone opening the agency's domain before signing in |

## UC-F20-01 Set up the agency

| | |
| --- | --- |
| Actor | Agency owner |
| Main flow | 1. Opens Agencies from the workspace list and creates "Northwind Growth". 2. Under Brand, sets the app name "Northwind Sales Cloud", a logo, the colour #0e7c66, a support email and the domain app.northwind.com. 3. Adds a CNAME record for the domain. |
| Result | app.northwind.com shows "Northwind Sales Cloud" with its logo and colour on the sign-in pages and in page titles |
| Alternative | The domain is already used by another agency: "Another agency already uses that domain." |

## UC-F20-02 Onboard a client

| | |
| --- | --- |
| Actor | Agency admin |
| Main flow | 1. Under New client workspace, enters "Bright Dental", plan Growth, 500 leads a month and 3 seats. 2. Opens the new workspace and invites the client's owner from Team. |
| Result | The workspace starts with the agency's default playbook and cadence. The client sees only the agency's brand |

## UC-F20-03 Build defaults once

| | |
| --- | --- |
| Actor | Agency admin |
| Main flow | Builds a strong playbook in one client workspace, then under Defaults chooses "Copy the playbook of Bright Dental" and sets 3 follow-ups and 120 emails a day. |
| Result | Every new client workspace starts with that playbook. Its campaigns start with 3 follow-ups and 120 emails a day |

## UC-F20-04 Month-end billing

| | |
| --- | --- |
| Actor | Agency staff |
| Main flow | Chooses Last 30 days and downloads the usage CSV: one row per client with leads, emails, calls and minutes, texts, meetings, deals won and revenue. Invoices each client from it. |

## UC-F20-05 Plan limit reached

| | |
| --- | --- |
| Actor | Client, then agency admin |
| Main flow | Bright Dental reaches 500 leads this month. Lead sourcing stops with "The monthly lead limit of your plan is reached. Ask your agency to raise it." The console shows the client at 100% and flagged. The admin raises the limit to 1,000 under "Change a client's plan and limits". |

## UC-F20-06 Client tries to upgrade itself

| | |
| --- | --- |
| Actor | Client owner |
| Main flow | Attempts to change its plan or seat limit through the API. |
| Result | Refused: "The plan and limits are managed by your agency." |

## UC-F20-07 Staff stay out of client records

| | |
| --- | --- |
| Actor | Agency staff |
| Main flow | Sees Bright Dental's usage counts in the console, but the client name is not a link and the workspace cannot be opened. Access needs a role from the workspace owner. |
