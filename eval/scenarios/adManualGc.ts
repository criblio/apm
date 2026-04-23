import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adManualGc',
  flag: 'adManualGc',
  variant: 'on',
  expectedService: 'ad',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeP99Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeSlowestTraceClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Slowest trace")) li:has-text("ad")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'svcDetailP99',
      page: 'serviceDetail',
      locator: 'text=p99',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'The ad service has high p99 latency but normal p50. What is causing intermittent slowness in the last 15 minutes?',
    expectedRootCausePattern: 'gc|garbage.collect|pause|bimodal|jvm|intermittent|spike|p99.*spike|latency.*ad|ad.*latency|sawtooth',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
