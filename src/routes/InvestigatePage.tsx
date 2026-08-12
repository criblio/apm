/**
 * Investigate — embedded Copilot Investigator chat UI.
 *
 * The chat shell (transcript, streaming markdown, approvals,
 * composer, PNG export, stop/new controls) lives in
 * @cribl/app-utils/investigator. This page owns what's APM about
 * an investigation:
 *
 *   - the seed handed over via router state from "Investigate"
 *     buttons elsewhere in the app (cleared on consumption so a
 *     reload doesn't re-fire),
 *   - seed enrichment (time-window tightening from the prompt +
 *     preflight anomaly signals),
 *   - the context preamble / tool surface (agentContext,
 *     agentToolDefs, agentTools),
 *   - the render_trace result card, drawn with APM's SpanTree
 *     waterfall.
 */
import { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  InvestigatorChat,
  type InvestigatorTranscriptEntry,
} from '@cribl/app-utils/investigator';
import MetricsToolCard from '@cribl/app-utils/investigator/metrics-tool-card';
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { useInvestigationReplay } from '../hooks/useInvestigationReplay';
// Side effect: pins the analytics surface tag ('criblApmInvestigation')
// before the shell runs its first loop.
import '../api/agent';
import {
  buildAgentContext,
  buildSeedPrompt,
  tightenEarliestFromPrompt,
  type InvestigationSeed,
} from '../api/agentContext';
import { runPreflight, formatPreflightSignals } from '../api/agentPreflight';
import { APM_TOOL_DEFINITIONS } from '../api/agentToolDefs';
import {
  executeToolCall,
  requiresApproval,
  type MetricsQueryUi,
  type RenderTraceUi,
  type ToolResultUi,
} from '../api/agentTools';
import SpanTree from '../components/SpanTree';
import { summarizeTrace } from '../api/transform';
import s from './InvestigatePage.module.css';

const EMPTY_SUGGESTIONS: string[] = [
  'Which services have elevated error rates right now?',
  'Compare p95 latency by service over the last hour',
  'Find traces slower than 5 seconds in the last 15 minutes',
  'Show recent errors from the checkout service',
];

function buildContext() {
  return buildAgentContext(getCurrentDataset());
}

// Enrich a seed before building the prompt:
//
//  1. **Time-window discipline**: when the user phrased the
//     question with "in the last N minutes" / "right now", honor
//     that instead of inheriting the seed's default. Without this,
//     a fresh investigation against a 15m default window pulls in
//     stale errors from prior tests (the bleed-over class of
//     misattribution we documented in the 2026-04-12 eval).
//
//  2. **Preflight signals**: run the silent-service / rate-drop /
//     error-spike preflight against the (possibly tightened)
//     range and merge results into knownSignals so the agent
//     starts with our anomaly summary instead of having to
//     discover it.
//
//  Both steps are best-effort. A failure in either should not
//  block the investigation — we just ship the seed as-is.
async function enrichSeed(seed: InvestigationSeed): Promise<InvestigationSeed> {
  let next: InvestigationSeed = seed;
  const tightened = tightenEarliestFromPrompt(seed.question);
  if (tightened) {
    next = { ...next, earliest: tightened, latest: 'now' };
  }
  try {
    const earliest = next.earliest ?? '-15m';
    const latest = next.latest ?? 'now';
    const preflight = await runPreflight(earliest, latest);
    const lines = formatPreflightSignals(preflight);
    const merged: string[] = [...(next.knownSignals ?? []), ...lines];
    next = { ...next, knownSignals: merged };
  } catch {
    /* swallow — caller still gets the time-tightened seed */
  }
  return next;
}

/** Render APM's custom result cards: the trace waterfall for
 *  render_trace and the shared metrics chart card for run_metrics_query.
 *  Everything else falls through to the shell's built-in cards. */
function renderApmToolCard(ui: ToolResultUi) {
  if (ui.kind === 'trace') return <TraceCard ui={ui as RenderTraceUi} />;
  if (ui.kind === 'metrics') return <MetricsToolCard ui={ui as MetricsQueryUi} />;
  return null;
}

interface LocationState {
  seed?: InvestigationSeed;
}

export default function InvestigatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const seed = (location.state as LocationState | null)?.seed;

  // `?investigation=<id>` opens a read-only replay of a server-side
  // investigation (from an Alerts-page badge). It takes precedence
  // over any router seed.
  const replayId = new URLSearchParams(location.search).get('investigation');

  // Clear the seed from location state once the shell consumes it
  // so a reload doesn't re-fire the same investigation.
  const handleSeedConsumed = useCallback(() => {
    navigate(location.pathname, { replace: true, state: {} });
  }, [navigate, location.pathname]);

  if (replayId) {
    return <InvestigationReplayView id={replayId} onExit={() => navigate('/alerts')} />;
  }

  return (
    <InvestigatorChat<InvestigationSeed>
      seed={seed}
      title="Copilot Investigation"
      subtitle="AI-assisted root-cause analysis on Cribl APM data"
      emptyStateTitle="Cribl APM Copilot"
      emptyStateHint="Ask a question about your services, traces, logs, or metrics — or start from one of these:"
      emptyStateSuggestions={EMPTY_SUGGESTIONS}
      buildSeedPrompt={buildSeedPrompt}
      enrichSeed={enrichSeed}
      toolDefinitions={APM_TOOL_DEFINITIONS}
      buildContext={buildContext}
      executeToolCall={executeToolCall}
      requiresApproval={requiresApproval}
      renderToolCard={renderApmToolCard}
      onSeedConsumed={handleSeedConsumed}
    />
  );
}

const REPLAY_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Investigating…',
  concluded: 'Investigated',
  failed: 'Investigation failed',
  cancelled: 'Investigation cancelled',
};

/**
 * Read-only replay of a server-side investigation. Drives the shared
 * `applyLoopEvent` reducer over the cell's event stream via
 * `useInvestigationReplay`, so the transcript is byte-identical to a
 * live client run.
 *
 * NOTE: the per-entry rendering below is the compact interim view.
 * Once framework PR #23 (`InvestigatorTranscript`) merges and the
 * framework SHA is bumped, replace the entry map with:
 *   <InvestigatorTranscript entries={entries} running={running}
 *     renderToolCard={renderApmToolCard} />
 * to get the rich Search/Summary/Trace cards. The data layer
 * (hook + transport) does not change.
 */
function InvestigationReplayView({ id, onExit }: { id: string; onExit: () => void }) {
  const { entries, status, running, error } = useInvestigationReplay(id);

  return (
    <div className={s.replayPage}>
      <div className={s.replayHeader}>
        <div>
          <div className={s.replayTitle}>Server-side investigation</div>
          <div className={s.replaySubtitle}>
            {status ? (REPLAY_STATUS_LABEL[status] ?? status) : 'Connecting…'} · read-only replay
          </div>
        </div>
        <button type="button" className={s.replayExit} onClick={onExit}>
          Back to Alerts
        </button>
      </div>

      {error && (
        <div className={s.toolResultError}>
          Couldn’t reach the investigator: {error}
        </div>
      )}

      {entries.length === 0 && !error && (
        <div className={s.replayEmpty}>
          {running ? 'Waiting for the investigation to produce output…' : 'No transcript yet.'}
        </div>
      )}

      <div className={s.replayTranscript}>
        {entries.map((entry) => (
          <ReplayEntry key={entry.id} entry={entry} />
        ))}
        {running && <div className={s.replayThinking}>▋ thinking…</div>}
      </div>
    </div>
  );
}

function ReplayEntry({ entry }: { entry: InvestigatorTranscriptEntry }) {
  if (entry.kind === 'user') {
    // The seed prompt is large boilerplate; show a short marker
    // rather than the full dataset-schema preamble.
    return <div className={s.replayUser}>Investigation started.</div>;
  }
  if (entry.kind === 'assistant') {
    return <div className={s.replayAssistant}>{entry.content}</div>;
  }
  if (entry.kind === 'error') {
    return <div className={s.toolResultError}>{entry.message}</div>;
  }
  // toolCall
  const name = entry.call.function.name;
  const ui = entry.result?.ui as { kind?: string; conclusion?: string } | undefined;
  if (name === 'present_investigation_summary' && ui?.conclusion) {
    return (
      <div className={s.replaySummary}>
        <div className={s.replaySummaryLabel}>📋 Conclusion</div>
        <div>{ui.conclusion}</div>
      </div>
    );
  }
  return (
    <div className={s.replayToolCall}>
      🔧 {name} <span className={s.replayToolStatus}>({entry.status})</span>
    </div>
  );
}

function TraceCard({ ui }: { ui: RenderTraceUi }) {
  // Keep the selected-span state local to this card so each rendered
  // trace has its own independent selection.
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const traceId = ui.traceId || '(unknown)';
  const description = ui.description || 'Render trace';

  return (
    <div className={s.toolCall}>
      <div className={s.toolCallHeader}>
        <div>
          <div className={s.toolCallDescription}>
            🧵 Trace: {description}
          </div>
          <div className={s.toolCallMeta}>
            {traceId}
            {ui.trace && (() => {
              const summary = summarizeTrace(ui.trace);
              const durMs = (summary.duration / 1000).toFixed(1);
              return ` · ${summary.spanCount} spans · ${durMs}ms · ${summary.errorCount} errors`;
            })()}
          </div>
        </div>
      </div>
      {ui.error && <div className={s.toolResultError}>{ui.error}</div>}
      {ui.trace && (
        <div className={s.traceTreeWrap}>
          <SpanTree
            trace={ui.trace}
            selectedSpanId={selectedSpanId}
            onSelect={setSelectedSpanId}
          />
        </div>
      )}
    </div>
  );
}
