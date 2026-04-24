/**
 * @cribl/app-utils — shared utilities for Cribl Search App packs.
 *
 * This package extracts the reusable infrastructure layer from the
 * Cribl APM app so other packs can build on the same foundation:
 *
 * - KV store client (read/write pack-scoped settings)
 * - KQL query runner
 * - App settings pattern (load/save/pub-sub)
 * - Scheduled search provisioner (declarative CRUD reconciliation)
 * - Alert state machine (debounce, transitions, lifecycle)
 *
 * Currently co-located in the APM repo as packages/app-utils/.
 * Will be published as a standalone package once the API surface
 * is validated by a second app consumer.
 */

export { kvGet, kvPut } from './kvstore.js';
export { runQuery } from './query.js';
export {
  evaluateTransition,
  newAlertState,
  alertIdFromIssue,
  alertLabel,
  DEFAULT_DEBOUNCE,
  type AlertState,
  type AlertStatus,
  type DebounceConfig,
  type Transition,
} from './alert-state.js';
