/**
 * The APM cell's environment: the harness contract (bearers, LLM,
 * repos — see @criblio/cell-harness CellEnv) plus the APM payload's
 * Cribl access.
 */
import type { CellEnv } from '@criblio/cell-harness';

export interface Env extends CellEnv {
  // ── Cribl access (search tools + investigation event commits) ──
  CRIBL_BASE_URL?: string;
  CRIBL_CLIENT_ID?: string;
  CRIBL_CLIENT_SECRET?: string;
  /** Telemetry dataset (default 'otel'). */
  CRIBL_DATASET?: string;
  /** Static bearer for offline testing against a mock Cribl server —
   *  never set in production. */
  CRIBL_DEV_TOKEN?: string;
}
