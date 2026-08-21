import { describe, it, expect } from 'vitest';
import { validateQuery, validateName, validateProvisionPlan } from '../provisionGuard';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { getProvisioningPlan, SEED_LOOKUPS } from '../provisionedSearches';

describe('validateQuery', () => {
  it('passes a healthy read query', () => {
    expect(validateQuery('q', 'dataset="otel" | summarize count() by svc')).toEqual([]);
  });

  it('passes a healthy export query (sentinel-first union)', () => {
    const q = `print svc="__sentinel__", n=tolong(0)
      | union (dataset="otel" | summarize n=count() by svc)
      | export mode=overwrite description="x" to lookup my_lookup`;
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags an empty dataset clause', () => {
    const errors = validateQuery('q', 'dataset="" | limit 1');
    expect(errors).toHaveLength(2); // empty clause + no non-empty clause
    expect(errors[0]).toContain('empty dataset');
  });

  it('flags a missing dataset clause', () => {
    expect(validateQuery('q', '| limit 1')).toEqual([
      'q: no dataset="…" clause found',
    ]);
  });

  it('flags empty dataset even when a later projected field is non-empty', () => {
    const q = 'dataset="" | project dataset="otel"';
    expect(validateQuery('q', q).some((e) => e.includes('empty dataset'))).toBe(true);
  });

  it('flags (?i) upstream of export-to-lookup', () => {
    const q = `print _raw="__sentinel__"
      | union (dataset="otel" | where _raw matches regex "(?i)consume")
      | export mode=overwrite to lookup my_lookup`;
    const errors = validateQuery('q', q);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('(?i)');
  });

  it('allows (?i) in queries that do not export to a lookup', () => {
    const q = 'dataset="otel" | where _raw matches regex "(?i)consume"';
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags mv-expand upstream of export-to-lookup', () => {
    const q = `print k="__sentinel__"
      | union (dataset="otel" | extend k=bag_keys(attributes) | mv-expand k)
      | export mode=overwrite to lookup my_lookup`;
    const errors = validateQuery('q', q);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('mv-expand');
  });

  it('allows mv-expand without an export', () => {
    const q = 'dataset="otel" | extend k=bag_keys(attributes) | mv-expand k';
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags an empty lookup name at end of query', () => {
    const q = 'dataset="otel" | limit 1 | export mode=overwrite to lookup ';
    const errors = validateQuery('q', q);
    expect(errors).toContain('q: export-to-lookup with empty lookup name');
  });

  it('ignores (?i) / mv-expand mentioned only in KQL comment lines', () => {
    const q = `print _raw="__sentinel__"
      | union (
          dataset="otel"
          // we use [Cc]onsume instead of (?i) here; mv-expand is avoided
          | where _raw matches regex "[Cc]onsume"
        )
      | export mode=overwrite to lookup my_lookup`;
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags export-to-lookup without a sentinel-first pipeline', () => {
    // Regression guard for the v0.10.0 "Unknown lookup" outage:
    // on some Cribl versions `| export mode=overwrite` on 0 rows
    // deletes the lookup CSV entirely.
    const q = `dataset="otel" | summarize n=count() by svc
      | export mode=overwrite to lookup my_lookup`;
    const errors = validateQuery('q', q);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sentinel');
  });

  it('flags the WRONG-ORDER union pattern (real-first, sentinel-branch)', () => {
    // Verified on staging: `<real> | union (print …) | export` skips
    // the export tail when <real> emits 0 rows, even though the
    // union output has 1 row. Must be `print … | union (<real>)`.
    const q = `dataset="otel" | summarize n=count() by svc
      | union (print svc="__sentinel__", n=tolong(0))
      | export mode=overwrite to lookup my_lookup`;
    const errors = validateQuery('q', q);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sentinel');
  });

  it('accepts print-based seed queries with no sentinel', () => {
    // The `print`-only shape is itself a deterministic 1-row emitter.
    const q = `print svc="__init__", n=tolong(0)
      | export mode=overwrite to lookup my_lookup`;
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags an empty lookup name followed by a pipe', () => {
    const q = 'dataset="otel" | limit 1 | export to lookup | limit 1';
    const errors = validateQuery('q', q);
    expect(errors).toContain('q: export-to-lookup with empty lookup name');
  });
});

describe('validateName', () => {
  it('accepts letters, digits, spaces, underscores and dashes', () => {
    expect(validateName('q', 'Cribl APM - home service summary')).toEqual([]);
    expect(validateName('q', 'Cribl APM - 6-day per-service error-rate history')).toEqual([]);
    expect(validateName('q', 'a_b-c 1')).toEqual([]);
  });

  it('rejects the v0.10.0 names Cribl 400d on', () => {
    // The two that actually shipped broken (deploy_events, noise_budget).
    const slash = validateName('deploy', 'Cribl APM - deploy/change correlation events');
    expect(slash.length).toBe(1);
    expect(slash[0]).toContain('"/"');

    const parens = validateName('noise', 'Cribl APM - alert noise budget (per-svc, per-day fires)');
    expect(parens.length).toBe(1);
    expect(parens[0]).toContain('"("');
    expect(parens[0]).toContain('","');
  });

  it('rejects an empty name', () => {
    expect(validateName('q', '')).toHaveLength(1);
  });
});

describe('validateProvisionPlan', () => {
  it('aggregates violations across targets with ids', () => {
    const errors = validateProvisionPlan([
      { id: 'good', query: 'dataset="otel" | limit 1' },
      { id: 'bad', query: 'dataset="" | limit 1' },
    ]);
    expect(errors.every((e) => e.startsWith('bad:'))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes the real provisioning plan + seed lookups (dataset=otel)', () => {
    setCurrentDataset('otel');
    // Mirrors the target list scripts/provision.ts builds, names
    // included — a plan whose names Cribl would 400 on must fail here,
    // in CI, not in a user's browser at provision time.
    const targets = [
      ...getProvisioningPlan().map((s) => ({ id: s.id, query: s.query, name: s.name })),
      ...SEED_LOOKUPS.map((l) => ({ id: `seed:${l.name}`, query: l.seedQuery })),
    ];
    expect(validateProvisionPlan(targets)).toEqual([]);
  });

  it('refuses to build the real provisioning plan when the dataset store is empty', () => {
    setCurrentDataset('');
    try {
      expect(() => getProvisioningPlan()).toThrow('dataset ID');
    } finally {
      setCurrentDataset('otel');
    }
  });
});
