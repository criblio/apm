import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'kafkaQueueProblems',
  flag: 'kafkaQueueProblems',
  variant: 'on',
  expectedService: 'fraud-detection',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
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
  
    {
      surface: 'homeDetectedIssuesfrauddetection',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("fraud-detection")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPagefrauddetectionFiring',
      page: 'alerts',
      locator: 'table tr:has-text("fraud-detection"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: 'svcDetailAlertBadge',
      page: 'serviceDetail',
      locator: 'h1:has-text("fraud-detection") span:text-matches("firing|pending", "i")',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],

  kqlChecks: [
    {
      surface: 'alertStatefrauddetectionFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "fraud-detection" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistoryfrauddetectionFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "fraud-detection" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
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
