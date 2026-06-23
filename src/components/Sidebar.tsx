/**
 * App-wide vertical navigation, rebuilt on Capra
 * `VerticalNavigation`. Item state is router-driven — we read
 * `useLocation` for the active path and pass `isActive` per item.
 * Click navigation is handled by the CapraRouterBridge wired in
 * App.tsx, which delegates Capra `href` clicks back into React
 * Router.
 *
 * The icon set is intentionally still our hand-rolled SVGs for
 * now; a follow-up wave can swap to `@capra/icons` equivalents
 * once we've mapped each one (Capra uses `<SvgIcon>` components
 * from a fixed catalog — not 1:1 with our current set).
 */
import { useLocation } from 'react-router-dom';
import { VerticalNavigation } from '@capra/core';

interface NavItem {
  label: string;
  to: string;
  /** Exact-match override. Defaults to startsWith on `to`. */
  exact?: boolean;
  icon: React.ReactNode;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const sections: NavItem[][] = [
  [
    {
      label: 'Overview',
      to: '/',
      exact: true,
      icon: (
        <svg {...ICON_PROPS}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      ),
    },
    {
      label: 'Services',
      to: '/services',
      icon: (
        <svg {...ICON_PROPS}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v6m0 6v6M1 12h6m6 0h6" />
        </svg>
      ),
    },
    {
      label: 'Service Map',
      to: '/map',
      icon: (
        <svg {...ICON_PROPS}>
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 6h8M6 8v8M18 8v8M8 18h8" />
        </svg>
      ),
    },
  ],
  [
    {
      label: 'Traces',
      to: '/traces',
      icon: (
        <svg {...ICON_PROPS}>
          <path d="M3 12h4l3-9 4 18 3-9h4" />
        </svg>
      ),
    },
    {
      label: 'Logs',
      to: '/logs',
      icon: (
        <svg {...ICON_PROPS}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      ),
    },
    {
      label: 'Metrics',
      to: '/metrics',
      icon: (
        <svg {...ICON_PROPS}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      ),
    },
  ],
  [
    {
      label: 'Alerts',
      to: '/alerts',
      icon: (
        <svg {...ICON_PROPS}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      label: 'Errors',
      to: '/errors',
      icon: (
        <svg {...ICON_PROPS}>
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      ),
    },
  ],
  [
    {
      label: 'Investigate',
      to: '/investigate',
      icon: (
        <svg {...ICON_PROPS}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
          <path d="M11 8v3l2 2" />
        </svg>
      ),
    },
  ],
];

const settingsItem: NavItem = {
  label: 'Settings',
  to: '/settings',
  icon: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

/** Decide whether a nav entry is the active one for the current route.
 *  Mirrors react-router's `<NavLink end>` semantics — `exact` items
 *  must match the path fully, others match on prefix. */
function pathMatches(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export default function Sidebar() {
  const location = useLocation();
  return (
    <VerticalNavigation defaultCollapsed={false}>
      {sections.map((section, si) => (
        <VerticalNavigation.ItemList key={si}>
          {section.map((item) => (
            <VerticalNavigation.Item
              key={item.to}
              label={item.label}
              href={item.to}
              icon={item.icon}
              isActive={pathMatches(location.pathname, item)}
            />
          ))}
        </VerticalNavigation.ItemList>
      ))}
      <VerticalNavigation.Footer>
        <VerticalNavigation.Item
          label={settingsItem.label}
          href={settingsItem.to}
          icon={settingsItem.icon}
          isActive={pathMatches(location.pathname, settingsItem)}
        />
      </VerticalNavigation.Footer>
    </VerticalNavigation>
  );
}
