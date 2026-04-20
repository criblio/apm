import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'kafkaQueueProblems',
  flag: 'kafkaQueueProblems',
  variant: 'on',
  expectedService: 'fraud-detection',
  telemetryWaitMs: 5 * 60_000,
  cooldownMs: 2 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeP99Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("fraud-detection") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeSlowestTraceClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Slowest trace")) li:has-text("consumed")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'svcDetailP99Spike',
      page: 'serviceDetail',
      locator: 'text=p99',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'Why is the fraud-detection service showing high p99 latency in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'kafka|consumer|lag|queue|accounting|fraud',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
