export interface Env {
  COORDINATOR: DurableObjectNamespace;
  INVESTIGATION: DurableObjectNamespace;
  /** Bearer for POST /alerts/fire (the notification-target webhook). */
  WEBHOOK_BEARER?: string;
  /** Bearer for the UI's proxied calls (proxies.yml kv.cellToken). */
  UI_BEARER?: string;
  /** HMAC key for WS tickets. */
  TICKET_SECRET?: string;
  /** "true" drops all new triggers — a per-node operator kill
   *  switch. The feature-level on/off is enforced app side (the
   *  notify search only exists when the flag is on), so the cell
   *  processes whatever reaches /alerts/fire. */
  DISABLED?: string;

  // ── Real agent mode (LLM_BASE_URL present ⇒ real loop; absent ⇒
  //    stub agent, so the scaffold smoke keeps passing configless) ──
  /** OpenAI-compatible endpoint base, e.g. https://api.openai.com/v1 */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  /** Model id sent to the endpoint. */
  LLM_MODEL?: string;

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
