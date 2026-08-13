/**
 * Browser globals referenced by framework modules that ride along in
 * the cell bundle through the shared-code import graph but are never
 * invoked here (the browser fetch client, the hosted-agent client,
 * the provisioner's browser branch — all call-time-only `window`
 * reads). These declarations satisfy the type checker without
 * pulling the DOM lib in next to @cloudflare/workers-types.
 *
 * If a cell code path ever actually calls one of these functions at
 * runtime it will throw on the undefined global — which is the
 * correct failure: the cell must reach Cribl through CriblClient,
 * never through the browser client.
 */
// eslint-disable-next-line no-var -- `declare var` is the required idiom for ambient globals
declare var window: {
  CRIBL_API_URL?: string;
  CRIBL_BASE_PATH?: string;
} & Record<string, unknown>;

interface ImportMeta {
  env: Record<string, string | undefined>;
}
