# F03 — Web App: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Unit tests (`web/tests/`) | `cd web && npm test` | **22 passed, 0 failed** |
| Database tests (`tests/db/team.test.mjs`) | `npm run test:db` | **9 passed, 0 failed** |
| Browser tests (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** |
| Build and type check | `npm run build`, `npm run typecheck` | Passed |

## Unit tests: roles

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WEB-01 | Who manages settings and the kill switch | Owner and admin only | Pass |
| WEB-02 | Who can delete a workspace | Owner only | Pass |
| WEB-03 | Roles each actor can hand out | Owner: all four; admin: rep and viewer; rep and viewer: none | Pass |
| WEB-04 | Admin managing owners and admins | Refused; reps and viewers allowed | Pass |
| WEB-05 | Owner, rep and viewer managing members | Owner: everyone; rep and viewer: no one | Pass |
| WEB-06 | Who sees the add-member form | Owner and admin | Pass |
| WEB-07 | Unknown role values | Rejected | Pass |

## Unit tests: validation

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WEB-08 | Valid email with spaces and capitals, strong password | Accepted; email trimmed and lower-cased | Pass |
| WEB-09 | Five malformed emails | All rejected | Pass |
| WEB-10 | Passwords: too short, no letter, no number, too long, valid | Specific message for each; valid accepted | Pass |
| WEB-11 | Sign-in with empty password; sign-in with an old short password | First rejected; second accepted (sign-up rules do not lock out existing accounts) | Pass |
| WEB-12 | Workspace names: padded, 1 character, 121 characters | Trimmed; too short and too long rejected | Pass |
| WEB-13 | Add member with unknown role or bad email | Rejected | Pass |
| WEB-14 | Identifier that is not a UUID, including an SQL injection string | Rejected | Pass |
| WEB-15 | Settings form with only email ticked | Other channels and AI closer read as off | Pass |
| WEB-16 | Settings form with everything ticked, approval mode | All channels on, approval, AI closer on | Pass |
| WEB-17 | Unknown automation mode; extra fields such as plan or kill switch | Mode rejected; extra fields dropped | Pass |
| WEB-18 | In-app `next` path | Kept | Pass |
| WEB-19 | Nine unsafe `next` values (absolute URL, `//host`, backslash, script, header injection) | All replaced with `/workspaces` | Pass |

## Unit tests: error messages

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WEB-20 | Database errors for permission, unknown email, duplicate member, last owner | Clear fixed message for each | Pass |
| WEB-21 | Unexpected database error containing table names | Generic message; no internal detail | Pass |
| WEB-22 | Auth errors | Wrong credentials give one message; unconfirmed email and rate limit explained | Pass |

## Database tests: team functions

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| TEAM-01 | Viewer lists the team | Four members with emails and roles | Pass |
| TEAM-02 | Another company and an outsider list the team | No rows | Pass |
| TEAM-03 | Anonymous visitor calls either function | Permission denied | Pass |
| TEAM-04 | Owner adds an account by email with spaces and capitals | Added with the chosen role | Pass |
| TEAM-05 | Owner adds an unknown email | Rejected: no account found | Pass |
| TEAM-06 | Owner adds an existing member | Rejected: already a member | Pass |
| TEAM-07 | Admin adds an admin, an owner, a viewer | First two rejected; viewer added | Pass |
| TEAM-08 | Rep, viewer and outsider add a member | All rejected | Pass |
| TEAM-09 | Audit log after adding a member | One entry with the actor | Pass |

## Browser tests: running application

Run in Chromium against the production build.

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| E2E-01 | Open the landing page | Sign-up and sign-in links present | Pass |
| E2E-02 | Open `/workspaces` signed out | Redirected to `/login?next=/workspaces` | Pass |
| E2E-03 | Open overview, team and settings of a workspace signed out | Redirected to sign-in; destination remembered | Pass |
| E2E-04 | Submit sign-in empty | "Enter your email address" | Pass |
| E2E-05 | Sign in with a malformed email | "Enter a valid email address" | Pass |
| E2E-06 | Sign up with a short password, no number, no letter | Matching message each time | Pass |
| E2E-16 | Submit sign-up with an error | The email typed is still in the field | Pass |
| E2E-07 | Sign up with a malformed email | "Enter a valid email address" | Pass |
| E2E-08 | Network requests during all rejected forms | None reach the auth service | Pass |
| E2E-09 | `/login?next=` with three external addresses | Hidden destination is `/workspaces` | Pass |
| E2E-10 | Open confirmation routes with no code, no token, bad type | Back to sign-in with "invalid or has expired" | Pass |
| E2E-11 | GET `/auth/signout` | 405 Method Not Allowed | Pass |
| E2E-12 | Response headers on `/login` | HSTS, no-sniff, frame deny, referrer policy; no `X-Powered-By` | Pass |
| E2E-13 | Open an unknown address | 404 with the not-found page | Pass |
| E2E-14 | Labels and autocomplete on sign-up and sign-in | Fields labelled; `email`, `new-password`, `current-password` | Pass |
| E2E-15 | Landing, sign-in and sign-up at phone width | No sideways scrolling | Pass |

## Live database check

| ID | Check | Expected result | Actual |
| --- | --- | --- | --- |
| LIVE-05 | On the hosted database, inside a rolled-back transaction: owner adds a rep by email in mixed case, adds an unknown email, adds the same person twice; the rep tries to add someone; an outsider lists the team | Rep added; unknown and duplicate refused; rep refused; outsider sees no rows | Pass |

## Signed-in acceptance walkthrough

Performed in a browser with real accounts after each release.

| ID | Step | Expected result |
| --- | --- | --- |
| ACC-01 | Sign up with a real email and open the confirmation link | Signed in on the workspace list |
| ACC-02 | Create a workspace | Overview opens; role shows Owner; automation shows Full autopilot |
| ACC-03 | Settings: untick SMS, choose Approval mode, save | "Settings saved."; overview shows SMS off and Approval mode |
| ACC-04 | Overview: press "Pause all outreach" | Banner appears on every page; button becomes "Resume outreach" |
| ACC-05 | Team: add a second confirmed account as Sales rep | Member listed as Sales rep |
| ACC-06 | Team: add an email with no account | "No account found for this email. Ask them to sign up first." |
| ACC-07 | Sign in as the rep; open Settings and Team | Fields disabled, no save button, no kill switch, no add-member form |
| ACC-08 | As the rep, open another company's workspace address | "Page not found" |
| ACC-09 | As the owner, change the rep to Viewer, then remove them | Role changes; member disappears; rep no longer sees the workspace |
| ACC-10 | Sign out | Sign-in page; workspace addresses redirect to sign-in |
