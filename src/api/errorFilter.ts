/**
 * Pure error filtering — drops rows that match configured rules
 * before grouping. Each rule is scoped to a trace_origin so the
 * filter can express "for user-initiated traces only" without
 * silencing the same status code when a service initiated the
 * trace. See docs/research/error-filter-design.md for the design.
 *
 * Phase 2: this module is built but not yet wired in. Phase 3
 * applies DEFAULT_FILTER_RULES inside the error-loading path so
 * the Home panel sees filtered output by default.
 *
 * Everything in here is pure (no I/O, no globals). All inputs
 * arrive as ErrorRow shape; that maps 1:1 to the row schema
 * Q.rawRecentErrorSpans returns.
 */

export type TraceOrigin = 'user' | 'service' | 'unknown';

/** A single error span as returned by Q.rawRecentErrorSpans. The
 * shape matches the projected columns; consumers transform from
 * `Record<string, unknown>` via `normalizeErrorRow` below. */
export interface ErrorRow {
  time: number;
  service: string;
  operation: string;
  spanKind: string;
  httpStatus?: number;
  grpcStatus?: number;
  message: string;
  traceId: string;
  rootService?: string;
  traceOrigin: TraceOrigin;
  /** True if some other error span in the same trace has this span
   * as its parent — i.e., this span is propagation, not a leaf
   * error. Computed by the rawRecentErrorSpans self-join. */
  hasErrorChild: boolean;
}

/**
 * Predicate over a row. A matcher with multiple fields ANDs them
 * together. A rule's `match` field is a single matcher — to express
 * OR semantics, write multiple rules.
 */
export interface ErrorRowMatcher {
  /** Match http_status against a closed range [min, max]. */
  httpStatusRange?: { min: number; max: number };
  /** Match grpc_status exactly against any value in the set. */
  grpcStatusIn?: number[];
  /** Match the service name (the row's `service`, i.e. where the
   * error occurred — not the trace's root service). */
  service?: string | RegExp;
  /** Match the trace's root service. */
  rootService?: string | RegExp;
  /** Match the span name (operation). */
  operation?: string | RegExp;
  /** Match the status message. */
  message?: string | RegExp;
  /** Match the span kind (e.g. "2" for SERVER, "3" for CLIENT). */
  spanKind?: string;
  /** Match `has_error_child` — a span that has any error span child
   * in the same trace is propagation, not a leaf. Setting `true`
   * drops propagation rows; setting `false` would drop leaves
   * (rare; useful only as a debug-mode inversion). */
  hasErrorChild?: boolean;
}

export interface ErrorFilterRule {
  id: string;
  description: string;
  scope: TraceOrigin | 'any';
  match: ErrorRowMatcher;
}

export interface FilterResult {
  kept: ErrorRow[];
  /** Number of rows each rule dropped. Sums of values may exceed
   * `total - kept.length` because two rules can both match the
   * same row (first-match-wins; only the first rule is credited). */
  droppedBy: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────
// Matchers
// ─────────────────────────────────────────────────────────────────

function matchString(needle: string | RegExp | undefined, value: string | undefined): boolean {
  if (needle === undefined) return true;
  if (value === undefined) return false;
  if (typeof needle === 'string') return value === needle;
  return needle.test(value);
}

function rowMatches(row: ErrorRow, m: ErrorRowMatcher): boolean {
  if (m.httpStatusRange) {
    if (row.httpStatus === undefined) return false;
    if (row.httpStatus < m.httpStatusRange.min || row.httpStatus > m.httpStatusRange.max) {
      return false;
    }
  }
  if (m.grpcStatusIn) {
    if (row.grpcStatus === undefined) return false;
    if (!m.grpcStatusIn.includes(row.grpcStatus)) return false;
  }
  if (m.service !== undefined && !matchString(m.service, row.service)) return false;
  if (m.rootService !== undefined && !matchString(m.rootService, row.rootService)) return false;
  if (m.operation !== undefined && !matchString(m.operation, row.operation)) return false;
  if (m.message !== undefined && !matchString(m.message, row.message)) return false;
  if (m.spanKind !== undefined && row.spanKind !== m.spanKind) return false;
  if (m.hasErrorChild !== undefined && row.hasErrorChild !== m.hasErrorChild) return false;
  return true;
}

function ruleApplies(rule: ErrorFilterRule, row: ErrorRow): boolean {
  if (rule.scope !== 'any' && row.traceOrigin !== rule.scope) return false;
  return rowMatches(row, rule.match);
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/** Apply rules in order. First matching rule drops the row. The
 * order of `rules` is significant for accounting (which rule gets
 * credited), but every keep-vs-drop decision is the same regardless
 * of order. */
export function applyFilterRules(rows: ErrorRow[], rules: ErrorFilterRule[]): FilterResult {
  const kept: ErrorRow[] = [];
  const droppedBy: Record<string, number> = Object.fromEntries(rules.map((r) => [r.id, 0]));
  for (const row of rows) {
    let droppedByRule: string | null = null;
    for (const rule of rules) {
      if (ruleApplies(rule, row)) {
        droppedByRule = rule.id;
        break;
      }
    }
    if (droppedByRule) {
      droppedBy[droppedByRule] = (droppedBy[droppedByRule] ?? 0) + 1;
    } else {
      kept.push(row);
    }
  }
  return { kept, droppedBy };
}

/** Apply filter rules to raw rows (the shape returned by
 * Q.rawRecentErrorSpans / $vt_results), returning the raw subset
 * that survives. Convenience wrapper around normalizeErrorRow +
 * applyFilterRules; lets callers stay on the raw shape and pass
 * the survivors straight into groupErrorClasses without
 * round-tripping the field names. */
export function applyFilterRulesToRaw(
  rows: Record<string, unknown>[],
  rules: ErrorFilterRule[],
): { kept: Record<string, unknown>[]; droppedBy: Record<string, number> } {
  const kept: Record<string, unknown>[] = [];
  const droppedBy: Record<string, number> = Object.fromEntries(rules.map((r) => [r.id, 0]));
  for (const raw of rows) {
    const norm = normalizeErrorRow(raw);
    let droppedByRule: string | null = null;
    for (const rule of rules) {
      if (ruleApplies(rule, norm)) {
        droppedByRule = rule.id;
        break;
      }
    }
    if (droppedByRule) {
      droppedBy[droppedByRule] = (droppedBy[droppedByRule] ?? 0) + 1;
    } else {
      kept.push(raw);
    }
  }
  return { kept, droppedBy };
}

/** Convert a raw row from Q.rawRecentErrorSpans into our normalized
 * ErrorRow shape. Tolerant of missing columns (older cached panels
 * may not have them) so the filter degrades to "no semconv data,
 * trace_origin=unknown" rather than crashing. */
export function normalizeErrorRow(r: Record<string, unknown>): ErrorRow {
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const origin = String(r.trace_origin ?? 'unknown');
  const traceOrigin: TraceOrigin =
    origin === 'user' || origin === 'service' ? origin : 'unknown';
  return {
    time: num(r._time) ?? 0,
    service: String(r.svc ?? 'unknown'),
    operation: String(r.name ?? 'unknown'),
    spanKind: String(r.span_kind ?? ''),
    httpStatus: num(r.http_status),
    grpcStatus: num(r.grpc_status),
    message: String(r.msg ?? ''),
    traceId: String(r.trace_id ?? ''),
    rootService: r.root_svc ? String(r.root_svc) : undefined,
    traceOrigin,
    hasErrorChild: r.has_error_child === true || r.has_error_child === 'true',
  };
}

// ─────────────────────────────────────────────────────────────────
// Default rules
// ─────────────────────────────────────────────────────────────────

/**
 * Filter rules that ship with the app. Not yet applied to the
 * rendered panel — Phase 3 wires them in. The intent is: if a real
 * or synthetic user initiated the trace, suppress errors that are
 * unambiguous caller-fault per OTel/gRPC semconv. Errors in
 * service-initiated traces and unknown-origin traces stay visible.
 */
export const DEFAULT_FILTER_RULES: ErrorFilterRule[] = [
  {
    id: 'propagation-leaf-only',
    description:
      'Span has an error-status child in the same trace — keep only leaf errors so a single root cause does not appear as a row at every layer of the call chain.',
    scope: 'any',
    match: { hasErrorChild: true },
  },
  {
    id: 'user-trace-http-4xx',
    description:
      'User-initiated trace returned an HTTP 4xx — caller fault (expired session, bad URL, missing page).',
    scope: 'user',
    match: { httpStatusRange: { min: 400, max: 499 } },
  },
  {
    id: 'user-trace-grpc-client-fault',
    description:
      'User-initiated trace returned a gRPC client-fault status — INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, OUT_OF_RANGE, UNAUTHENTICATED.',
    scope: 'user',
    match: { grpcStatusIn: [3, 5, 6, 7, 11, 16] },
  },
];
