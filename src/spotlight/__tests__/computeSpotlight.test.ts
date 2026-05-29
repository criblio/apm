import { describe, it, expect } from 'vitest';
import { computeSpotlight } from '../computeSpotlight';
import type { SpotlightBucket } from '../../api/types';

function mkBucket(
  attrName: string,
  attrValue: string,
  selN: number,
  baseN: number,
): SpotlightBucket {
  return { attrName, attrValue, selN, baseN };
}

describe('computeSpotlight', () => {
  it('returns an empty array when input is empty', () => {
    expect(computeSpotlight(new Map())).toEqual([]);
  });

  it('drops attributes whose totals are zero', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      ['quiet.attr', [mkBucket('quiet.attr', 'x', 0, 0)]],
    ]);
    expect(computeSpotlight(diff)).toEqual([]);
  });

  it('drops values below the minTotal floor', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      ['rare.attr', [mkBucket('rare.attr', 'just-twice', 1, 1)]],
    ]);
    expect(computeSpotlight(diff)).toEqual([]);
  });

  it('computes per-value selection rate (selN / total)', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'pod',
        [
          mkBucket('pod', 'pod-A', 90, 10), // 90% errors
          mkBucket('pod', 'pod-B', 5, 95),  // 5% errors
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result).toHaveLength(1);
    const a = result[0].rows.find((r) => r.value === 'pod-A')!;
    const b = result[0].rows.find((r) => r.value === 'pod-B')!;
    expect(a.selectionRate).toBeCloseTo(0.9);
    expect(b.selectionRate).toBeCloseTo(0.05);
  });

  it('sorts rows within an attribute by selectionRate desc', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'method',
        [
          mkBucket('method', 'GET', 100, 900),    // 10% errors
          mkBucket('method', 'POST', 900, 100),   // 90% errors
          mkBucket('method', 'DELETE', 500, 500), // 50% errors
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].rows.map((r) => r.value)).toEqual([
      'POST',
      'DELETE',
      'GET',
    ]);
  });

  it('ranks high-variance attributes above low-variance ones', () => {
    // pod.broken: A has 90% error rate, B has 5%. High variance.
    // pod.uniform: every pod has ~50% error rate. Low variance.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'pod.broken',
        [
          mkBucket('pod.broken', 'A', 900, 100),
          mkBucket('pod.broken', 'B', 50, 950),
        ],
      ],
      [
        'pod.uniform',
        [
          mkBucket('pod.uniform', 'A', 500, 500),
          mkBucket('pod.uniform', 'B', 510, 490),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].name).toBe('pod.broken');
    // uniform should be filtered out as below minScore.
    expect(result.map((a) => a.name)).not.toContain('pod.uniform');
  });

  it('drops uniform attributes via the minScore floor', () => {
    // Every value has ~50% selection rate — no signal.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'meh',
        [
          mkBucket('meh', 'X', 500, 500),
          mkBucket('meh', 'Y', 510, 490),
          mkBucket('meh', 'Z', 495, 505),
        ],
      ],
    ]);
    expect(computeSpotlight(diff)).toEqual([]);
  });

  it('weights variance by volume (low-volume noise should not win)', () => {
    // small.attr has wild rates but tiny volume.
    // big.attr has a clear partition at high volume.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'small.attr',
        [
          mkBucket('small.attr', 'A', 5, 0),  // 100%, but only 5 spans
          mkBucket('small.attr', 'B', 0, 5),  // 0%, but only 5 spans
        ],
      ],
      [
        'big.attr',
        [
          mkBucket('big.attr', 'A', 800, 200), // 80%
          mkBucket('big.attr', 'B', 200, 800), // 20%
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].name).toBe('big.attr');
  });

  it('caps rows per attribute via maxRowsPerAttr', () => {
    // Need enough variance to clear minScore — mix hot/cold/many lukewarm.
    const buckets: SpotlightBucket[] = [
      mkBucket('many', 'hot', 1000, 10),  // ~99%
      mkBucket('many', 'cold', 10, 1000), // ~1%
    ];
    for (let i = 0; i < 18; i++) {
      buckets.push(mkBucket('many', `mid${i}`, 50, 50));
    }
    const diff = new Map([['many', buckets]]);
    const result = computeSpotlight(diff, { maxRowsPerAttr: 5 });
    expect(result[0].rows).toHaveLength(5);
  });

  it('exposes overallRate per attribute', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'attr',
        [
          mkBucket('attr', 'A', 80, 20),   // 80%
          mkBucket('attr', 'B', 20, 80),   // 20%
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].overallRate).toBeCloseTo(0.5);
  });

  it('passes total counts on each row', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'attr',
        [mkBucket('attr', 'X', 30, 70)],
      ],
    ]);
    // Need variance to land — pair with a contrasting value.
    diff.get('attr')!.push(mkBucket('attr', 'Y', 90, 10));
    const result = computeSpotlight(diff);
    const x = result[0].rows.find((r) => r.value === 'X')!;
    expect(x.total).toBe(100);
    expect(x.selN).toBe(30);
    expect(x.baseN).toBe(70);
  });

  it('treats a 100% selection-rate attribute (tautology) as high score', () => {
    // rpc.grpc.status_code where errors are exactly status=13:
    // value 0 = 0% errors, value 13 = 100% errors. Maximum variance.
    // Spotlight should surface it (correctly tautological — still
    // informative for a user who didn't know about status code yet).
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'rpc.grpc.status_code',
        [
          mkBucket('rpc.grpc.status_code', '0', 0, 905),
          mkBucket('rpc.grpc.status_code', '13', 144, 0),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('rpc.grpc.status_code');
    expect(result[0].rows[0].selectionRate).toBe(1);
    expect(result[0].rows[1].selectionRate).toBe(0);
  });
});
