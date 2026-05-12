import { describe, it, expect } from 'vitest';
import {
  applyFilterRules,
  applyFilterRulesToRaw,
  normalizeErrorRow,
  DEFAULT_FILTER_RULES,
  type ErrorRow,
  type ErrorFilterRule,
  type TraceOrigin,
} from '../errorFilter';

function makeRow(overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    time: 0,
    service: 'svc',
    operation: 'op',
    spanKind: '2',
    message: '',
    traceId: 't1',
    traceOrigin: 'unknown',
    hasErrorChild: false,
    ...overrides,
  };
}

describe('applyFilterRules', () => {
  it('keeps rows that match no rule', () => {
    const rows = [makeRow({ traceOrigin: 'service', grpcStatus: 5 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
    expect(result.droppedBy).toEqual({
      'propagation-leaf-only': 0,
      'user-trace-http-4xx': 0,
      'user-trace-grpc-client-fault': 0,
    });
  });

  it('drops propagation across all scopes (hasErrorChild=true)', () => {
    const rows = [
      makeRow({ traceOrigin: 'user', hasErrorChild: true }),
      makeRow({ traceOrigin: 'service', hasErrorChild: true }),
      makeRow({ traceOrigin: 'unknown', hasErrorChild: true }),
    ];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedBy['propagation-leaf-only']).toBe(3);
  });

  it('keeps leaf errors (hasErrorChild=false) regardless of scope', () => {
    const rows = [
      makeRow({ traceOrigin: 'service', hasErrorChild: false, grpcStatus: 13 }),
      makeRow({ traceOrigin: 'unknown', hasErrorChild: false }),
    ];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(2);
  });

  it('propagation rule wins over semconv rule (first-match)', () => {
    // A user-trace span that is BOTH propagation AND gRPC NOT_FOUND.
    // The propagation rule comes first, so it gets credited.
    const rows = [makeRow({ traceOrigin: 'user', hasErrorChild: true, grpcStatus: 5 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedBy['propagation-leaf-only']).toBe(1);
    expect(result.droppedBy['user-trace-grpc-client-fault']).toBe(0);
  });

  it('drops user-trace HTTP 4xx', () => {
    const rows = [
      makeRow({ traceOrigin: 'user', httpStatus: 404 }),
      makeRow({ traceOrigin: 'user', httpStatus: 400 }),
      makeRow({ traceOrigin: 'user', httpStatus: 499 }),
    ];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedBy['user-trace-http-4xx']).toBe(3);
  });

  it('keeps user-trace HTTP 500 (server fault, not caller fault)', () => {
    const rows = [makeRow({ traceOrigin: 'user', httpStatus: 500 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps HTTP 4xx in a service-initiated trace — same status, different signal', () => {
    const rows = [makeRow({ traceOrigin: 'service', httpStatus: 404 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
    expect(result.droppedBy['user-trace-http-4xx']).toBe(0);
  });

  it('keeps HTTP 4xx in an unknown-origin trace — conservative bias', () => {
    const rows = [makeRow({ traceOrigin: 'unknown', httpStatus: 404 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
  });

  it('drops user-trace gRPC NOT_FOUND', () => {
    const rows = [makeRow({ traceOrigin: 'user', grpcStatus: 5 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedBy['user-trace-grpc-client-fault']).toBe(1);
  });

  it('keeps user-trace gRPC UNAVAILABLE (14) — real outage', () => {
    const rows = [makeRow({ traceOrigin: 'user', grpcStatus: 14 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps user-trace gRPC INTERNAL (13) — server bug', () => {
    const rows = [makeRow({ traceOrigin: 'user', grpcStatus: 13 })];
    const result = applyFilterRules(rows, DEFAULT_FILTER_RULES);
    expect(result.kept).toHaveLength(1);
  });

  it('first matching rule gets credited, subsequent rules see only kept rows', () => {
    // Build two rules that would both match. First-match-wins.
    const rules: ErrorFilterRule[] = [
      { id: 'first', description: '', scope: 'user', match: { httpStatusRange: { min: 400, max: 499 } } },
      { id: 'second', description: '', scope: 'user', match: { httpStatusRange: { min: 404, max: 404 } } },
    ];
    const rows = [makeRow({ traceOrigin: 'user', httpStatus: 404 })];
    const result = applyFilterRules(rows, rules);
    expect(result.droppedBy).toEqual({ first: 1, second: 0 });
  });

  it('scope=any matches regardless of trace_origin', () => {
    const rules: ErrorFilterRule[] = [
      {
        id: 'silence-known-broken',
        description: '',
        scope: 'any',
        match: { message: /broken_endpoint/ },
      },
    ];
    const origins: TraceOrigin[] = ['user', 'service', 'unknown'];
    const rows = origins.map((o) => makeRow({ traceOrigin: o, message: 'broken_endpoint' }));
    const result = applyFilterRules(rows, rules);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedBy['silence-known-broken']).toBe(3);
  });

  it('regex matchers work', () => {
    const rules: ErrorFilterRule[] = [
      {
        id: 'drop-product-not-found',
        description: '',
        scope: 'user',
        match: { message: /^Product Not Found/i },
      },
    ];
    const rows = [
      makeRow({ traceOrigin: 'user', message: 'Product Not Found: DEADBEEF' }),
      makeRow({ traceOrigin: 'user', message: 'something else' }),
    ];
    const result = applyFilterRules(rows, rules);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].message).toBe('something else');
  });

  it('returns zero counts in droppedBy for rules that matched nothing', () => {
    const rules: ErrorFilterRule[] = [
      { id: 'rule-a', description: '', scope: 'user', match: { httpStatusRange: { min: 400, max: 499 } } },
      { id: 'rule-b', description: '', scope: 'service', match: { grpcStatusIn: [13] } },
    ];
    const result = applyFilterRules([], rules);
    expect(result.droppedBy).toEqual({ 'rule-a': 0, 'rule-b': 0 });
  });
});

describe('normalizeErrorRow', () => {
  it('handles a full row from rawRecentErrorSpans', () => {
    const raw = {
      _time: 1778618000,
      svc: 'product-catalog',
      name: 'oteldemo.ProductCatalogService/GetProduct',
      span_kind: '2',
      http_status: null,
      grpc_status: 5,
      msg: 'Product Not Found: DEADBEEF',
      trace_id: 'abc123',
      root_svc: 'load-generator',
      trace_origin: 'user',
      has_error_child: false,
    };
    const row = normalizeErrorRow(raw);
    expect(row).toEqual({
      time: 1778618000,
      service: 'product-catalog',
      operation: 'oteldemo.ProductCatalogService/GetProduct',
      spanKind: '2',
      httpStatus: undefined,
      grpcStatus: 5,
      message: 'Product Not Found: DEADBEEF',
      traceId: 'abc123',
      rootService: 'load-generator',
      traceOrigin: 'user',
      hasErrorChild: false,
    });
  });

  it('coerces has_error_child string "true" to boolean true', () => {
    // The Cribl search results sometimes return booleans as strings.
    const row = normalizeErrorRow({ has_error_child: 'true' });
    expect(row.hasErrorChild).toBe(true);
  });

  it('treats missing has_error_child as false', () => {
    const row = normalizeErrorRow({});
    expect(row.hasErrorChild).toBe(false);
  });

  it('falls back to unknown origin when column missing', () => {
    const row = normalizeErrorRow({ svc: 'x', name: 'y', msg: 'z', trace_id: 't' });
    expect(row.traceOrigin).toBe('unknown');
  });

  it('coerces unexpected trace_origin values to unknown', () => {
    const row = normalizeErrorRow({ trace_origin: 'bogus' });
    expect(row.traceOrigin).toBe('unknown');
  });

  it('treats grpc_status="" as undefined (not 0)', () => {
    // The CSV-y export format sometimes serializes nulls as empty
    // strings; if we coerced "" → 0 the filter would think every
    // missing status was OK (gRPC code 0) and drop the wrong rows.
    const row = normalizeErrorRow({ grpc_status: '' });
    expect(row.grpcStatus).toBeUndefined();
  });
});

describe('applyFilterRulesToRaw', () => {
  it('filters raw rows in place and preserves shape', () => {
    const raw = [
      { svc: 'pc', name: 'op', msg: 'm', trace_id: 't1', grpc_status: 5, trace_origin: 'user' },
      { svc: 'pc', name: 'op', msg: 'm', trace_id: 't2', grpc_status: 14, trace_origin: 'user' },
      { svc: 'pc', name: 'op', msg: 'm', trace_id: 't3', grpc_status: 5, trace_origin: 'service' },
    ];
    const { kept, droppedBy } = applyFilterRulesToRaw(raw, DEFAULT_FILTER_RULES);
    // Only the 'user'-origin gRPC 5 row gets dropped. UNAVAILABLE (14)
    // stays; service-trace NOT_FOUND stays (different actor caused it).
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => r.trace_id).sort()).toEqual(['t2', 't3']);
    expect(droppedBy['user-trace-grpc-client-fault']).toBe(1);
    // Kept rows are returned with their original raw shape (not normalized).
    expect(kept[0]).toHaveProperty('svc');
  });

  it('returns input unchanged when no rules match', () => {
    const raw = [
      { svc: 'a', name: 'b', msg: 'c', trace_id: 't', trace_origin: 'service', grpc_status: 5 },
    ];
    const { kept, droppedBy } = applyFilterRulesToRaw(raw, DEFAULT_FILTER_RULES);
    expect(kept).toHaveLength(1);
    expect(droppedBy['user-trace-grpc-client-fault']).toBe(0);
  });
});
