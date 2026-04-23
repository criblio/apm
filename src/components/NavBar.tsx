import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useState, type KeyboardEvent } from 'react';
import s from './NavBar.module.css';

interface SimpleTab {
  label: string;
  to: string;
  end?: boolean;
}

interface DropdownTab {
  label: string;
  activePrefix: string;
  children: Array<{ label: string; to: string }>;
}

type NavItem = SimpleTab | DropdownTab;

function isDropdown(item: NavItem): item is DropdownTab {
  return 'children' in item;
}

const tabs: NavItem[] = [
  { label: 'Home', to: '/', end: true },
  {
    label: 'Services',
    activePrefix: '/services',
    children: [
      { label: 'List', to: '/services' },
      { label: 'Architecture', to: '/services/architecture' },
    ],
  },
  { label: 'Search', to: '/search' },
  { label: 'Logs', to: '/logs' },
  { label: 'Metrics', to: '/metrics' },
  { label: 'Alerts', to: '/alerts' },
  { label: 'Compare', to: '/compare' },
  { label: 'Investigate', to: '/investigate' },
];

function DropdownNavItem({ item }: { item: DropdownTab }) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(item.activePrefix);

  return (
    <div className={s.dropdownWrap}>
      <NavLink
        to={item.children[0].to}
        className={`${s.tab} ${isActive ? s.tabActive : ''}`}
      >
        {item.label}
        <svg
          className={s.chevron}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </NavLink>
      <div className={s.dropdown}>
        {item.children.map((child) => (
          <NavLink
            key={child.to}
            to={child.to}
            end
            className={({ isActive: childActive }) =>
              `${s.dropdownItem} ${childActive ? s.dropdownItemActive : ''}`
            }
          >
            {child.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

export default function NavBar() {
  const navigate = useNavigate();
  const [traceId, setTraceId] = useState('');

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && traceId.trim()) {
      navigate(`/trace/${traceId.trim()}`);
      setTraceId('');
    }
  }

  return (
    <nav className={s.navbar}>
      <NavLink to="/" end className={s.brand}>
        <svg className={s.brandIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        Cribl APM
      </NavLink>

      <div className={s.tabs}>
        {tabs.map((t) =>
          isDropdown(t) ? (
            <DropdownNavItem key={t.label} item={t} />
          ) : (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => `${s.tab} ${isActive ? s.tabActive : ''}`}
            >
              {t.label}
            </NavLink>
          ),
        )}
      </div>

      <NavLink
        to="/settings"
        className={({ isActive }) => `${s.iconBtn} ${isActive ? s.iconBtnActive : ''}`}
        title="Settings"
        aria-label="Settings"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </NavLink>

      <div className={s.spacer} />

      <input
        className={s.traceInput}
        type="text"
        placeholder="Lookup by Trace ID…"
        value={traceId}
        onChange={(e) => setTraceId(e.target.value)}
        onKeyDown={handleKey}
      />
    </nav>
  );
}
