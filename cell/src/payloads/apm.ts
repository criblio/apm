/**
 * The APM investigator payload — everything domain-specific the cell
 * runs, behind the CellPayload seam (../payload.ts).
 *
 * Collects what used to live inline in the DOs: alert parsing +
 * incident grouping (coordinator), the $vt_results poll query
 * (coordinator), seed building with preflight parity to the browser
 * Investigator (investigation DO), the APM tool executors, the
 * lifecycle commits that power the Alerts page badges, and the
 * canned stub turns. The harness knows none of these — it calls
 * through the interface.
 */
import {
  buildAlertSeed,
  buildSeedPrompt,
  type InvestigationSeed,
} from '../../../src/api/agentContext';
import {
  runPreflight,
  formatPreflightSignals,
} from '../../../src/api/agentPreflight';
import { createApmToolExecutors } from '../../../src/api/agentTools';
import { APM_TOOL_DEFINITIONS } from '../../../src/api/agentToolDefs';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { CriblClient } from '../criblClient';
import {
  createCellSearchClient,
  createCellMetricsTransport,
} from '../cellSearchClient';
import { incidentKey, type FiringAlert } from '../protocol';
import { stubTurnEvents } from '../stubAgent';
import type { Env } from '../env';
import type {
  CellPayload,
  InteractiveInput,
  LifecycleEvent,
  SeedResult,
  StubTurn,
} from '@criblio/cell-harness';

/** Poll cadence window — matches the notify search's -15m; the
 *  coordinator's event_id dedupe absorbs the overlap between
 *  consecutive polls. */
const POLL_WINDOW = '-15m';

/** One Cribl client per isolate: the OAuth token cache is the point
 *  of sharing it (every DO used to mint its own). Env is constant for
 *  the life of an isolate, so a single lazy ref is safe. */
let criblRef: CriblClient | null = null;

function cribl(env: Env): CriblClient | null {
  if (criblRef) return criblRef;
  const { CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET } = env;
  if (!CRIBL_BASE_URL || (!env.CRIBL_DEV_TOKEN && (!CRIBL_CLIENT_ID || !CRIBL_CLIENT_SECRET))) {
    return null;
  }
  criblRef = new CriblClient({
    baseUrl: CRIBL_BASE_URL,
    clientId: CRIBL_CLIENT_ID ?? '',
    clientSecret: CRIBL_CLIENT_SECRET ?? '',
    dataset: env.CRIBL_DATASET ?? 'otel',
    devToken: env.CRIBL_DEV_TOKEN,
  });
  return criblRef;
}

function requireCribl(env: Env): CriblClient {
  const c = cribl(env);
  if (!c) throw new Error('Cribl access is not configured on this cell');
  return c;
}

/** APM lifecycle event names (the dataset contract the Alerts page
 *  reads — unchanged from before the payload seam). */
const LIFECYCLE_EVENT_TYPE: Record<
  LifecycleEvent<FiringAlert>['type'],
  'started' | 'investigated' | 'investigation_failed'
> = {
  started: 'started',
  concluded: 'investigated',
  failed: 'investigation_failed',
};

export const apmPayload: CellPayload<FiringAlert, Env> = {
  parseTrigger(raw: unknown): FiringAlert | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const alert: FiringAlert = {
      event_id: String(r.event_id ?? ''),
      alert_id: String(r.alert_id ?? ''),
      svc: String(r.svc ?? ''),
      signal_type: String(r.signal_type ?? ''),
      curr_error_rate: Number(r.curr_error_rate ?? 0),
      fire_count: Number(r.fire_count ?? 0),
      _time: Number(r._time ?? 0),
    };
    if (!alert.event_id || !alert.alert_id || !alert.svc) return null;
    return alert;
  },

  triggerFacts(alert: FiringAlert) {
    return {
      dedupeKey: alert.event_id,
      subjectId: alert.alert_id,
      groupKey: incidentKey(alert),
    };
  },

  // Carry the seed's service into the group key ("svc:interactive")
  // so the incident page can correlate interactive runs by service;
  // a bare 'interactive' key made them structurally unmatchable
  // (observed 2026-08-20: eval-launched runs invisible on incidents).
  interactiveGroupKey(context: InteractiveInput['context']): string {
    const svc = typeof context?.service === 'string' ? context.service.trim() : '';
    return svc ? `${svc}:interactive` : 'interactive';
  },

  /** One poll: read the criblapm__alert_notify search's LATEST cached
   *  results from $vt_results. Reading the notify search's output —
   *  rather than re-scanning the dataset — preserves the app-side
   *  serverInvestigations gate: when the flag is off the provisioner
   *  deletes that search, $vt_results has no rows under its jobName,
   *  and the poll is a guaranteed no-op. It also replaces a raw -15m
   *  dataset scan every 5 minutes with a cheap cache read. */
  async pollTriggers(env: Env): Promise<unknown[]> {
    const client = cribl(env);
    // No Cribl access configured (e.g. offline smoke) — poll is a no-op.
    if (!client) return [];
    // Latest run only: $vt_results retains keepLastN runs; jobId's
    // fixed-width epoch-millis prefix makes the string max the newest.
    const kql = `dataset="$vt_results"
      | where jobName == "criblapm__alert_notify"
      | join kind=inner (
          dataset="$vt_results"
          | where jobName == "criblapm__alert_notify"
          | summarize jobId=max(tostring(jobId))
        ) on jobId
      | project event_id, alert_id, svc, signal_type, curr_error_rate, fire_count, _time
      | limit 50`;
    return client.runQuery(kql, POLL_WINDOW, 'now', 50);
  },

  ready(env: Env): boolean {
    return cribl(env) != null;
  },

  /**
   * Seed for an alert-fired run: built exactly like the Alerts page
   * does, enriched with the preflight (the same signals the browser
   * injects — silent services, rate drops, error spikes, recent
   * deploys; best-effort by construction, runPreflight swallows
   * failures into an empty result).
   */
  async buildSeed(alert: FiringAlert, env: Env): Promise<SeedResult> {
    const client = requireCribl(env);
    setCurrentDataset(client.dataset);
    const seed: InvestigationSeed = buildAlertSeed({
      service: alert.svc,
      signalType: alert.signal_type,
      errorRate: Number(alert.curr_error_rate ?? 0),
    });
    const search = createCellSearchClient(client);
    const preflight = await runPreflight(seed.earliest ?? '-1h', seed.latest ?? 'now', search);
    seed.knownSignals = [
      ...(seed.knownSignals ?? []),
      ...formatPreflightSignals(preflight),
    ];
    return { prompt: buildSeedPrompt(seed), seed };
  },

  /**
   * Seed for an interactive session: the user's opening prompt run
   * through the same buildSeedPrompt() preamble the browser and the
   * alert path use — identical dataset schema + KQL guidance. No
   * preflight: the user drives the question directly, and skipping it
   * keeps the first response fast.
   */
  async buildInteractiveSeed(input: InteractiveInput, env: Env): Promise<SeedResult> {
    const client = requireCribl(env);
    setCurrentDataset(client.dataset);
    const seed: InvestigationSeed = {
      question: input.prompt,
      service: input.context?.service,
      earliest: input.context?.earliest,
      latest: input.context?.latest,
    };
    return { prompt: buildSeedPrompt(seed), seed };
  },

  createTools(env: Env) {
    const client = requireCribl(env);
    return {
      definitions: APM_TOOL_DEFINITIONS,
      executors: createApmToolExecutors({
        client: createCellSearchClient(client),
        dataset: () => client.dataset,
        metricsTransport: createCellMetricsTransport(client),
      }),
    };
  },

  concludingToolName: 'present_investigation_summary',

  /** Extract a ≤1KB text snippet from a SummaryUi-shaped conclusion. */
  conclusionSnippet(conclusion: unknown): string {
    if (conclusion && typeof conclusion === 'object') {
      const c = conclusion as { conclusion?: unknown };
      if (typeof c.conclusion === 'string') return c.conclusion;
    }
    return '';
  },

  targetService(alert: FiringAlert | null): string | undefined {
    return alert?.svc;
  },

  async commitLifecycle(env: Env, ev: LifecycleEvent<FiringAlert>): Promise<void> {
    const client = cribl(env);
    if (!client) return;
    const eventType = LIFECYCLE_EVENT_TYPE[ev.type];
    await client.commitInvestigationEvent({
      event_id: `${ev.sessionId}:${eventType}`,
      event_type: eventType,
      alert_id: ev.subjectId,
      investigation_id: ev.sessionId,
      trigger_event_id: ev.triggerDedupeKey,
      svc: ev.trigger?.svc ?? '',
      signal_type: ev.trigger?.signal_type ?? '',
      conclusion: ev.conclusionText,
    });
  },

  /** The canned scaffold turns, with the conclusion lifted out of the
   *  summary tool result (the harness no longer knows which tool
   *  concludes the stub). */
  stubTurn(turnIndex: number, alert: FiringAlert): StubTurn {
    const stub = stubTurnEvents(turnIndex, alert);
    let conclusion: unknown;
    for (const ev of stub.events) {
      if (ev.kind === 'toolResult' && ev.result.name === 'present_investigation_summary') {
        conclusion = ev.result.ui ?? null;
      }
    }
    return { events: stub.events, done: stub.done, conclusion };
  },
};
