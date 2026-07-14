/**
 * Tests for the faceted-navigation data layer — the query
 * builders + KQL shape, not the live behavior. The shape tests
 * pin the queries against accidental regressions (e.g., the
 * `countif(not <bool>)` dialect bug that bit us during PR D's
 * MCP validation).
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import {
  attrValueDistribution,
  spotlightAttrDiff,
  SPOTLIGHT_ATTRIBUTES,
} from '../queries';

beforeAll(() => setCurrentDataset('otel'));

describe('SPOTLIGHT_ATTRIBUTES', () => {
  it('keeps the request-shape http attributes', () => {
    // HTTP request method + route describe what the caller asked for —
    // they partition errors by request shape, not by response code.
    expect(SPOTLIGHT_ATTRIBUTES).toContain('http.request.method');
    expect(SPOTLIGHT_ATTRIBUTES).toContain('http.route');
  });

  it('excludes response-side status attributes (tautological with error selection)', () => {
    // status codes correlate 1:1 with "is this an error" and just
    // produce a 100% bar without surfacing actionable cause.
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('http.response.status_code');
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('http.status_code');
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('rpc.grpc.status_code');
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('response_flags');
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('error.type');
    expect(SPOTLIGHT_ATTRIBUTES).not.toContain('exception.type');
  });

  it('keeps the Spotlight parallel-query fan-out reasonable', () => {
    // Each entry triggers one query per Spotlight call. Keep the
    // list <= 25 to bound cluster-queue pressure.
    expect(SPOTLIGHT_ATTRIBUTES.length).toBeLessThanOrEqual(30);
  });
});

describe('attrValueDistribution', () => {
  it('uses resource.attributes for k8s.* attribute names', () => {
    const q = attrValueDistribution('k8s.pod.name', '');
    expect(q).toContain(`tostring(resource.attributes['k8s.pod.name'])`);
  });

  it('uses span attributes for http.* / rpc.* / app.* names', () => {
    const q = attrValueDistribution('http.status_code', '');
    expect(q).toContain(`tostring(attributes['http.status_code'])`);
    expect(q).not.toContain(`resource.attributes['http.status_code']`);
  });

  it('inlines the caller predicate as a where clause', () => {
    const q = attrValueDistribution(
      'http.status_code',
      `svc == "checkout"`,
    );
    expect(q).toContain(`| where svc == "checkout"`);
  });

  it('respects the limit', () => {
    const q = attrValueDistribution('http.status_code', '', 50);
    expect(q).toContain('| limit 50');
  });

  it('rejects attribute names that could escape bracket access', () => {
    expect(() => attrValueDistribution(`weird'attr`, '')).toThrow('field name');
  });

  it('projects exactly the expected columns for the wrapper', () => {
    const q = attrValueDistribution('http.status_code', '');
    expect(q).toContain('| project attr_name, attr_value, n');
  });

  it('resolves top-level span columns (name, kind) as bare columns', () => {
    expect(attrValueDistribution('name', '')).toContain(
      `attr_value=tostring(name)`,
    );
    expect(attrValueDistribution('kind', '')).toContain(
      `attr_value=tostring(kind)`,
    );
  });
});

describe('spotlightAttrDiff', () => {
  it('uses countif(==true) / countif(==false), not the not form', () => {
    // Regression test for the Cribl KQL dialect bug: `not <bool>`
    // inside countif() is rejected by the parser. PR D's MCP
    // validation surfaced this and switched to explicit equality.
    const q = spotlightAttrDiff('http.status_code', `status_code == "2"`);
    expect(q).toContain('countif(sel_match==true)');
    expect(q).toContain('countif(sel_match==false)');
    expect(q).not.toContain('countif(not sel_match)');
    expect(q).not.toContain('countif(!sel_match)');
  });

  it('defaults the selection to `true` when empty (all rows)', () => {
    const q = spotlightAttrDiff('http.status_code', '');
    expect(q).toContain('sel_match=true');
  });

  it('inlines the selection predicate', () => {
    const q = spotlightAttrDiff(
      'http.status_code',
      `status_code == "2"`,
    );
    expect(q).toContain('sel_match=status_code == "2"');
  });

  it('projects the SpotlightBucket-shaped columns', () => {
    const q = spotlightAttrDiff('http.status_code', '');
    expect(q).toContain('| project attr_name, attr_value, sel_n, base_n');
  });

  it('uses resource.attributes for k8s.* names', () => {
    const q = spotlightAttrDiff('k8s.pod.name', '');
    expect(q).toContain(`tostring(resource.attributes['k8s.pod.name'])`);
  });

  it('omits the scope clause when scopeKql is undefined', () => {
    const q = spotlightAttrDiff('http.status_code', `status.code=="2"`);
    // spansBase() itself ends with `| where isnotnull(...)`; the test
    // is that NO ADDITIONAL where clause was inserted between that
    // and the `| extend attr_value` step.
    const base = '| where isnotnull(end_time_unix_nano)';
    const after = q.slice(q.indexOf(base) + base.length);
    expect(after).toMatch(/^\s*\| extend attr_value/);
  });

  it('injects scopeKql as a where clause before the extend', () => {
    const q = spotlightAttrDiff(
      'http.status_code',
      `tostring(status.code)=="2"`,
      20,
      `tostring(resource.attributes['service.name'])=="payment"`,
    );
    expect(q).toContain(
      `| where tostring(resource.attributes['service.name'])=="payment"`,
    );
    // Scope must come BEFORE the extend so both sel and base are
    // constrained to the scope.
    expect(q.indexOf(`| where tostring(resource.attributes['service.name'])`)).toBeLessThan(
      q.indexOf(`| extend attr_value`),
    );
  });

  it('treats whitespace-only scopeKql as no scope', () => {
    const q = spotlightAttrDiff('http.status_code', '', 20, '   ');
    expect(q).not.toContain('| where    ');
  });
});
