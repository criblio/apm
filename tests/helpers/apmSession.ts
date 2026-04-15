// Shared Playwright helpers for navigating the deployed APM pack via
// its direct pack URL (/app-ui/apm/). Inside the real Cribl Search
// shell, the host injects three things the pack needs to boot:
//
//   1. `window.CRIBL_BASE_PATH` — React Router basename
//   2. `window.CRIBL_API_URL`   — full URL ending at /api/v1
//   3. A wrapped `window.fetch` that attaches a Bearer token to any
//      same-origin API request. See AGENTS.md for the full list of
//      things that fetch proxy does.
//
// Direct navigation from Playwright bypasses all three. Without (1) and
// (2) React Router renders nothing and every fetch goes to the wrong
// URL. Without (3) the API returns 401 because cookie-based session
// auth is not accepted at /api/v1/*. We reconstruct all three via
// `addInitScript` before every `page.goto`.
//
// The Bearer token is obtained via the same OAuth client-credentials
// flow that `scripts/deploy.mjs` uses. Token is cached across tests.

import type { Page } from '@playwright/test';

export const APM_APP_PATH = process.env.CRIBL_APM_APP_PATH ?? '/app-ui/apm/';

function apiBase(): string {
  const raw = process.env.CRIBL_BASE_URL;
  if (!raw) {
    throw new Error(
      'CRIBL_BASE_URL is not set — apmSession needs it to build the API base. See .env.example.',
    );
  }
  return raw.replace(/\/$/, '') + '/api/v1';
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

async function getBearerToken(): Promise<string> {
  // Leave a 60s safety window so we don't hand out a token that
  // expires while a page is still running API calls.
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }
  const baseUrl = process.env.CRIBL_BASE_URL;
  const clientId = process.env.CRIBL_CLIENT_ID;
  const clientSecret = process.env.CRIBL_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error(
      'CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET must be set in .env — ' +
        'the Playwright helpers need them to mint a Bearer token for API calls.',
    );
  }
  const isStaging = /cribl-staging\.cloud/.test(baseUrl);
  const tokenUrl = isStaging
    ? 'https://login.cribl-staging.cloud/oauth/token'
    : 'https://login.cribl.cloud/oauth/token';
  const audience = isStaging
    ? 'https://api.cribl-staging.cloud'
    : 'https://api.cribl.cloud';
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
    }),
  });
  if (!resp.ok) {
    throw new Error(`OAuth token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(data)}`);
  }
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

/**
 * Install the host-global polyfills + a fetch wrapper that injects the
 * Bearer token. Call this once per test before the first `gotoApm`.
 */
export async function installCriblHostGlobals(page: Page): Promise<void> {
  const basePath = APM_APP_PATH.replace(/\/$/, '');
  const apiUrl = apiBase();
  const token = await getBearerToken();
  await page.addInitScript(
    ([bp, api, tok]) => {
      interface CriblWindow extends Window {
        CRIBL_BASE_PATH?: string;
        CRIBL_API_URL?: string;
      }
      const w = window as unknown as CriblWindow;
      w.CRIBL_BASE_PATH = bp;
      w.CRIBL_API_URL = api;

      // Wrap window.fetch so API calls carry the Bearer token. We only
      // inject on requests whose URL is same-origin and starts with the
      // configured API base, matching the host shell's behavior — don't
      // leak the token to third parties.
      const origFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const isApiCall = url.startsWith(api) || url.startsWith('/api/v1/');
        if (!isApiCall) return origFetch(input, init);
        const nextInit: RequestInit = { ...(init ?? {}) };
        const headers = new Headers(nextInit.headers ?? {});
        if (!headers.has('authorization')) {
          headers.set('authorization', `Bearer ${tok}`);
        }
        nextInit.headers = headers;
        return origFetch(input, nextInit);
      }) as typeof window.fetch;
    },
    [basePath, apiUrl, token],
  );
}

/**
 * Navigate to a pack-relative path. The React Router treats the pack
 * mount point as its basename, so in-app paths look like plain
 * `/`, `/service/payment`, `/investigate`, etc.
 */
export async function gotoApm(page: Page, inAppPath = '/'): Promise<void> {
  const trimmed = inAppPath.replace(/^\//, '');
  const target = APM_APP_PATH.replace(/\/$/, '') + '/' + trimmed;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
}
