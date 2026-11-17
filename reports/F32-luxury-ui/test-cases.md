# F32 — Midnight & Brass Interface: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Web unit (`web/tests/theme.test.ts`, `nav.test.ts`, `overview.test.ts`, `white-label.test.ts`) | `cd web && npm test` | **205 passed, 0 failed** (8 new, WWL-01 updated) |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **21 passed, 0 failed**, including the new E2E-21 |
| Type checks and build | `npm run typecheck`, `npm run build` | Passed |
| Full regression | root 283, agents 389, web 205 | **877 passed, 0 failed** |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| THM-01 | Theme cookie values `dark`, `light`, empty, `Dark`, `system`, `<script>`, `dark;` | Only `dark` and `light` are accepted | Pass |
| THM-02 | Button text on brass, pale grey, deep green and teal | Dark text on brass and pale grey, white text on green and teal; dark text for an invalid colour | Pass |
| THM-03 | Return paths `//evil.test`, `https://evil.test`, `/\evil.test`, empty, a relative path | All become `/workspaces`; a real path such as `/w/1/leads?q=kim` is kept | Pass |
| NAV-01 | Sidebar contents | Exactly the 20 existing workspace addresses, once each, in the groups Main, Sell, Outreach, Insights and Manage | Pass |
| NAV-02 | Highlighting | Home only on the workspace page itself; Leads on `/leads` and `/leads/123` but not on `/leadsx` | Pass |
| OVW-01 | Attention cards with counts 0/0/0, 2/38/1, 1/0/0 and 0/5/0 | Nothing shown at zero; links to handoffs, campaigns and warnings; singular and plural titles | Pass |
| OVW-02 | Status line | "All 17 AI agents are working", or the paused message | Pass |
| OVW-03 | Greeting time zone | 10:30 UTC is 15 in Asia/Karachi; an unknown or missing zone falls back to UTC; morning, afternoon and evening | Pass |
| WWL-01 (updated) | Agency colour style | `--accent` plus readable `--accent-text` (white on `#0e7c66`, dark on `#f5d77a`) | Pass |

## Browser

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-21 | Choose dark, reload; switch with outside return addresses; send a tampered theme | 303 back to the same page; `data-theme="dark"` and a midnight background on the next load; outside addresses return to `/workspaces` on this site; a tampered value clears the choice | Pass |
| E2E-03 | Every workspace page while signed out | Still redirected to sign-in with the destination kept | Pass |
| E2E-15 | Phone width | No sideways scrolling | Pass |
| E2E-12 | Security headers | Unchanged and present | Pass |

## Visual review

| Check | Result |
| --- | --- |
| Overview shell in dark and light at 1440 × 1000 | Matches the approved design; the sidebar holds all 20 pages |
| Phone at 390 px | Page width 390, no overflow |
| Fonts | Fraunces Variable and Plus Jakarta Sans Variable loaded (`document.fonts.check` true) |
| Sign-in page in dark | Brass button with dark text, readable fields |
