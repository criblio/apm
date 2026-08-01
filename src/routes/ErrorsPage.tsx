import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card } from '@capra/core';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import InvestigateButton from '../components/InvestigateButton';
import SpotlightSection from '../components/SpotlightSection';
import { listErrorClasses } from '../api/search';
import { SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL } from '../api/queries';
import { listCachedErrorClasses } from '../api/panelCache';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import { serviceColor } from '../utils/spans';
import { useRangeParam } from '../hooks/useRangeParam';
import type { ErrorClass } from '../api/types';
import { kqlStringLiteral } from '../api/kqlSafety';
import s from './ErrorsPage.module.css';

const DEFAULT_RANGE = '-1h';

function fmtAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

/** KQL key for an error class — stable across renders for use as
 *  the expanded-row tracker. */
function errorKey(ec: ErrorClass): string {
  return `${ec.service}::${ec.operation}::${ec.message}`;
}

/**
 * Build the Spotlight scope KQL for one error class. The scope
 * narrows BOTH selection (failing) and baseline (healthy) to spans
 * on this service+operation, so the differential answers "what's
 * different about the failing calls vs the successful ones?"
 * instead of "what's different about this error vs the rest of the
 * window?" — the latter is dominated by service-identifying
 * attributes (rpc.method etc.) that don't move when the error fires.
 */
function spotlightScopeFor(ec: ErrorClass): string {
  return (
    `tostring(resource.attributes['service.name'])==${kqlStringLiteral(ec.service)}` +
    ` and name==${kqlStringLiteral(ec.operation)}`
  );
}

const SPOTLIGHT_ERROR_SELECTION = `tostring(status.code)=="2"`;

export default function ErrorsPage() {
  const navigate = useNavigate();
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const [errors, setErrors] = useState<ErrorClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const streamFilterEnabled = useStreamFilterEnabled();

  const fetchErrors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (range === '-1h' && streamFilterEnabled) {
        const cached = await listCachedErrorClasses();
        if (cached) {
          setErrors(cached.classes);
          setLoading(false);
          return;
        }
      }
      const result = await listErrorClasses(range, 'now', 500, 100);
      setErrors(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range, streamFilterEnabled]);

  useEffect(() => { void fetchErrors(); }, [fetchErrors]);

  const filtered = filter
    ? errors.filter((e) =>
        e.service.toLowerCase().includes(filter.toLowerCase()) ||
        e.operation.toLowerCase().includes(filter.toLowerCase()) ||
        e.message.toLowerCase().includes(filter.toLowerCase()))
    : errors;

  const totalErrors = errors.reduce((sum, e) => sum + e.count, 0);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Clicking a Spotlight value should take the user to the Search
   *  page pre-seeded with the error context + the picked attribute,
   *  so they can keep narrowing. */
  function pickValue(ec: ErrorClass, attr: string, value: string) {
    const params = new URLSearchParams();
    params.set('service', ec.service);
    params.set('operation', ec.operation);
    params.append(
      'f',
      [attr, '=', value].map(encodeURIComponent).join(':'),
    );
    params.set('lookback', range);
    navigate(`/traces?${params.toString()}`);
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Errors</h1>
          <p className={s.subtitle}>
            {loading ? 'Loading...' : `${errors.length} error groups · ${totalErrors} total errors`}
          </p>
        </div>
        <div className={s.controls}>
          <input
            className={s.filterInput}
            type="text"
            placeholder="Filter by service, operation, or message..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <TimeRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      <p className={s.howto}>
        Click any row to expand <strong>Spotlight</strong> — the
        attributes whose values are over- or under-represented in
        this error class vs the rest of the time window. The
        differential is the fastest way to answer{' '}
        <em>"what's distinct about these failing spans?"</em>
      </p>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {loading ? (
        <Card className={s.card}>
          <div className={s.skeleton}>
            {[85, 70, 90, 65, 80].map((w, i) => (
              <div key={i} className={s.skeletonBar} style={{ width: `${w}%` }} />
            ))}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className={s.card}>
          <div className={s.empty}>
            {filter ? 'No errors match your filter.' : 'No errors in this time range.'}
          </div>
        </Card>
      ) : (
        <Card className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.expandCell} />
                <th>Error Group</th>
                <th className={s.num}>Count</th>
                <th>Last Seen</th>
                <th>Sample Trace</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((ec, i) => {
                const key = errorKey(ec);
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={`${key}-${i}`}>
                    <tr
                      className={`${s.errorRow} ${isOpen ? s.errorRowOpen : ''}`}
                      onClick={() => toggleExpanded(key)}
                    >
                      <td className={s.expandCell}>
                        <span
                          className={`${s.chevron} ${isOpen ? s.chevronOpen : ''}`}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          ▶
                        </span>
                      </td>
                      <td>
                        <div className={s.errorGroup}>
                          <Link
                            to={`/service/${encodeURIComponent(ec.service)}?range=${range}`}
                            className={s.svcLink}
                            style={{ color: serviceColor(ec.service) }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {ec.service}
                          </Link>
                          <span className={s.opName}>{ec.operation}</span>
                          <span className={s.errMsg}>{ec.message}</span>
                        </div>
                      </td>
                      <td className={s.num}>
                        <span className={s.countBadge}>{ec.count}</span>
                      </td>
                      <td className={s.lastSeen}>{fmtAgo(ec.lastSeenMs)}</td>
                      <td>
                        {ec.sampleTraceIDs[0] && (
                          <Link
                            to={`/trace/${ec.sampleTraceIDs[0]}`}
                            className={s.traceLink}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {ec.sampleTraceIDs[0].slice(0, 12)}...
                          </Link>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <InvestigateButton
                          seed={{
                            question: `The ${ec.service} service has errors on ${ec.operation}: "${ec.message}". Investigate the root cause.`,
                            service: ec.service,
                            operation: ec.operation,
                            knownSignals: [`Error: ${ec.message}`, `Count: ${ec.count}`, `Operation: ${ec.operation}`],
                            earliest: range,
                            latest: 'now',
                          }}
                          title={`Investigate ${ec.service} ${ec.operation}`}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={s.spotlightRow}>
                        <td colSpan={6} className={s.spotlightCell}>
                          <SpotlightSection
                            scopeKql={spotlightScopeFor(ec)}
                            selectionKql={SPOTLIGHT_ERROR_SELECTION}
                            earliest={range}
                            attributes={SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL}
                            selectionNoun="errors"
                            title={`Spotlight — error rate per attribute for ${ec.service} / ${ec.operation}`}
                            caption="For each attribute, what percentage of this operation's calls with that value failed? Values with an unusually high error rate point at the source of the failures. Click Search to see the matching spans."
                            onPickValue={(attr, value) => pickValue(ec, attr, value)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
