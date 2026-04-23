import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'failedReadinessProbe',
  flag: 'failedReadinessProbe',
  variant: 'on',
  // Cart is DOWN — it emits zero spans. The errors appear on
  // upstream callers (checkout, frontend) whose calls to cart
  // get connection refused. Check checkout's surfaces since it's
  // the direct caller.
  expectedService: 'checkout',
  // Readiness probe failure → k8s removes cart from endpoints →
  // upstream callers get connection errors. Propagation is slow.
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeCheckoutErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("checkout") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%|0\\.[0-9]*[1-9]+\\d*%',
      timeoutMs: 60_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("cart")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
  
    {
      surface: 'homeDetectedIssuescheckout',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("checkout")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPagecheckoutFiring',
      page: 'alerts',
      locator: 'table tr:has-text("checkout"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: 'svcDetailAlertBadge',
      page: 'serviceDetail',
      locator: 'h1:has-text("checkout") span:text-matches("firing|pending", "i")',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],

  kqlChecks: [
    {
      surface: 'alertStatecheckoutFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "checkout" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistorycheckoutFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "checkout" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'Checkout is experiencing errors calling the cart service. Is cart having availability issues in the last 15 minutes?',
    expectedRootCausePattern: 'cart.*error|connection.*refused|unavailable|readiness|pod|restart|cart.*down|cart.*unreachable',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
