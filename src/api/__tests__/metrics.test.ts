import { describe, it, expect } from 'vitest';
import { stepForRange } from '../metrics';

describe('stepForRange', () => {
  it('targets ~60 buckets across a relative range', () => {
    expect(stepForRange('-1h')).toBe(60); // 3600s / 60
    expect(stepForRange('-15m')).toBe(15); // 900s / 60
    expect(stepForRange('-24h')).toBe(1440); // 86400s / 60
    expect(stepForRange('-7d')).toBe(10080); // 604800s / 60
  });

  it('honors a custom bucket target', () => {
    expect(stepForRange('-1h', 30)).toBe(120);
  });

  it('never returns a step below 1 second', () => {
    expect(stepForRange('-30s', 60)).toBe(1);
  });

  it('falls back to 60s on an unparseable range', () => {
    expect(stepForRange('now')).toBe(60);
    expect(stepForRange('-1w')).toBe(60);
    expect(stepForRange('')).toBe(60);
  });
});
