# Luxury UI Redesign: Midnight & Brass

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Intent

Give the platform a professional, premium, luxury look and make it easier to use, without changing any feature. Every page, form, action, permission and URL keeps working exactly as before.

## Goals

- A premium visual identity: deep midnight navy with brass gold in dark mode, and a bright warm-white version in light mode.
- A working Dark / Light switch that each person can set; it is remembered in a cookie and applied on the server, so pages never flash the wrong theme. Until someone picks, the system preference decides.
- Better typography: Fraunces (serif) for headings and numbers, Plus Jakarta Sans for interface text.
- A grouped sidebar with icons holding all 20 workspace pages, replacing the single row of tabs.
- A friendlier Overview: a clear agent status line, a "Needs your attention" row built from real data, and plain-language stats.
- White-label keeps working: an agency's colour replaces brass, and button text automatically switches to dark or light so it stays readable.

## Non-goals

- No new features, no removed features, no route or database changes.
- No fake data. Every number and card on screen comes from the database.

## Anti-goals

- Any page that loses a control, a form field or a permission check.
- Text that fails contrast in either mode, or status labels that break across two lines.

## Approaches considered

1. **Design-system restyle (picked):** new design tokens and component styles in `globals.css`, a new sidebar shell in the workspace layout, and a small theme switch. Every page already uses the shared classes (`card`, `stats`, `table`, `btn`, `badge`, `field`), so all 20 pages and the sign-in, workspace and agency pages pick up the new look at once, with no risk to their logic.
2. **Component library (Tailwind/shadcn):** a larger dependency change that would mean rewriting every page's markup, with far more risk to features. Rejected.
3. **Restyle page by page with inline styles:** inconsistent and hard to maintain. Rejected.

## Design decisions

- **Tokens:** light tokens on `:root`. Dark tokens apply under `[data-theme="dark"]` and, for people who haven't picked a theme, under `@media (prefers-color-scheme: dark)`.
- **Default accent:** brass `#e0b878`, with the text on accent buttons computed for contrast. In light mode, links and accent text use a deeper brass so they stay readable on white.
- **Sidebar groups:**
  - Top: Home, Inbox, Notifications (unread count)
  - Sell: Campaigns, Leads, Deals, Meetings
  - Outreach: Calls, Texts, Templates, Playbook
  - Insights: Buying signals, Website visitors, Reports, AI learning
  - Manage: Email health, Setup, Team, Settings, API & webhooks
- **Behaviour:**
  - The active page is highlighted.
  - On phones the sidebar sits above the page and its links become one scrollable row.
  - A top bar has lead search (the leads page's existing `q` filter), the notifications bell, the person's email and Sign out.
- **Overview content:**
  - **Agent status line:** "All 17 AI agents are working", or "Outreach is paused" when the kill switch is on.
  - **Needs your attention:** open handoffs, emails waiting for approval, and warnings, each linking to the existing page that handles it.
  - **Kept as before:** the setup prompt, the stats, the channels and the kill switch, all restyled.
- **Fonts:** bundled with the app (Fontsource variable fonts, `font-display: swap`), so no request goes to a third party; system fonts are the fallback.
- **Pills and badges:** never wrap. Tables scroll sideways on small screens.

## Left to the builder

Exact spacing, shadow and hover details, provided both themes meet WCAG AA contrast.
