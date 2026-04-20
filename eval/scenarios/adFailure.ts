import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adFailure',
  flag: 'adFailure',
  variant: 'on',
  expectedService: 'ad',
  // 10% Bernoulli rate on ~10 GetAds/min = ~1 error/min.
  // Need 4+ minutes for reliable detection.
  telemetryWaitMs: 4 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeAdErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[0-9]+\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("ad")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
  ],
  investigator: {
    prompt:
      'Are there any ad service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'ad.*error|GetAds|UNAVAILABLE|adservice',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
