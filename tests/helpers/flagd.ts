// Minimal TypeScript client for the flagd-ui HTTP API that
// `scripts/flagd-set.sh` wraps. Kept deliberately small so scenario
// tests can import `setFlag` / `allOff` without shelling out to bash.
//
// Requires FLAGD_UI_URL to point at a reachable flagd-ui (typically a
// `kubectl port-forward svc/flagd 4000:4000`). See .env.example.
//
// The /api/read endpoint returns the unwrapped `{"flags": {...}}` shape;
// the /api/write endpoint expects it wrapped in `{"data": {...}}`. The
// asymmetry is on flagd-ui's side, not a bug here.

interface FlagVariants {
  [variant: string]: unknown;
}

interface FlagDefinition {
  defaultVariant: string;
  variants: FlagVariants;
  description?: string;
  state?: string;
}

interface FlagConfig {
  flags: Record<string, FlagDefinition>;
  [key: string]: unknown;
}

function baseUrl(): string {
  const url = process.env.FLAGD_UI_URL;
  if (!url) {
    throw new Error(
      'FLAGD_UI_URL is not set. Point it at a reachable flagd-ui (see .env.example). ' +
        'Example: kubectl -n otel-demo port-forward --address 0.0.0.0 svc/flagd 4000:4000',
    );
  }
  return url.replace(/\/$/, '');
}

async function readConfig(): Promise<FlagConfig> {
  const resp = await fetch(`${baseUrl()}/api/read`);
  if (!resp.ok) {
    throw new Error(`GET ${baseUrl()}/api/read failed: ${resp.status} ${await resp.text()}`);
  }
  const payload = (await resp.json()) as FlagConfig | { data: FlagConfig };
  return 'data' in payload && typeof payload.data === 'object'
    ? (payload.data as FlagConfig)
    : (payload as FlagConfig);
}

async function writeConfig(inner: FlagConfig): Promise<void> {
  const resp = await fetch(`${baseUrl()}/api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: inner }),
  });
  if (!resp.ok) {
    throw new Error(`POST ${baseUrl()}/api/write failed: ${resp.status} ${await resp.text()}`);
  }
}

/**
 * Flip a named flag to the given variant. Throws if the flag or variant
 * doesn't exist, so scenario tests fail loudly instead of silently
 * running against an unchanged config.
 */
export async function setFlag(name: string, variant: string): Promise<void> {
  const config = await readConfig();
  const flag = config.flags?.[name];
  if (!flag) {
    throw new Error(`flagd: flag not found: ${name}`);
  }
  if (!(variant in flag.variants)) {
    throw new Error(
      `flagd: variant "${variant}" not in flag "${name}": ${Object.keys(flag.variants).join(', ')}`,
    );
  }
  flag.defaultVariant = variant;
  await writeConfig(config);
}

/** Turn every flag back to its `off` variant. Safe to call in afterAll. */
export async function allOff(): Promise<void> {
  const config = await readConfig();
  for (const flag of Object.values(config.flags ?? {})) {
    flag.defaultVariant = 'off';
  }
  await writeConfig(config);
}
