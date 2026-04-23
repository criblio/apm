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
  telemetryWaitMs: 4 * 60_000,
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
  ],
  investigator: {
    prompt:
      'Checkout is experiencing errors calling the cart service. Is cart having availability issues in the last 15 minutes?',
    expectedRootCausePattern: 'cart.*error|connection.*refused|unavailable|readiness|pod|restart|cart.*down|cart.*unreachable',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
