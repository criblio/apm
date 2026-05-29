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

  it('drops values seen fewer than minTotal times (noise floor)', () => {
    // One value seen twice — below the default minTotal=3.
    const diff = new Map<string, SpotlightBucket[]>([
      ['rare.attr', [mkBucket('rare.attr', 'just-twice', 1, 1)]],
    ]);
    expect(computeSpotlight(diff)).toEqual([]);
  });

  it('ranks the http.status_code differential we validated on staging', () => {
    // From PR D's MCP probe: selection = error spans, baseline = healthy.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'http.status_code',
        [
          mkBucket('http.status_code', '200', 0, 113168),
          mkBucket('http.status_code', '500', 1308, 262),
          mkBucket('http.status_code', '504', 90, 0),
          mkBucket('http.status_code', '404', 123, 186),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result).toHaveLength(1);
    const attr = result[0];
    expect(attr.name).toBe('http.status_code');
    // 500 should be the top over-represented value (huge share in sel,
    // tiny share in base).
    expect(attr.rows[0].value).toBe('500');
    expect(attr.rows[0].diff).toBeGreaterThan(0.5);
    // 200 should be at the bottom — strongly under-represented.
    expect(attr.rows[attr.rows.length - 1].value).toBe('200');
    expect(attr.rows[attr.rows.length - 1].diff).toBeLessThan(-0.5);
  });

  it('ranks a strongly skewed attribute above a balanced one', () => {
    // svc.skewed: A is 100% selection, 0% baseline — huge skew.
    // svc.balanced: A and B are evenly split in both — no skew.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'svc.balanced',
        [
          mkBucket('svc.balanced', 'A', 500, 500),
          mkBucket('svc.balanced', 'B', 500, 500),
        ],
      ],
      [
        'svc.skewed',
        [
          mkBucket('svc.skewed', 'A', 1000, 10),
          mkBucket('svc.skewed', 'B', 0, 990),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].name).toBe('svc.skewed');
    // svc.balanced should be dropped entirely — its top |diff| is 0.
    expect(result.map((a) => a.name)).not.toContain('svc.balanced');
  });

  it('weights score by log(volume) so tiny-volume outliers do not win', () => {
    // tiny.attr: rare value appears once in selection. Pure diff is
    // selShare=1.0, baseShare=0 → diff=1.0 but volume is 3 (just above
    // floor).
    // big.attr: dominant value flips at scale — selShare=0.8 vs
    // baseShare=0.2 → diff=0.6 but volume is 10000.
    const diff = new Map<string, SpotlightBucket[]>([
      ['tiny.attr', [mkBucket('tiny.attr', 'rare', 3, 0)]],
      [
        'big.attr',
        [
          mkBucket('big.attr', 'X', 8000, 2000),
          mkBucket('big.attr', 'Y', 2000, 8000),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result[0].name).toBe('big.attr');
  });

  it('caps rows per attribute via maxRowsPerAttr', () => {
    // Build a mix of over- and under-represented values so the
    // attribute clears minTopDiff (the cap is what we want to test,
    // not the threshold).
    const buckets: SpotlightBucket[] = [
      mkBucket('many', 'hot', 1000, 10),
      mkBucket('many', 'cold', 10, 1000),
    ];
    for (let i = 0; i < 18; i++) {
      buckets.push(mkBucket('many', `mid${i}`, 50, 50));
    }
    const diff = new Map([['many', buckets]]);
    const result = computeSpotlight(diff, { maxRowsPerAttr: 5 });
    expect(result[0].rows).toHaveLength(5);
  });

  it('sorts rows by diff desc within an attribute', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'method',
        [
          mkBucket('method', 'GET', 100, 900),
          mkBucket('method', 'POST', 900, 100),
          mkBucket('method', 'DELETE', 500, 500),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    const values = result[0].rows.map((r) => r.value);
    expect(values).toEqual(['POST', 'DELETE', 'GET']);
  });

  it('computes selShare and baseShare correctly', () => {
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'kind',
        [
          mkBucket('kind', 'A', 30, 100),
          mkBucket('kind', 'B', 70, 900),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    const a = result[0].rows.find((r) => r.value === 'A')!;
    expect(a.selShare).toBeCloseTo(0.3);
    expect(a.baseShare).toBeCloseTo(0.1);
    expect(a.diff).toBeCloseTo(0.2);
  });

  it('handles selection-only data (baseTotal == 0)', () => {
    // Edge case: every span IS in the selection (no baseline). Should
    // not crash. baseShare goes to 0 for everything and diff equals
    // selShare. minTopDiff filter still applies.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'only.sel',
        [
          mkBucket('only.sel', 'X', 900, 0),
          mkBucket('only.sel', 'Y', 100, 0),
        ],
      ],
    ]);
    const result = computeSpotlight(diff);
    expect(result).toHaveLength(1);
    const top = result[0].rows[0];
    expect(top.baseShare).toBe(0);
    expect(top.diff).toBe(top.selShare);
  });

  it('respects minTopDiff to filter out boring attributes', () => {
    // Subtle differential — top |diff| is 0.02, below the default 0.05.
    const diff = new Map<string, SpotlightBucket[]>([
      [
        'subtle',
        [
          mkBucket('subtle', 'A', 510, 490),
          mkBucket('subtle', 'B', 490, 510),
        ],
      ],
    ]);
    expect(computeSpotlight(diff)).toEqual([]);
    // Lowering the threshold should bring it back.
    expect(computeSpotlight(diff, { minTopDiff: 0.01 })).toHaveLength(1);
  });
});
