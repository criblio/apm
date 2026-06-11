import { describe, it, expect } from 'vitest';
import { validateQuery, validateProvisionPlan } from '../provisionGuard';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { getProvisioningPlan, SEED_LOOKUPS } from '../provisionedSearches';

describe('validateQuery', () => {
  it('passes a healthy read query', () => {
    expect(validateQuery('q', 'dataset="otel" | summarize count() by svc')).toEqual([]);
  });

  it('passes a healthy export query', () => {
    const q = `dataset="otel" | summarize n=count() by svc
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
    const q = `dataset="otel" | where _raw matches regex "(?i)consume"
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
    const q = `dataset="otel" | extend k=bag_keys(attributes) | mv-expand k
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
    const q = `dataset="otel"
      // we use [Cc]onsume instead of (?i) here; mv-expand is avoided
      | where _raw matches regex "[Cc]onsume"
      | export mode=overwrite to lookup my_lookup`;
    expect(validateQuery('q', q)).toEqual([]);
  });

  it('flags an empty lookup name followed by a pipe', () => {
    const q = 'dataset="otel" | limit 1 | export to lookup | limit 1';
    const errors = validateQuery('q', q);
    expect(errors).toContain('q: export-to-lookup with empty lookup name');
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
    const targets = [
      ...getProvisioningPlan().map((s) => ({ id: s.id, query: s.query })),
      ...SEED_LOOKUPS.map((l) => ({ id: `seed:${l.name}`, query: l.seedQuery })),
    ];
    expect(validateProvisionPlan(targets)).toEqual([]);
  });

  it('fails the real provisioning plan when the dataset store is empty', () => {
    // Replays the June outage: framework dataset store defaulting to ''.
    setCurrentDataset('');
    const targets = getProvisioningPlan().map((s) => ({ id: s.id, query: s.query }));
    const errors = validateProvisionPlan(targets);
    setCurrentDataset('otel');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('empty dataset'))).toBe(true);
  });
});
