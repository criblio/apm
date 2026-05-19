import type { ScenarioDeclaration } from '../types.js';

/**
 * Smooth-climb / leak-fingerprint scenario.
 *
 * Unlike the named flagd scenarios, this one isn't triggered by a
 * flag flip — it's the natural state of the demo cluster when a
 * long-running pod has been accumulating fingerprint cardinality
 * (e.g. session.id stamped on every span via BaggageSpanProcessor)
 * for many days. The 2026-05-02 frontend deploy left the pod up for
 * 11+ days, and its error_rate has climbed monotonically from 0.37%
 * to ~14%.
 *
 * The eval verifies the Investigator can identify the leak
 * fingerprint and recommend pod restart, rather than chasing the
 * paymentFailure / kafkaQueueProblems flagd scenarios it's been
 * trained on.
 *
 * Surface checks are minimal — today the app doesn't surface this
 * scenario in any panel beyond "frontend has a high error rate."
 * Once D / A / C ship, additional surface assertions land here.
 */
const scenario: ScenarioDeclaration = {
  name: 'leakFingerprint',
  // No flag flip — this scenario observes the live demo's natural state.
  // The engine sees flag/variant absent and skips the flagd round-trip.
  expectedService: 'frontend',
  // Telemetry wait can be short because the condition is already
  // present in the live data; no need to wait for a flag's effect
  // to propagate.
  telemetryWaitMs: 30_000,
  cooldownMs: 60_000,
  surfaceChecks: [
    // The frontend should be on the alerts page with a non-zero error
    // rate. This is the same surface check the other error_rate
    // scenarios make against their expected service.
    {
      surface: 'alertsPageFrontend',
      page: 'alerts',
      locator:
        'table tr:has-text("frontend"):is(:has-text("Firing"), :has-text("Pending"))',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
  ],
  kqlChecks: [
    // Confirm the leak signature is present in the dataset before
    // judging the investigator. If err_rate isn't actually climbing,
    // the scenario is mis-configured for this run window.
    {
      surface: 'frontendErrorRateAboveBaseline',
      query:
        'dataset="otel" | where isnotnull(end_time_unix_nano) ' +
        '| extend svc=tostring(resource.attributes[\'service.name\']), ' +
        'is_error=(tostring(status.code)=="2") ' +
        '| where svc == "frontend" ' +
        '| summarize total=count(), errs=countif(is_error) ' +
        '| extend err_rate=todouble(errs)/todouble(total) ' +
        '| where err_rate > 0.01',
      earliest: '-1h',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 60_000,
    },
    // Confirm the frontend pod has been up for many days — if a
    // recent deploy reset it, the leak isn't there to find.
    {
      surface: 'frontendPodOldUptime',
      query:
        'dataset="otel" | where isnotnull(end_time_unix_nano) ' +
        '| extend svc=tostring(resource.attributes[\'service.name\']), ' +
        'pod_start=tostring(resource.attributes[\'k8s.pod.start_time\']) ' +
        '| where svc == "frontend" and isnotempty(pod_start) ' +
        '| summarize start_iso=max(pod_start) ' +
        '| extend uptime_days=(todouble(unixtime_seconds_todatetime(_time) - todatetime(start_iso))) / 86400.0',
      earliest: '-5m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'The frontend service error rate has climbed from <1% to ~14% over the last 10 days. ' +
      'Identify the root cause and recommend a specific verification action.',
    // Score positive if the conclusion mentions the leak signature OR
    // recommends the pod restart action. Negative if it pins blame on
    // a flagd scenario (paymentFailure, kafkaQueueProblems, etc.) or
    // a downstream service.
    expectedRootCausePattern:
      'leak|cardinality|session\\.id|pod (age|uptime|restart)|rollout restart|long(-| )running pod',
    // 10m — the leak playbook involves 4 separate KQL queries
    // (slope, downstream health, pod uptime, cardinality) and an
    // explicit decision step. Realistic completion is ~6-8 min;
    // 10m leaves headroom without bloating the per-scenario budget.
    waitMs: 10 * 60_000,
  },
};

export default scenario;
