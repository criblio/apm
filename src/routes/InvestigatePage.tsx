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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  InvestigatorChat,
  InvestigatorTranscript,
  type InvestigatorTranscriptEntry,
} from '@cribl/app-utils/investigator';
import { SourceFileView, SourceFileModal } from '../components/SourceFileView';
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

/** The transcript entry shape the framework hands renderToolCard. The
 *  code-tool card reads the tool name + args from the call and the FULL
 *  result content (up to the cell's 60 KB read cap) from the result — not
 *  the small preview in the ui payload. */
interface CodeToolEntry {
  call?: { function?: { name?: string; arguments?: string } };
  result?: { content?: string };
}

function parseArgs(json: string): Record<string, string | undefined> {
  try {
    return JSON.parse(json || '{}') as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/** Icon + one-line argument label for a code tool, so the card reads like
 *  a Claude-Code tool-use block (`🔎 grep_code · Invalid token`). */
function codeToolHeader(tool: string, a: Record<string, string | undefined>): {
  icon: string;
  label: string;
} {
  switch (tool) {
    case 'checkout_repo':
      return { icon: '📦', label: a.service ?? a.repo ?? '' };
    case 'grep_code':
      return { icon: '🔎', label: [a.pattern, a.path].filter(Boolean).join('  ·  ') };
    case 'read_file':
      return { icon: '📄', label: a.path ?? '' };
    case 'list_dir':
      return { icon: '📁', label: a.path || '/' };
    default:
      return { icon: '🛠', label: tool };
  }
}

/** A compact right-aligned summary of the result (files, matches, lines). */
function codeToolSummary(tool: string, body: string): string {
  if (!body) return '';
  switch (tool) {
    case 'checkout_repo': {
      const m = /(\d+)\s+source files/.exec(body);
      return m ? `${m[1]} files` : '';
    }
    case 'grep_code': {
      if (/^\(no matches\)/.test(body)) return 'no matches';
      const n = body.split('\n').filter((l) => l.trim()).length;
      return `${n} match${n === 1 ? '' : 'es'}`;
    }
    case 'read_file': {
      if (/^File not found/.test(body)) return 'not found';
      const n = body.split('\n').length;
      return `${n} line${n === 1 ? '' : 's'}`;
    }
    case 'list_dir': {
      if (body === '(empty)') return 'empty';
      const n = body.split('\n').filter((l) => l.trim()).length;
      return `${n} item${n === 1 ? '' : 's'}`;
    }
    default:
      return '';
  }
}

/** Strip a leading `./` or `/` and any trailing slash so a grep result
 *  path (`src/payment/charge.js`) matches a read_file arg. */
function normalizePath(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\/+$/, '');
}

/** Collect grep_code matches across the transcript → file path ⇒ 1-based
 *  line numbers, so a read_file view can emphasize the lines the agent was
 *  looking for. */
function grepLineMap(
  entries: readonly InvestigatorTranscriptEntry[],
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const e of entries) {
    if (e.kind !== 'toolCall' || e.call?.function?.name !== 'grep_code') continue;
    const content = e.result?.content ?? '';
    for (const line of content.split('\n')) {
      const m = /^(.+?):(\d+):/.exec(line);
      if (!m) continue;
      const path = normalizePath(m[1]);
      const ln = Number(m[2]);
      if (!map.has(path)) map.set(path, new Set());
      map.get(path)!.add(ln);
    }
  }
  return map;
}

/** A collapsible tool-use card for the server-only source-code tools —
 *  header shows what ran (icon, tool, target, result summary); expanding it
 *  reveals the full result: the syntax-highlighted file for read_file (with
 *  grep-matched lines emphasized, and a button to pop the whole file into a
 *  modal), the match list for grep_code, the tree for list_dir. */
function CodeToolCard({
  entry,
  hotLines,
}: {
  entry: CodeToolEntry;
  hotLines?: Map<string, Set<number>>;
}) {
  const tool = entry?.call?.function?.name ?? 'code';
  const args = parseArgs(entry?.call?.function?.arguments ?? '');
  const body = entry?.result?.content ?? '';
  const { icon, label } = codeToolHeader(tool, args);
  const summary = codeToolSummary(tool, body);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const isFile = tool === 'read_file';
  const path = args.path ?? '';
  const highlight = isFile ? hotLines?.get(normalizePath(path)) : undefined;
  return (
    <div className={s.codeCard}>
      <div className={s.codeCardHeader}>
        <button
          type="button"
          className={s.codeCardToggle}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          disabled={!body}
        >
          <span className={s.codeCardChevron}>{body ? (open ? '▾' : '▸') : ''}</span>
          <span className={s.codeCardIcon}>{icon}</span>
          <code className={s.codeCardTool}>{tool}</code>
          {label && <span className={s.codeCardArg}>{label}</span>}
          {summary && <span className={s.codeCardSummary}>{summary}</span>}
        </button>
        {isFile && body && (
          <button
            type="button"
            className={s.codeCardOpen}
            onClick={() => setModal(true)}
            title="Open full file"
            aria-label="Open full file"
          >
            ⤢
          </button>
        )}
      </div>
      {open &&
        body &&
        (isFile ? (
          <SourceFileView content={body} path={path} highlight={highlight} />
        ) : (
          <pre className={s.codeCardBody}>{body}</pre>
        ))}
      {modal && (
        <SourceFileModal
          content={body}
          path={path}
          highlight={highlight}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  );
}

/** Render APM's custom result cards: the trace waterfall for render_trace,
 *  the metrics chart for run_metrics_query, and the source-code tool cards
 *  (checkout/grep/read/list). Everything else falls through to the shell's
 *  built-in cards. `hotLines` (grep matches by file) is supplied by the
 *  server view so read_file cards can emphasize the searched-for lines. */
function renderApmToolCard(
  ui: ToolResultUi,
  ctx?: { entry: unknown },
  hotLines?: Map<string, Set<number>>,
) {
  if (ui.kind === 'trace') return <TraceCard ui={ui as RenderTraceUi} />;
  if (ui.kind === 'metrics') return <MetricsToolCard ui={ui as MetricsQueryUi} />;
  if ((ui as unknown as { kind?: string }).kind === 'code') {
    return <CodeToolCard entry={ctx?.entry as CodeToolEntry} hotLines={hotLines} />;
  }
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

  // Grep matches by file, so read_file cards can emphasize the lines the
  // agent searched for. Recomputed as the transcript grows.
  const hotLines = useMemo(() => grepLineMap(entries), [entries]);
  const renderToolCard = useCallback(
    (ui: ToolResultUi, ctx: { entry: unknown }) => renderApmToolCard(ui, ctx, hotLines),
    [hotLines],
  );

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
          renderToolCard={renderToolCard}
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
