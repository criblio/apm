/**
 * The cell's authenticated Cribl client: OAuth client-credentials
 * token (cached), the framework search-job runner, the app-settings
 * KV read (kill switch), and investigation lifecycle event commits.
 *
 * Reuses the framework's `runSearchJob` + `getBearerToken` and the
 * app's shared `investigationEventCommitQuery` so none of the wire
 * shapes are re-implemented here.
 */
import { getBearerToken } from '@cribl/app-utils/auth';
import {
  runSearchJob,
  type SearchHttpClient,
  type SearchJobOptions,
} from '@cribl/app-utils/search-job';
import {
  investigationEventCommitQuery,
  type InvestigationEvent,
} from '../../src/api/generatedEventContract';

export interface CriblConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  dataset: string;
  /** Static bearer for offline testing against a mock Cribl server —
   *  skips the OAuth exchange entirely. Never set in production. */
  devToken?: string;
}

export class CriblClient {
  private readonly cfg: CriblConfig;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(cfg: CriblConfig) {
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/$/, '') };
  }

  private async bearer(): Promise<string> {
    if (this.cfg.devToken) return this.cfg.devToken;
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const value = await getBearerToken({
      baseUrl: this.cfg.baseUrl,
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
    });
    // Client-credentials tokens live ~1h; refresh conservatively.
    this.token = { value, expiresAt: Date.now() + 45 * 60_000 };
    return value;
  }

  private async http(): Promise<SearchHttpClient> {
    const token = await this.bearer();
    const base = `${this.cfg.baseUrl}/api/v1`;
    const call = async (method: string, path: string, body?: unknown) => {
      const resp = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          accept: 'application/json, application/x-ndjson',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`Cribl ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`);
      }
      // Single-document JSON parses here; NDJSON (the results
      // endpoint) does not, and MUST be returned as raw text —
      // runSearchJob's parseNdjson owns the schema-line-0 skip, and
      // pre-parsing into an array would leak that schema row in as
      // data.
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    return {
      get: (path) => call('GET', path),
      post: (path, body) => call('POST', path, body),
      del: (path) => call('DELETE', path),
    };
  }

  async runQuery(
    kql: string,
    earliest: string,
    latest: string,
    limit = 200,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const http = await this.http();
    const options: SearchJobOptions = { earliest, latest, limit, signal };
    return runSearchJob(http, kql, options);
  }

  /**
   * GET the synchronous metrics query endpoint and return the raw
   * NDJSON body. Parallel to runQuery for run_search: the metrics
   * tool's injected transport calls this so PromQL runs against the
   * fast store with the machine bearer, no browser globals. `path` is
   * built by the framework's `metricsQueryPath`, so the request
   * contract stays identical to the browser path.
   */
  async queryMetricsText(path: string, signal?: AbortSignal): Promise<string> {
    const token = await this.bearer();
    const resp = await fetch(`${this.cfg.baseUrl}/api/v1${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/x-ndjson, application/json',
      },
      signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`metrics query failed (${resp.status}): ${text.slice(0, 400)}`);
    }
    return text;
  }

  /** Commit one investigation lifecycle event to the dataset. */
  async commitInvestigationEvent(
    ev: Omit<InvestigationEvent, 'datatype' | 'record_kind' | 'schema_version' | 'producer'>,
  ): Promise<void> {
    const query = investigationEventCommitQuery(ev, this.cfg.dataset);
    // The export stage writes the row; the returned tee rows are
    // irrelevant here.
    await this.runQuery(query, '-1m', 'now', 10);
  }

  get dataset(): string {
    return this.cfg.dataset;
  }
}
