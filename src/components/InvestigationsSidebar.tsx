/**
 * Recall panel for the Investigator window (server mode).
 *
 * Lists the most recent investigations from the cell, supports a
 * substring search, and paginates older ones with a keyset cursor.
 * Clicking a row opens that investigation — interactive if it's still
 * open, read-only if it concluded. Shown only when serverInvestigations
 * is on (the cell is the record store).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listInvestigations,
  type InvestigationStatus,
  type InvestigationSummary,
} from '../api/investigationTransport';
import s from './InvestigationsSidebar.module.css';

const PAGE = 30;
/** Refresh cadence so running/idle statuses and freshly created
 *  investigations surface without a manual reload. */
const REFRESH_MS = 15_000;

const STATUS_LABEL: Record<InvestigationStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  idle: 'Open',
  concluded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function statusClass(status: InvestigationStatus): string {
  if (status === 'running' || status === 'queued') return s.chipRunning;
  if (status === 'idle') return s.chipOpen;
  if (status === 'concluded') return s.chipDone;
  return s.chipFailed;
}

function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const COLLAPSE_KEY = 'apm.investigationsPanel.collapsed';

export interface InvestigationsSidebarProps {
  /** The currently open investigation id, highlighted in the list. */
  activeId?: string | null;
}

export default function InvestigationsSidebar({ activeId }: InvestigationsSidebarProps) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* private mode / storage disabled — collapse still works for the session */
      }
      return next;
    });
  }, []);
  const [items, setItems] = useState<InvestigationSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards stale async responses (query changed / unmounted) from
  // overwriting a newer fetch.
  const genRef = useRef(0);

  const load = useCallback(async (q: string) => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await listInvestigations({ q: q || undefined, limit: PAGE });
      if (genRef.current !== gen) return;
      setItems(rows);
      setHasMore(rows.length === PAGE);
    } catch (err) {
      if (genRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (genRef.current === gen) setLoading(false);
    }
  }, []);

  // Debounced search + reload when the active investigation changes (so
  // a just-started one appears at the top).
  useEffect(() => {
    const t = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, activeId, load]);

  // Periodic silent refresh to keep statuses current.
  useEffect(() => {
    const iv = setInterval(() => {
      // Only refresh the first page, and only when not searching, to
      // avoid clobbering a scrolled-in older page.
      if (!query) void load('');
    }, REFRESH_MS);
    return () => clearInterval(iv);
  }, [query, load]);

  const loadMore = useCallback(async () => {
    const last = items[items.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const rows = await listInvestigations({
        q: query || undefined,
        before: last.createdAt,
        limit: PAGE,
      });
      setItems((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore, query]);

  // Collapsed: a slim rail with just an expand affordance, so the
  // transcript gets the full width.
  if (collapsed) {
    return (
      <aside className={s.rail}>
        <button
          type="button"
          className={s.railBtn}
          onClick={toggleCollapsed}
          title="Show investigations"
          aria-label="Show investigations"
        >
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className={s.sidebar}>
      <div className={s.header}>
        <span className={s.title}>Investigations</span>
        <div className={s.headerBtns}>
          <button
            type="button"
            className={s.newBtn}
            onClick={() => navigate('/investigate')}
            title="Start a new investigation"
          >
            + New
          </button>
          <button
            type="button"
            className={s.collapseBtn}
            onClick={toggleCollapsed}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            «
          </button>
        </div>
      </div>

      <input
        className={s.search}
        type="search"
        value={query}
        placeholder="Search…"
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />

      {error && <div className={s.error}>{error}</div>}

      <div className={s.list}>
        {loading && items.length === 0 && <div className={s.muted}>Loading…</div>}
        {!loading && items.length === 0 && !error && (
          <div className={s.muted}>{query ? 'No matches.' : 'No investigations yet.'}</div>
        )}
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`${s.row} ${it.id === activeId ? s.rowActive : ''}`}
            onClick={() => navigate(`/investigate?investigation=${encodeURIComponent(it.id)}`)}
          >
            <div className={s.rowTop}>
              <span className={s.rowTitle}>{it.title || it.incidentKey}</span>
              <span className={`${s.chip} ${statusClass(it.status)}`}>
                {STATUS_LABEL[it.status] ?? it.status}
              </span>
            </div>
            <div className={s.rowMeta}>
              {it.mode === 'interactive' ? 'Interactive' : 'Alert'} · {formatAgo(it.createdAt)}
            </div>
          </button>
        ))}
        {hasMore && (
          <button
            type="button"
            className={s.loadMore}
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        )}
      </div>
    </aside>
  );
}
