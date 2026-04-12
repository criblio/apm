import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import SpanTree from '../components/SpanTree';
import SpanDetail from '../components/SpanDetail';
import TraceLogsView from '../components/TraceLogsView';
import { getTrace, getTraceLogs } from '../api/search';
import { summarizeTrace } from '../api/transform';
import { formatDurationUs } from '../utils/spans';
import type { JaegerTrace, TraceLogEntry, TraceSummary } from '../api/types';
import InvestigateButton from '../components/InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import s from './TraceView.module.css';

/**
 * Seed for "Investigate this trace". Pre-fills the trace_id so the
 * agent can call render_trace immediately instead of discovering it.
 * Also surfaces error counts and root service/op as known signals.
 */
function buildTraceSeed(
  trace: JaegerTrace,
  summary: TraceSummary,
): InvestigationSeed {
  const signals: string[] = [
    `Trace ID: ${trace.traceID}`,
    `Root: ${summary.rootService} / ${summary.rootOperation}`,
    `Duration: ${(summary.duration / 1000).toFixed(1)}ms`,
    `Spans: ${summary.spanCount} across ${summary.services.length} services`,
  ];
  if (summary.errorCount > 0) {
    signals.push(`Error spans: ${summary.errorCount}`);
  }
  signals.push(`Services involved: ${summary.services.join(', ')}`);

  const question =
    summary.errorCount > 0
      ? `Investigate trace ${trace.traceID}. It has ${summary.errorCount} error spans across ${summary.services.length} services. Start by rendering the trace, then identify where the failure originates and what the downstream/upstream effects are.`
      : `Investigate trace ${trace.traceID}. The trace spans ${summary.services.length} services over ${(summary.duration / 1000).toFixed(1)}ms. Render it first, then explain what's happening in the trace and whether anything looks anomalous.`;

  // Widen the range to -24h so run_search can look up related
  // spans across the full trace lifetime.
  return {
    question,
    knownSignals: signals,
    earliest: '-24h',
    latest: 'now',
  };
}

type Tab = 'timeline' | 'logs';

export default function TraceView() {
  const { traceId } = useParams();
  const [searchParams] = useSearchParams();
  const lookback = searchParams.get('lookback') ?? '-1h';

  const [trace, setTrace] = useState<JaegerTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [logs, setLogs] = useState<TraceLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    if (!traceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTrace(null);
    setSelectedSpanId(null);
    setLogs([]);
    getTrace(traceId, lookback, 'now')
      .then((t) => {
        if (cancelled) return;
        setTrace(t);
        if (t && t.spans.length > 0) {
          // Default-select the root span
          const root = t.spans.find((sp) => sp.references.length === 0) ?? t.spans[0];
          setSelectedSpanId(root.spanID);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceId, lookback]);

  // Fetch logs in parallel. We use a wide 24h lookback because otel logs
  // can drift slightly from the span timestamps and this query is
  // trace_id-filtered anyway, so the range doesn't materially affect cost.
  useEffect(() => {
    if (!traceId) return;
    let cancelled = false;
    setLoadingLogs(true);
    getTraceLogs(traceId, '-24h', 'now')
      .then((rows) => {
        if (!cancelled) setLogs(rows);
      })
      .catch(() => {
        if (!cancelled) setLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingLogs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  const summary = useMemo(() => (trace ? summarizeTrace(trace) : null), [trace]);
  const selectedSpan = useMemo(
    () => trace?.spans.find((sp) => sp.spanID === selectedSpanId) ?? null,
    [trace, selectedSpanId],
  );

  // Parent → children adjacency, computed once per trace.
  const childrenBySpanId = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!trace) return m;
    for (const sp of trace.spans) {
      const parent = sp.references.find((r) => r.refType === 'CHILD_OF');
      if (!parent) continue;
      if (!m.has(parent.spanID)) m.set(parent.spanID, []);
      m.get(parent.spanID)!.push(sp.spanID);
    }
    return m;
  }, [trace]);

  // Logs scoped to the selected span OR any of its descendants — this is
  // the intuitive "what ran under this span" semantic. OTel tags each log
  // with the *innermost* active span, so filtering by equality alone on the
  // root span would surface only the 1 load-generator log while hiding the
  // 20+ downstream service logs that actually ran inside the checkout
  // workflow. Walk the subtree DFS from the selected span and include any
  // log whose span_id belongs to the resulting set.
  const logsForSelectedSpan = useMemo(() => {
    if (!selectedSpanId) return [] as TraceLogEntry[];
    const descendants = new Set<string>();
    const stack: string[] = [selectedSpanId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (descendants.has(id)) continue;
      descendants.add(id);
      const kids = childrenBySpanId.get(id);
      if (kids) stack.push(...kids);
    }
    return logs.filter((l) => descendants.has(l.spanID));
  }, [logs, selectedSpanId, childrenBySpanId]);

  if (loading) return <div className={s.loading}>Loading trace…</div>;
  if (error) return <div className={s.errorBox}>{error}</div>;
  if (!trace || !summary) return <div className={s.errorBox}>Trace not found.</div>;

  const traceStartMs = summary.startTime / 1000;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <div className={s.title}>
            <span className={s.svcChip}>{summary.rootService}</span>
            {summary.rootOperation}
          </div>
          <div className={s.subtitle}>
            {summary.spanCount} spans across {summary.services.length} service
            {summary.services.length !== 1 ? 's' : ''}
            {summary.errorCount > 0 && ` · ${summary.errorCount} errors`}
            {' · '}
            {loadingLogs ? 'loading logs…' : `${logs.length} log entries`}
          </div>
          <div className={s.traceIdMono}>{trace.traceID}</div>
        </div>
        <div className={s.stats}>
          <div className={s.stat}>
            <span className={s.statLabel}>Duration</span>
            <span className={s.statValue}>{formatDurationUs(summary.duration)}</span>
          </div>
          <div className={s.stat}>
            <span className={s.statLabel}>Spans</span>
            <span className={s.statValue}>{summary.spanCount}</span>
          </div>
          <div className={s.stat}>
            <span className={s.statLabel}>Services</span>
            <span className={s.statValue}>{summary.services.length}</span>
          </div>
          <InvestigateButton
            seed={buildTraceSeed(trace, summary)}
            variant="primary"
            title="Investigate this trace with Copilot"
          />
        </div>
      </div>

      <div className={s.tabBar}>
        <button
          type="button"
          className={`${s.tab} ${tab === 'timeline' ? s.tabActive : ''}`}
          onClick={() => setTab('timeline')}
        >
          Timeline
        </button>
        <button
          type="button"
          className={`${s.tab} ${tab === 'logs' ? s.tabActive : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs{' '}
          <span className={s.tabCount}>
            {loadingLogs ? '…' : logs.length}
          </span>
        </button>
      </div>

      {tab === 'timeline' ? (
        <div className={s.split}>
          <SpanTree
            trace={trace}
            selectedSpanId={selectedSpanId}
            onSelect={setSelectedSpanId}
          />
          <SpanDetail
            trace={trace}
            span={selectedSpan}
            spanLogs={logsForSelectedSpan}
            loadingLogs={loadingLogs}
            traceStartMs={traceStartMs}
          />
        </div>
      ) : (
        <TraceLogsView
          logs={logs}
          loading={loadingLogs}
          subtitle="All logs emitted during this trace, in timeline order"
          referenceTimeMs={traceStartMs}
        />
      )}
    </div>
  );
}
