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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InvestigatorChat, InvestigatorTranscript } from '@cribl/app-utils/investigator';
import MetricsToolCard from '@cribl/app-utils/investigator/metrics-tool-card';
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { useInvestigationSession } from '../hooks/useInvestigationSession';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import { createInvestigation } from '../api/investigationTransport';
import { loadAppSettings } from '../api/appSettings';
import InvestigationsSidebar from '../components/InvestigationsSidebar';
import sidebar from '../components/InvestigationsSidebar.module.css';
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
  /** Passed when redirecting to `?investigation=<id>` right after
   *  creating a server investigation, so the interactive view shows the
   *  opening question without waiting on a status fetch. */
  openingPrompt?: string;
}

/** Turn a seed into the create payload the cell expects: the question
 *  becomes the prompt, and the scope becomes the context (the cell
 *  builds the full preamble itself via buildSeedPrompt). */
function seedToPrompt(seed: InvestigationSeed): string {
  const signals = seed.knownSignals?.length
    ? `\n\nWhat we already know:\n- ${seed.knownSignals.join('\n- ')}`
    : '';
  return `${seed.question}${signals}`;
}

export default function InvestigatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverMode = useServerInvestigations();
  const state = location.state as LocationState | null;
  const seed = state?.seed;
  const openingPrompt = state?.openingPrompt;

  // `?investigation=<id>` opens an existing server-side investigation —
  // interactive (with a composer) if it's still open, read-only if it
  // concluded or it's an autonomous alert investigation.
  const investigationId = new URLSearchParams(location.search).get('investigation');

  // Clear the seed from location state once the shell consumes it
  // so a reload doesn't re-fire the same investigation.
  const handleSeedConsumed = useCallback(() => {
    navigate(location.pathname, { replace: true, state: {} });
  }, [navigate, location.pathname]);

  // Flag off: the classic in-browser client Investigator (no server
  // record, so no recall panel).
  if (!serverMode) {
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

  // Server mode: the recall panel wraps whichever view is active.
  //  - `?investigation=<id>` → open that investigation (interactive or
  //    read-only).
  //  - a seed from an Investigate button → create one, then redirect.
  //  - otherwise → a composer to start a fresh one.
  let content: ReactNode;
  if (investigationId) {
    content = (
      <ServerInvestigationView
        id={investigationId}
        openingPrompt={openingPrompt}
        onExit={() => navigate('/investigate')}
      />
    );
  } else if (seed) {
    content = <CreatingInvestigation seed={seed} />;
  } else {
    content = <NewServerInvestigation />;
  }

  return (
    <div className={sidebar.layout}>
      <InvestigationsSidebar activeId={investigationId} />
      <div className={sidebar.main}>{content}</div>
    </div>
  );
}

/**
 * Create a server investigation from an Investigate-button seed, then
 * redirect to its `?investigation=<id>` view. A ref guards React 18
 * StrictMode's double-effect so we don't create two.
 */
function CreatingInvestigation({ seed }: { seed: InvestigationSeed }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const prompt = seedToPrompt(seed);
    loadAppSettings()
      .catch(() => null)
      .then((settings) =>
        createInvestigation({
          prompt,
          context: {
            service: seed.service,
            earliest: seed.earliest,
            latest: seed.latest,
          },
          repos: settings?.sourceRepos,
        }),
      )
      .then(({ id }) => {
        navigate(`/investigate?investigation=${encodeURIComponent(id)}`, {
          replace: true,
          state: { openingPrompt: prompt },
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [seed, navigate]);

  return (
    <div className={s.newInvestigation}>
      {error ? (
        <>
          <div className={s.newInvestigationTitle}>Couldn’t start the investigation</div>
          <div className={s.toolResultError}>{error}</div>
        </>
      ) : (
        <div className={s.newInvestigationHint}>Starting investigation on the server…</div>
      )}
    </div>
  );
}

/**
 * Empty-state composer for starting a fresh server investigation (flag
 * on, no seed). On submit it creates one and opens its view.
 */
function NewServerInvestigation() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || busy) return;
      setBusy(true);
      setError(null);
      try {
        const settings = await loadAppSettings().catch(() => null);
        const { id } = await createInvestigation({
          prompt: text,
          repos: settings?.sourceRepos,
        });
        navigate(`/investigate?investigation=${encodeURIComponent(id)}`, {
          state: { openingPrompt: text },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [busy, navigate],
  );

  return (
    <div className={s.newInvestigation}>
      <div className={s.newInvestigationTitle}>Cribl APM Copilot</div>
      <div className={s.newInvestigationHint}>
        Ask a question about your services, traces, logs, or metrics. The
        investigation runs on the server, so it keeps working and stays
        saved even if you close this tab.
      </div>
      {error && <div className={s.toolResultError}>{error}</div>}
      <form
        className={s.newComposer}
        onSubmit={(e) => {
          e.preventDefault();
          void start(draft);
        }}
      >
        <textarea
          className={s.composerInput}
          value={draft}
          disabled={busy}
          placeholder="e.g. Why is the checkout service throwing errors?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start(draft);
            }
          }}
          rows={2}
        />
        <button type="submit" className={s.composerSend} disabled={busy || !draft.trim()}>
          {busy ? 'Starting…' : 'Investigate'}
        </button>
      </form>
      <div className={s.suggestionRow}>
        {EMPTY_SUGGESTIONS.map((sug) => (
          <button
            key={sug}
            type="button"
            className={s.suggestionChip}
            disabled={busy}
            onClick={() => void start(sug)}
          >
            {sug}
          </button>
        ))}
      </div>
    </div>
  );
}

const REPLAY_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Investigating…',
  idle: 'Ready — ask a follow-up',
  concluded: 'Investigated',
  failed: 'Investigation failed',
  cancelled: 'Investigation cancelled',
};

/**
 * View for an existing server-side investigation, opened by id.
 *
 * Drives the shared `applyLoopEvent` reducer over the cell's event
 * stream via `useInvestigationSession`, rendering the entries through
 * the same `InvestigatorTranscript` view the live client uses — so it
 * is pixel-identical to a client run (Search/Summary cards, the APM
 * trace waterfall). When the investigation is interactive and still
 * open (`canSend`), it shows a composer for follow-up turns; an
 * autonomous or concluded investigation renders read-only.
 */
function ServerInvestigationView({
  id,
  openingPrompt,
  onExit,
}: {
  id: string;
  openingPrompt?: string;
  onExit: () => void;
}) {
  const {
    entries, status, mode, running, canSend, sending, error, sendMessage,
    canCancel, cancelling, cancel,
  } = useInvestigationSession(id, { openingPrompt });
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text || sending || !canSend) return;
    setDraft('');
    void sendMessage(text);
  };

  const subtitle = status
    ? REPLAY_STATUS_LABEL[status] ?? status
    : 'Connecting…';
  const kindLabel = canSend
    ? 'ask a follow-up below'
    : running
      ? mode === 'interactive'
        ? 'interactive'
        : 'running'
      : 'read-only';

  return (
    <div className={s.replayPage}>
      <div className={s.replayHeader}>
        <div>
          <div className={s.replayTitle}>Server-side investigation</div>
          <div className={s.replaySubtitle}>
            {subtitle} · {kindLabel}
          </div>
        </div>
        <div className={s.replayHeaderActions}>
          {canCancel && (
            <button
              type="button"
              className={s.replayStop}
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button type="button" className={s.replayExit} onClick={onExit}>
            New investigation
          </button>
        </div>
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
        <InvestigatorTranscript
          entries={entries}
          running={running}
          renderToolCard={renderApmToolCard}
        />
      </div>

      {canSend && (
        <form
          className={s.composer}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            className={s.composerInput}
            value={draft}
            disabled={sending || running}
            placeholder={
              running ? 'Investigating…' : 'Ask a follow-up question…'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
          />
          <button
            type="submit"
            className={s.composerSend}
            disabled={sending || running || !draft.trim()}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
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
