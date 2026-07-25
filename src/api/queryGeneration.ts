/**
 * Navigation-scoped query cancellation.
 *
 * The implementation now lives in the shared framework
 * (`@cribl/app-utils/query-generation`) — the framework's `runQuery`
 * defaults its abort signal to the current generation, so pushing this
 * down means one controller drives both the framework search layer and
 * this app's metrics reads. This module re-exports it so existing
 * imports (`./queryGeneration`) keep working, and to centralize the
 * browser-safe subpath (the framework root barrel pulls the provisioner
 * → `node:fs`, which breaks in browser code — same reason `./metrics`
 * re-exports `@cribl/app-utils/metrics`).
 *
 * Each page calls `newQueryGeneration()` at the start of its data fetch
 * to abort the prior generation's in-flight KQL jobs + metrics fetches,
 * and guards late `setState`s with `captureQueryGeneration()`.
 */
export {
  newQueryGeneration,
  currentQuerySignal,
  withGenerationSignal,
  captureQueryGeneration,
} from '@cribl/app-utils/query-generation';
