import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'recommendationCacheFailure',
  flag: 'recommendationCacheFailure',
  variant: 'on',
  expectedService: 'recommendation',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeRecommendationErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("recommendation") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailErrorsChart',
      page: 'serviceDetail',
      locator: 'text=Errors',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'Why are there recommendation service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'recommendation.*error|cache|redis|ListRecommendations',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
