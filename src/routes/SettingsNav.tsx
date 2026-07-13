/**
 * Sticky section nav for the Settings page. Each entry scrolls to
 * the corresponding card via anchor href. The active entry is
 * highlighted based on which section is in view, updated via
 * IntersectionObserver — so scrolling the content auto-syncs the
 * highlight without a click.
 *
 * Clicks preventDefault + call scrollIntoView() directly instead
 * of relying on the browser to follow the `#id` hash. React
 * Router v7's BrowserRouter intercepts anchor clicks inside the
 * app; a bare `#id` href routes to `/#id` which doesn't match any
 * app route and falls through to Home. Same failure shape as the
 * Wave 1 sidebar regression (PR #94). Keep the `href` attribute
 * for right-click-copy-link + a11y.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import s from './SettingsNav.module.css';

export interface NavGroup {
  /** Group title shown in the nav. */
  title: string;
  /** Sections under this group. */
  items: NavItem[];
}

export interface NavItem {
  id: string;
  label: string;
}

interface Props {
  groups: readonly NavGroup[];
}

export default function SettingsNav({ groups }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  };

  // Observe each section's visibility; the topmost one whose top is
  // above the middle of the viewport wins the highlight.
  useEffect(() => {
    const allIds = groups.flatMap((g) => g.items.map((i) => i.id));
    const sections = allIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        // Pick the first intersecting entry in document order — the
        // one nearest the top of the viewport.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              a.target.getBoundingClientRect().top -
              b.target.getBoundingClientRect().top,
          );
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 },
    );
    sections.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [groups]);

  return (
    <nav className={s.nav} aria-label="Settings sections">
      {groups.map((g) => (
        <div key={g.title} className={s.group}>
          <div className={s.groupTitle}>{g.title}</div>
          <ul className={s.items}>
            {g.items.map((item) => (
              <li key={item.id}>
                <a
                  className={`${s.link} ${activeId === item.id ? s.linkActive : ''}`}
                  href={`#${item.id}`}
                  onClick={(e) => handleClick(e, item.id)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
