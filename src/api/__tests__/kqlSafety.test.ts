import { describe, expect, it } from 'vitest';
import {
  KqlSafetyError,
  assertKqlPredicate,
  assertReadOnlyKql,
  kqlBracketField,
  kqlDatasetId,
  kqlFiniteNumber,
  kqlInteger,
  kqlStringLiteral,
  kqlTime,
  kqlTraceId,
} from '../kqlSafety';

describe('KQL scalar serialization', () => {
  it('escapes quotes, slashes, newlines, and control characters', () => {
    expect(kqlStringLiteral('a"\\\n\u0001| send')).toBe('"a\\"\\\\\\n\\u0001| send"');
  });

  it.each(['', 'otel" | send', '../otel', 'a b'])('rejects unsafe dataset %j', (value) => {
    expect(() => kqlDatasetId(value)).toThrow(KqlSafetyError);
  });

  it('allows OTel field names but rejects a bracket escape', () => {
    expect(kqlBracketField('http.response.status_code')).toBe("['http.response.status_code']");
    expect(() => kqlBracketField("x'] | send")).toThrow(KqlSafetyError);
  });

  it('rejects non-finite, fractional integer, and out-of-range numbers', () => {
    expect(() => kqlFiniteNumber(Number.NaN)).toThrow();
    expect(() => kqlInteger(1.5)).toThrow();
    expect(() => kqlInteger(0, { min: 1 })).toThrow();
  });

  it('validates times and trace IDs', () => {
    expect(kqlTime('-15m')).toBe('-15m');
    expect(kqlTime('now')).toBe('now');
    expect(() => kqlTime('-1m | send')).toThrow();
    expect(kqlTraceId('0123456789ABCDEF')).toBe('0123456789abcdef');
    expect(() => kqlTraceId('abc" | send')).toThrow();
  });
});

describe('predicate boundary', () => {
  it.each([
    'true) | send group="search"',
    'x == 1; export to lookup pwned',
    'x == 1 | union (dataset="secrets")',
    'dataset="otel"',
    'x == 1 // comment\n | send',
    'x == "unterminated',
  ])('rejects hostile predicate %j', (predicate) => {
    expect(() => assertKqlPredicate(predicate)).toThrow(KqlSafetyError);
  });

  it('allows pipes and operator words inside strings', () => {
    expect(assertKqlPredicate('body contains "| send export"')).toBe(
      'body contains "| send export"',
    );
  });
});

describe('Investigator read-only boundary', () => {
  it('accepts scoped read-only pipelines', () => {
    expect(
      assertReadOnlyKql('dataset="otel" | where status == "send" | summarize count()', ['otel']),
    ).toContain('summarize');
  });

  it.each([
    'dataset="otel" | send group="search"',
    'dataset="otel" | export to lookup x',
    'dataset="otel"; .cancel queries',
    'dataset="other" | limit 1',
    'dataset=dynamic_name | limit 1',
  ])('rejects side effects or scope escape %j', (query) => {
    expect(() => assertReadOnlyKql(query, ['otel'])).toThrow(KqlSafetyError);
  });
});
