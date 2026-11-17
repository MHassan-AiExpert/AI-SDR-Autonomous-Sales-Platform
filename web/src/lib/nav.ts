// The workspace sidebar: every page of a workspace, grouped by what people do there.

export type IconName =
  | 'home' | 'inbox' | 'bell' | 'send' | 'users' | 'briefcase' | 'calendar' | 'phone' | 'chat' | 'doc' | 'book'
  | 'bolt' | 'eye' | 'chart' | 'spark' | 'shield' | 'check' | 'team' | 'gear' | 'code' | 'search';

export type NavItem = { href: string; label: string; icon: IconName };
export type NavGroup = { title: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  { title: null, items: [
    { href: '', label: 'Home', icon: 'home' },
    { href: '/inbox', label: 'Inbox', icon: 'inbox' },
    { href: '/notifications', label: 'Notifications', icon: 'bell' },
  ] },
  { title: 'Sell', items: [
    { href: '/campaigns', label: 'Campaigns', icon: 'send' },
    { href: '/leads', label: 'Leads', icon: 'users' },
    { href: '/deals', label: 'Deals', icon: 'briefcase' },
    { href: '/meetings', label: 'Meetings', icon: 'calendar' },
  ] },
  { title: 'Outreach', items: [
    { href: '/calls', label: 'Calls', icon: 'phone' },
    { href: '/texts', label: 'Texts', icon: 'chat' },
    { href: '/templates', label: 'Templates', icon: 'doc' },
    { href: '/playbook', label: 'Playbook', icon: 'book' },
  ] },
  { title: 'Insights', items: [
    { href: '/signals', label: 'Buying signals', icon: 'bolt' },
    { href: '/visitors', label: 'Website visitors', icon: 'eye' },
    { href: '/analytics', label: 'Reports', icon: 'chart' },
    { href: '/learning', label: 'AI learning', icon: 'spark' },
  ] },
  { title: 'Manage', items: [
    { href: '/deliverability', label: 'Email health', icon: 'shield' },
    { href: '/setup', label: 'Setup', icon: 'check' },
    { href: '/members', label: 'Team', icon: 'team' },
    { href: '/settings', label: 'Settings', icon: 'gear' },
    { href: '/developers', label: 'API & webhooks', icon: 'code' },
  ] },
];

/** Whether a sidebar link is the page being viewed (Home only on the workspace's own page). */
export function isActive(pathname: string, base: string, href: string): boolean {
  if (href === '') return pathname === base || pathname === `${base}/`;
  const target = base + href;
  return pathname === target || pathname.startsWith(`${target}/`);
}
