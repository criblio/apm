export interface Env {
  COORDINATOR: DurableObjectNamespace;
  INVESTIGATION: DurableObjectNamespace;
  /** Bearer for POST /alerts/fire (the notification-target webhook). */
  WEBHOOK_BEARER?: string;
  /** Bearer for the UI's proxied calls (proxies.yml kv.cellToken). */
  UI_BEARER?: string;
  /** HMAC key for WS tickets. */
  TICKET_SECRET?: string;
  /** "true" drops all new triggers — local kill switch. The KV-flag
   *  kill switch (settings/app serverInvestigations) lands with
   *  criblClient in PR 7. */
  DISABLED?: string;
}
