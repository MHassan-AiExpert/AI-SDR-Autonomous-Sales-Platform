# F03 — Web App: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Visitor | Not signed in |
| Owner | Created the workspace or was granted ownership |
| Admin | Manages settings, reps and viewers |
| Rep | Works leads and deals |
| Viewer | Read-only |

## UC-F03-01 Create an account

| | |
| --- | --- |
| Actor | Visitor |
| Main flow | 1. Opens `/signup`. 2. Enters a work email and a password. 3. Receives a confirmation email and opens the link. 4. Lands on the workspace list, signed in. |
| Alternatives | Malformed email, or password shorter than 10 characters or missing a letter or number: a message explains the rule and what was typed stays in the form. Expired or invalid link: returns to sign-in with a message. |

## UC-F03-02 Sign in and return to the intended page

| | |
| --- | --- |
| Actor | Visitor |
| Main flow | 1. Opens a workspace link while signed out. 2. Is sent to `/login`, which remembers the link. 3. Signs in. 4. Arrives at the page they asked for. |
| Alternatives | Wrong email or password: one message, "Email or password is incorrect." Unconfirmed email: asked to confirm first. A `next` address outside the app is ignored. |

## UC-F03-03 Sign out

| | |
| --- | --- |
| Actor | Any signed-in person |
| Main flow | Presses "Sign out"; the session ends and the sign-in page opens. |
| Rule | Sign-out only responds to a form post, never to a plain link |

## UC-F03-04 Create a workspace for a company

| | |
| --- | --- |
| Actor | Any signed-in person |
| Main flow | 1. Enters the company name on `/workspaces`. 2. The workspace is created on full autopilot with email, voice, SMS and WhatsApp on. 3. The person becomes owner and lands on the overview. |
| Alternative | Name shorter than 2 or longer than 120 characters: message shown, nothing created |

## UC-F03-05 Switch between workspaces

| | |
| --- | --- |
| Actor | A person who belongs to several workspaces (for example agency staff) |
| Main flow | Opens `/workspaces` and picks one. Each shows the person's role and whether outreach is paused. |
| Rule | Only workspaces the person belongs to are listed; any other workspace address shows "Page not found" |

## UC-F03-06 Add a team member

| | |
| --- | --- |
| Actor | Owner, Admin |
| Precondition | The new member already has an account |
| Main flow | 1. Opens Team. 2. Enters the member's email and picks a role. 3. The member appears in the list and the change is audited. |
| Alternatives | No account with that email: "Ask them to sign up first." Already a member: message shown. Admin choosing owner or admin: those roles are not offered, and the database refuses them. |

## UC-F03-07 Change a member's role or remove a member

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Picks a new role and presses "Change role", or presses "Remove". |
| Rules | Admins manage reps and viewers only. A person cannot change their own role from this screen. The last owner cannot be demoted or removed. |

## UC-F03-08 Run on cold email only

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Opens Settings, unticks AI voice calls, SMS, WhatsApp and LinkedIn, and saves. |
| Result | Only email is on; the overview shows each channel's state and the change is audited |

## UC-F03-09 Move to approval mode or hand meetings to people

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Chooses "Approval mode" so drafts wait for a person, or switches off the AI closer so booked meetings go to reps. |
| Result | Setting saved and audited |

## UC-F03-10 Pause all outreach instantly

| | |
| --- | --- |
| Actor | Owner, Admin |
| Main flow | Presses "Pause all outreach" on the overview. |
| Result | A banner on every workspace page says outreach is paused; the workspace list shows a "paused" badge; the button becomes "Resume outreach" |

## UC-F03-11 A rep or viewer opens settings

| | |
| --- | --- |
| Actor | Rep, Viewer |
| Main flow | Opens Settings or Team. |
| Result | Everything is visible but disabled or hidden: no save button, no kill switch, no add-member form |

## UC-F03-12 Someone tries to reach another company's workspace

| | |
| --- | --- |
| Actor | Signed-in person from another company, or a visitor |
| Main flow | Opens `/w/<another workspace id>` or submits a form with another workspace's ID. |
| Result | Visitor: sent to sign-in. Signed-in person: "Page not found"; forms report "no permission" and nothing changes. |
