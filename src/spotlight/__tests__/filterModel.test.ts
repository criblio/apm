import { describe, it, expect } from 'vitest';
import { rowToKql, rowsToKql, newFilterRow } from '../filterModel';

describe('rowToKql', () => {
  it('emits a string equality with the span-attributes access path', () => {
    expect(
      rowToKql({ id: '1', attr: 'http.status_code', op: '=', value: '500' }),
    ).toBe(`tostring(attributes['http.status_code']) == "500"`);
  });

  it('uses resource.attributes for k8s.* names', () => {
    expect(
      rowToKql({ id: '1', attr: 'k8s.pod.name', op: '=', value: 'foo' }),
    ).toBe(`tostring(resource.attributes['k8s.pod.name']) == "foo"`);
  });

  it('uses resource.attributes for service.* names', () => {
    expect(
      rowToKql({ id: '1', attr: 'service.name', op: '!=', value: 'cart' }),
    ).toBe(`tostring(resource.attributes['service.name']) != "cart"`);
  });

  it('emits contains_cs for the ~ operator', () => {
    expect(
      rowToKql({ id: '1', attr: 'http.url', op: '~', value: '/api/' }),
    ).toBe(`tostring(attributes['http.url']) contains_cs "/api/"`);
  });

  it('wraps a negated contains_cs in `not (...)`', () => {
    expect(
      rowToKql({ id: '1', attr: 'http.url', op: '!~', value: 'healthz' }),
    ).toBe(`not (tostring(attributes['http.url']) contains_cs "healthz")`);
  });

  it('coerces both sides with toreal for numeric operators', () => {
    expect(
      rowToKql({ id: '1', attr: 'http.status_code', op: '>=', value: '500' }),
    ).toBe(`toreal(tostring(attributes['http.status_code'])) >= 500`);
  });

  it('escapes embedded double-quotes in the value', () => {
    expect(
      rowToKql({ id: '1', attr: 'http.target', op: '=', value: 'a"b' }),
    ).toBe(`tostring(attributes['http.target']) == "a\\"b"`);
  });

  it('rejects attribute names that could escape bracket access', () => {
    expect(() =>
      rowToKql({ id: '1', attr: `weird'attr`, op: '=', value: 'x' }),
    ).toThrow('field name');
  });
});

describe('rowsToKql', () => {
  it('returns empty string when there are no rows', () => {
    expect(rowsToKql([])).toBe('');
  });

  it('returns empty string when no rows are valid', () => {
    expect(
      rowsToKql([
        { id: '1', attr: '', op: '=', value: '' },
        { id: '2', attr: 'http.status_code', op: '=', value: '' },
      ]),
    ).toBe('');
  });

  it('joins valid rows with `and`', () => {
    expect(
      rowsToKql([
        { id: '1', attr: 'http.status_code', op: '=', value: '500' },
        { id: '2', attr: 'http.method', op: '=', value: 'GET' },
      ]),
    ).toBe(
      `tostring(attributes['http.status_code']) == "500" and tostring(attributes['http.method']) == "GET"`,
    );
  });

  it('skips incomplete rows but keeps the surrounding valid ones', () => {
    expect(
      rowsToKql([
        { id: '1', attr: 'http.status_code', op: '=', value: '500' },
        { id: '2', attr: '', op: '=', value: 'orphan' },
        { id: '3', attr: 'http.method', op: '=', value: 'POST' },
      ]),
    ).toBe(
      `tostring(attributes['http.status_code']) == "500" and tostring(attributes['http.method']) == "POST"`,
    );
  });
});

describe('newFilterRow', () => {
  it('returns a row with sensible defaults and a unique id', () => {
    const a = newFilterRow();
    const b = newFilterRow();
    expect(a.attr).toBe('');
    expect(a.op).toBe('=');
    expect(a.value).toBe('');
    expect(a.id).not.toBe(b.id);
  });

  it('merges partial overrides', () => {
    const r = newFilterRow({ attr: 'http.method', value: 'GET' });
    expect(r.attr).toBe('http.method');
    expect(r.value).toBe('GET');
    expect(r.op).toBe('=');
  });
});
