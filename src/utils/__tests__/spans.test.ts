import { describe, expect, it } from 'vitest';
import { entityColor, entityHue } from '@criblio/app-utils/viz';
import { linkKeys } from '@criblio/app-utils/graph';
import type { JaegerSpan, JaegerTrace } from '../../api/types';
import { jaegerSpanAccessors, traceTimeline } from '../spans';
import { diffTraces } from '../diff';

// ── Reference oracles: the APM implementations this PR deleted ─────────

function legacyServiceHue(service: string): number {
  let hash = 0;
  for (let i = 0; i < service.length; i++) {
    hash = (hash * 31 + service.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}
const legacyServiceColor = (s: string) => `hsl(${legacyServiceHue(s)}, 60%, 50%)`;
const legacyServiceColorAtLightness = (s: string, l: number) =>
  `hsl(${legacyServiceHue(s)}, 60%, ${l}%)`;

/** The deleted APM buildTimeline, reduced to what the UI consumed. */
function legacyBuildTimeline(spans: JaegerSpan[]) {
  if (spans.length === 0) return { traceStart: 0, traceDuration: 1, order: [] as Array<[string, number]> };
  const byId = new Map<string, JaegerSpan>();
  const childrenOf = new Map<string, string[]>();
  for (const sp of spans) byId.set(sp.spanID, sp);
  const roots: string[] = [];
  for (const sp of spans) {
    const parentRef = sp.references.find((r) => r.refType === 'CHILD_OF');
    if (parentRef && byId.has(parentRef.spanID)) {
      const list = childrenOf.get(parentRef.spanID) ?? [];
      list.push(sp.spanID);
      childrenOf.set(parentRef.spanID, list);
    } else roots.push(sp.spanID);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => byId.get(a)!.startTime - byId.get(b)!.startTime);
  roots.sort((a, b) => byId.get(a)!.startTime - byId.get(b)!.startTime);
  const order: Array<[string, number]> = [];
  const visit = (id: string, depth: number) => {
    order.push([id, depth]);
    for (const c of childrenOf.get(id) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  const root = byId.get(roots[0])!;
  const traceStart = root.startTime;
  let traceEnd = root.startTime + root.duration;
  for (const sp of spans) {
    if (sp.startTime < traceStart) continue;
    traceEnd = Math.max(traceEnd, sp.startTime + sp.duration);
  }
  return { traceStart, traceDuration: Math.max(1, traceEnd - traceStart), order };
}

// ── Fixtures ────────────────────────────────────────────────────────────

function span(
  id: string,
  startTime: number,
  duration: number,
  parent?: string,
  opts: { refType?: 'CHILD_OF' | 'FOLLOWS_FROM'; processID?: string; op?: string } = {},
): JaegerSpan {
  return {
    traceID: 't',
    spanID: id,
    operationName: opts.op ?? `op-${id}`,
    references: parent ? [{ refType: opts.refType ?? 'CHILD_OF', traceID: 't', spanID: parent }] : [],
    startTime,
    duration,
    tags: [],
    logs: [],
    processID: opts.processID ?? 'p1',
    warnings: null,
  };
}

function trace(spans: JaegerSpan[]): JaegerTrace {
  return {
    traceID: 't',
    spans,
    processes: { p1: { serviceName: 'frontend', tags: [] }, p2: { serviceName: 'checkout', tags: [] } },
    warnings: null,
  };
}

/** Deterministic pseudo-random well-formed trace (one root, start-ordered children). */
function randomTrace(seed: number, n: number): JaegerSpan[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  const out = [span(`s${seed}-0`, 1_000_000, 500_000)];
  for (let i = 1; i < n; i++) {
    const parent = out[Math.floor(rnd() * out.length)];
    const start = parent.startTime + Math.floor(rnd() * parent.duration);
    // Mostly nested, sometimes async overflow, occasionally clock-skewed before the root.
    const dur = Math.floor(rnd() * parent.duration * 1.2) + 1;
    const skew = rnd() < 0.1 ? -Math.floor(rnd() * 300_000) - 600_000 : 0;
    out.push(span(`s${seed}-${i}`, start + skew, dur, parent.spanID));
  }
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('service identity colours (entityColor)', () => {
  const ids = [
    'frontend',
    'checkout',
    'payment',
    'product-catalog',
    'load-generator',
    'ad',
    'cart',
    'currency',
    'email',
    'fraud-detection',
    'kafka',
    'flagd',
    'quote',
    'recommendation',
    'shipping',
    'accounting',
    'image-provider',
    'frontend-proxy',
    'other',
    'unknown',
    '',
    'a-service-with-a-very-long-name-that-overflows-int32-hashing-many-times',
    'ünïcødé-svc',
  ];

  it('produces the exact colour the deleted serviceColor did, for every sample id', () => {
    for (const id of ids) {
      expect(entityHue(id)).toBe(legacyServiceHue(id));
      expect(entityColor(id)).toBe(legacyServiceColor(id));
      for (const l of [22, 32, 50, 70]) {
        expect(entityColor(id, l)).toBe(legacyServiceColorAtLightness(id, l));
      }
    }
  });
});

describe('traceTimeline (framework buildTimeline via Jaeger accessors)', () => {
  it('reads parentId from the CHILD_OF ref and end = start + duration', () => {
    const sp = span('b', 100, 40, 'a');
    expect(jaegerSpanAccessors.parentId(sp)).toBe('a');
    expect(jaegerSpanAccessors.end(sp)).toBe(140);
    // FOLLOWS_FROM does not nest.
    expect(jaegerSpanAccessors.parentId(span('c', 0, 1, 'a', { refType: 'FOLLOWS_FROM' }))).toBeUndefined();
  });

  it('lays out depth-first in start order, windowed to the root', () => {
    const tl = traceTimeline(
      trace([span('c2', 300, 100, 'a'), span('a', 0, 1000), span('c1', 100, 100, 'a'), span('g', 120, 50, 'c1')]),
    );
    expect(tl.rows.map((r) => [r.id, r.depth])).toEqual([
      ['a', 0],
      ['c1', 1],
      ['g', 2],
      ['c2', 1],
    ]);
    expect(tl.windowStart).toBe(0);
    expect(tl.duration).toBe(1000);
    const c2 = tl.rows.find((r) => r.id === 'c2')!;
    expect(c2.offset).toBeCloseTo(0.3);
    expect(c2.width).toBeCloseTo(0.1);
  });

  it('clips a clock-skewed child instead of rescaling, and extends for async overflow', () => {
    const tl = traceTimeline(
      trace([
        span('root', 1000, 1000),
        span('skewPartial', 900, 300, 'root'), // overlaps the window
        span('skewOutside', 100, 200, 'root'), // entirely before it
        span('async', 1800, 700, 'root'), // outlives the root
      ]),
    );
    expect(tl.windowStart).toBe(1000);
    expect(tl.windowEnd).toBe(2500);
    const byId = new Map(tl.rows.map((r) => [r.id, r]));
    expect(byId.get('skewPartial')).toMatchObject({ inWindow: true, clippedStart: true, offset: 0 });
    expect(byId.get('skewPartial')!.width).toBeCloseTo(200 / 1500);
    expect(byId.get('skewOutside')).toMatchObject({ inWindow: false, width: 0 });
  });

  it('matches the deleted APM buildTimeline order, depths and window on generated traces', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const spans = randomTrace(seed, 2 + (seed % 25));
      const legacy = legacyBuildTimeline(spans);
      const tl = traceTimeline(trace(spans));
      expect(tl.rows.map((r) => [r.id, r.depth])).toEqual(legacy.order);
      expect(tl.windowStart).toBe(legacy.traceStart);
      expect(tl.duration).toBe(legacy.traceDuration);
      // The bar SpanTree draws: the deleted inline clip arithmetic vs row.offset/width.
      const traceEnd = legacy.traceStart + legacy.traceDuration;
      for (const r of tl.rows) {
        const sp = r.item;
        const visStart = Math.max(sp.startTime, legacy.traceStart);
        const visEnd = Math.min(sp.startTime + sp.duration, traceEnd);
        expect(r.inWindow).toBe(visEnd > visStart);
        if (r.inWindow) {
          expect(r.offset).toBeCloseTo((visStart - legacy.traceStart) / legacy.traceDuration, 12);
          expect(r.width).toBeCloseTo((visEnd - visStart) / legacy.traceDuration, 12);
        }
      }
    }
  });

  it('draws a zero-duration span inside the window as a bar (the old code flagged it "outside trace window")', () => {
    const tl = traceTimeline(trace([span('root', 0, 1000), span('instant', 500, 0, 'root')]));
    expect(tl.rows[1]).toMatchObject({ id: 'instant', inWindow: true, width: 0, offset: 0.5 });
  });

  it('keeps a self-parented span as a root (the old code dropped it from the waterfall)', () => {
    const tl = traceTimeline(trace([span('root', 0, 1000), span('self', 10, 5, 'self')]));
    expect(tl.rows.map((r) => r.id)).toEqual(['root', 'self']);
  });
});

describe('diffTraces on the framework timeline', () => {
  it('pairs matching call shapes and marks one-sided subtrees', () => {
    const left = trace([
      span('a', 0, 100, undefined, { op: 'GET /' }),
      span('b', 10, 50, 'a', { op: 'charge', processID: 'p2' }),
    ]);
    const right = trace([
      span('x', 0, 120, undefined, { op: 'GET /' }),
      span('y', 10, 70, 'x', { op: 'charge', processID: 'p2' }),
      span('z', 90, 10, 'x', { op: 'audit', processID: 'p2' }),
    ]);
    expect(
      diffTraces(left, right).map((r) => [r.mark, r.depth, r.service, r.operationName, r.leftDurationUs, r.rightDurationUs]),
    ).toEqual([
      ['both', 0, 'frontend', 'GET /', 100, 120],
      ['both', 1, 'checkout', 'charge', 50, 70],
      ['right', 1, 'checkout', 'audit', null, 10],
    ]);
  });
});

describe('dependency graph link identity', () => {
  it('keeps the rpc and messaging edges between one pair distinct and order-independent', () => {
    const rpc = { id: 'rpc\u0000checkout\u0000kafka', source: 'checkout', target: 'kafka' };
    const msg = { id: 'messaging\u0000checkout\u0000kafka', source: 'checkout', target: 'kafka' };
    expect(linkKeys([rpc, msg])).toEqual([rpc.id, msg.id]);
    // Reordered input keeps each edge's key — without ids they swap `a>b` / `a>b#1`.
    expect(linkKeys([msg, rpc])).toEqual([msg.id, rpc.id]);
    expect(linkKeys([{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }])).toEqual(['a>b', 'a>b#1']);
  });
});
