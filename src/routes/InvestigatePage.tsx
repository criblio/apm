/**
 * Investigate — embedded Copilot Investigator chat UI.
 *
 * Drives the agent loop in agentLoop.ts, renders the streaming
 * conversation, and mediates tool-call approvals. Users land here
 * either from the nav tab (free-form prompt) or from an
 * "Investigate" button elsewhere in the app that seeds the prompt
 * with service/operation/anomaly context.
 *
 * Message timeline model: every user message, assistant response,
 * and tool call becomes an entry in `transcript`. Tool calls render
 * as approval cards inline; once executed, the card's rows table
 * replaces the approval buttons.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { runInvestigation, type LoopEvent } from '../api/agentLoop';
import {
  buildSeedPrompt,
  tightenEarliestFromPrompt,
  type InvestigationSeed,
} from '../api/agentContext';
import { runPreflight, formatPreflightSignals } from '../api/agentPreflight';
import type { AgentMessage, AgentToolCall } from '../api/agent';
import { isSessionExpiredError } from '../api/agent';
import type {
  ToolExecutionResult,
  RunSearchUi,
  RenderTraceUi,
  SummaryUi,
} from '../api/agentTools';
import SpanTree from '../components/SpanTree';
import { summarizeTrace } from '../api/transform';
import s from './InvestigatePage.module.css';

// ─────────────────────────────────────────────────────────────────
// Transcript entry model
// ─────────────────────────────────────────────────────────────────

interface UserEntry {
  kind: 'user';
  id: string;
  content: string;
}

interface AssistantEntry {
  kind: 'assistant';
  id: string;
  turnId: string;
  content: string;
  inProgress: boolean;
}

interface ToolCallEntry {
  kind: 'toolCall';
  id: string;
  turnId: string;
  call: AgentToolCall;
  needsApproval: boolean;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  result?: ToolExecutionResult;
}

interface ErrorEntry {
  kind: 'error';
  id: string;
  message: string;
  /** True when this error is a session-expired from the platform's
   *  auth token. The UI shows a Reload Page affordance instead of
   *  just the raw message. */
  sessionExpired?: boolean;
}

type TranscriptEntry = UserEntry | AssistantEntry | ToolCallEntry | ErrorEntry;

// ─────────────────────────────────────────────────────────────────
// Minimal markdown rendering
// ─────────────────────────────────────────────────────────────────
//
// The assistant emits markdown-flavored text: headings, inline code,
// fenced blocks, bold. No need for a full markdown library — we
// handle the handful of things the agent actually uses and render
// everything else as paragraphs.

function renderAssistantMarkdown(text: string): React.ReactNode[] {
  if (!text) return [];
  // Split on fenced code blocks first so we can preserve their
  // whitespace. Simple three-backtick fences only.
  const parts: Array<{ kind: 'text' | 'code'; body: string }> = [];
  const regex = /```(?:\w+)?\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ kind: 'text', body: text.slice(lastIdx, m.index) });
    }
    parts.push({ kind: 'code', body: m[1] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ kind: 'text', body: text.slice(lastIdx) });
  }

  const nodes: React.ReactNode[] = [];
  let nodeKey = 0;
  for (const part of parts) {
    if (part.kind === 'code') {
      nodes.push(<pre key={`pre-${nodeKey++}`}>{part.body}</pre>);
      continue;
    }
    // Split text into paragraphs by blank lines. Inside each para,
    // render inline code spans and bold spans.
    const paras = part.body.split(/\n{2,}/);
    for (const para of paras) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      nodes.push(<p key={`p-${nodeKey++}`}>{renderInline(trimmed)}</p>);
    }
  }
  return nodes;
}

function renderInline(text: string): React.ReactNode[] {
  // Inline code spans and bold spans only — interleaved by
  // scanning left-to-right and splitting on the nearest token.
  const out: React.ReactNode[] = [];
  let key = 0;
  let rest = text;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/;
  while (rest.length > 0) {
    const idx = rest.search(pattern);
    if (idx === -1) {
      out.push(rest);
      break;
    }
    if (idx > 0) out.push(rest.slice(0, idx));
    const match = rest.slice(idx).match(pattern)![0];
    if (match.startsWith('`')) {
      out.push(<code key={`c-${key++}`}>{match.slice(1, -1)}</code>);
    } else {
      out.push(<strong key={`b-${key++}`}>{match.slice(2, -2)}</strong>);
    }
    rest = rest.slice(idx + match.length);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────

const EMPTY_SUGGESTIONS: string[] = [
  'Which services have elevated error rates right now?',
  'Compare p95 latency by service over the last hour',
  'Find traces slower than 5 seconds in the last 15 minutes',
  'Show recent errors from the checkout service',
];

function newSessionId(): string {
  // Matches the native UI's UUID shape — not strictly required, but
  // many Cribl analytics endpoints treat it as a conversation key.
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

interface LocationState {
  seed?: InvestigationSeed;
}

export default function InvestigatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const seed = (location.state as LocationState | null)?.seed;

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [composerText, setComposerText] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId] = useState(newSessionId);

  // Transcript auto-scroll: stick to bottom as new entries arrive.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Approval gate: the loop calls this when it hits a run_search
  // with confirmBeforeRunning:true. We resolve the returned promise
  // when the user clicks "Run Query" or "Skip" on the inline card.
  const pendingApprovalRef = useRef<{
    callId: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const approveToolCall = useCallback(
    (call: { id: string }) =>
      new Promise<boolean>((resolve) => {
        pendingApprovalRef.current = { callId: call.id, resolve };
      }),
    [],
  );

  const resolveApproval = useCallback(
    (callId: string, approved: boolean) => {
      if (pendingApprovalRef.current?.callId === callId) {
        pendingApprovalRef.current.resolve(approved);
        pendingApprovalRef.current = null;
      }
      setTranscript((prev) =>
        prev.map((e) =>
          e.kind === 'toolCall' && e.call.id === callId
            ? { ...e, status: approved ? 'running' : 'skipped' }
            : e,
        ),
      );
    },
    [],
  );

  const handleLoopEvent = useCallback((ev: LoopEvent) => {
    setTranscript((prev) => applyLoopEvent(prev, ev));
    if (ev.kind === 'done' || ev.kind === 'error') {
      setRunning(false);
    }
  }, []);

  const startInvestigation = useCallback(
    (initialMessages: AgentMessage[]) => {
      setRunning(true);
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      runInvestigation({
        sessionId,
        initialMessages,
        onEvent: handleLoopEvent,
        approveToolCall,
        signal: abortRef.current.signal,
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const sessionExpired = isSessionExpiredError(err);
        setTranscript((prev) => [
          ...prev,
          { kind: 'error', id: `err-${Date.now()}`, message: msg, sessionExpired },
        ]);
        setRunning(false);
      });
    },
    [sessionId, handleLoopEvent, approveToolCall],
  );

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
  const enrichSeed = useCallback(
    async (s: InvestigationSeed): Promise<InvestigationSeed> => {
      let next: InvestigationSeed = s;
      const tightened = tightenEarliestFromPrompt(s.question);
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
    },
    [],
  );

  // Seed the conversation on first mount if we arrived with a seed.
  const didSeedRef = useRef(false);
  useEffect(() => {
    if (didSeedRef.current) return;
    didSeedRef.current = true;
    if (!seed) return;
    setTranscript([
      {
        kind: 'user',
        id: `u-${Date.now()}`,
        content: seed.question,
      },
    ]);
    // Clear the seed from location state so a reload doesn't re-fire
    // the same investigation.
    navigate(location.pathname, { replace: true, state: {} });
    void (async () => {
      const enriched = await enrichSeed(seed);
      const prompt = buildSeedPrompt(enriched);
      startInvestigation([
        { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
      ]);
    })();
  }, [seed, startInvestigation, navigate, location.pathname, enrichSeed]);

  const submitFreeForm = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      setTranscript((prev) => [
        ...prev,
        { kind: 'user', id: `u-${Date.now()}`, content: trimmed },
      ]);
      setComposerText('');
      void (async () => {
        const freeSeed: InvestigationSeed = { question: trimmed };
        const enriched = await enrichSeed(freeSeed);
        const prompt = buildSeedPrompt(enriched);
        startInvestigation([
          { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
        ]);
      })();
    },
    [running, startInvestigation, enrichSeed],
  );

  const handleComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFreeForm(composerText);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
    // Resolve any pending approval as "skipped" so the loop unblocks.
    if (pendingApprovalRef.current) {
      pendingApprovalRef.current.resolve(false);
      pendingApprovalRef.current = null;
    }
  };

  const handleNew = () => {
    abortRef.current?.abort();
    setTranscript([]);
    setComposerText('');
    setRunning(false);
  };

  const isEmpty = transcript.length === 0;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <div className={s.title}>Copilot Investigation</div>
          <div className={s.subtitle}>
            AI-assisted root-cause analysis on Cribl APM data
          </div>
        </div>
        <div className={s.headerActions}>
          {running ? (
            <button className={s.btn} onClick={handleStop}>
              Stop
            </button>
          ) : (
            !isEmpty && (
              <button className={s.btn} onClick={handleNew}>
                New investigation
              </button>
            )
          )}
        </div>
      </div>

      <div className={s.transcript} ref={transcriptRef}>
        <div className={s.transcriptInner}>
          {isEmpty && !running ? (
            <EmptyState onPick={submitFreeForm} />
          ) : (
            transcript.map((entry) => (
              <TranscriptRow
                key={entry.id}
                entry={entry}
                onApprove={(id) => resolveApproval(id, true)}
                onSkip={(id) => resolveApproval(id, false)}
              />
            ))
          )}
          {running && <ThinkingIndicator />}
        </div>
      </div>

      <div className={s.composer}>
        <div className={s.composerInner}>
          <textarea
            className={s.composerTextarea}
            placeholder="Ask me to investigate something..."
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={handleComposerKey}
            disabled={running}
            rows={1}
          />
          <button
            className={s.composerSend}
            onClick={() => submitFreeForm(composerText)}
            disabled={running || !composerText.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className={s.emptyState}>
      <div className={s.emptyTitle}>Cribl APM Copilot</div>
      <div className={s.emptyHint}>
        Ask a question about your services, traces, logs, or metrics —
        or start from one of these:
      </div>
      <div className={s.suggestions}>
        {EMPTY_SUGGESTIONS.map((sg) => (
          <button key={sg} className={s.suggestion} onClick={() => onPick(sg)}>
            {sg}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className={s.thinking}>
      <div className={s.thinkingDots}>
        <span className={s.thinkingDot} />
        <span className={s.thinkingDot} />
        <span className={s.thinkingDot} />
      </div>
      Thinking…
    </div>
  );
}

function TranscriptRow({
  entry,
  onApprove,
  onSkip,
}: {
  entry: TranscriptEntry;
  onApprove: (callId: string) => void;
  onSkip: (callId: string) => void;
}) {
  if (entry.kind === 'user') {
    return <div className={s.userMessage}>{entry.content}</div>;
  }
  if (entry.kind === 'assistant') {
    return (
      <div className={s.assistantMessage}>
        <div className={s.assistantIcon}>AI</div>
        <div className={s.assistantBody}>
          {renderAssistantMarkdown(entry.content)}
        </div>
      </div>
    );
  }
  if (entry.kind === 'error') {
    if (entry.sessionExpired) {
      return (
        <div className={s.errorBanner} role="alert">
          <div className={s.errorBannerTitle}>
            Cribl AI bearer token cache is in a broken state
          </div>
          <div className={s.errorBannerBody}>
            <p>
              The Cribl AI subsystem returned{' '}
              <code>Bearer Token has expired</code>. This is a
              platform-side problem with the per-user AI token cache,
              <em>not</em> your Cribl session — other Cribl API calls
              are still working.
            </p>
            <p>
              <strong>Reloading this page will not help.</strong> The
              same failure reproduces in Cribl Search&apos;s own
              native <code>/search/agent</code> Copilot UI on this
              workspace, so client-side retries can&apos;t recover.
              Known mitigations:
            </p>
            <ul>
              <li>Fully log out of Cribl Cloud and log back in.</li>
              <li>
                Wait for the server-side cache to TTL out and try
                again.
              </li>
              <li>Contact Cribl support if the problem persists.</li>
            </ul>
          </div>
        </div>
      );
    }
    return <div className={s.errorBanner}>Error: {entry.message}</div>;
  }
  // toolCall
  return (
    <ToolCallCard
      entry={entry}
      onApprove={() => onApprove(entry.call.id)}
      onSkip={() => onSkip(entry.call.id)}
    />
  );
}

function ToolCallCard({
  entry,
  onApprove,
  onSkip,
}: {
  entry: ToolCallEntry;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const name = entry.call.function.name;
  const ui = entry.result?.ui;

  if (name === 'run_search') {
    return (
      <SearchCard
        entry={entry}
        onApprove={onApprove}
        onSkip={onSkip}
        ui={ui?.kind === 'search' ? ui : undefined}
      />
    );
  }
  if (name === 'render_trace') {
    return <TraceCard entry={entry} ui={ui?.kind === 'trace' ? ui : undefined} />;
  }
  if (name === 'present_investigation_summary') {
    return <SummaryCard ui={ui?.kind === 'summary' ? ui : undefined} />;
  }
  // update_context and friends are agent plumbing — don't clutter the
  // transcript with them.
  return null;
}

function SearchCard({
  entry,
  onApprove,
  onSkip,
  ui,
}: {
  entry: ToolCallEntry;
  onApprove: () => void;
  onSkip: () => void;
  ui?: RunSearchUi;
}) {
  const args = parseRunSearchArgs(entry.call.function.arguments);
  return (
    <div className={s.toolCall}>
      <div className={s.toolCallHeader}>
        <div>
          <div className={s.toolCallDescription}>
            {args.description || 'Run search'}
          </div>
          <div className={s.toolCallMeta}>
            {args.earliest ?? '-15m'} to {args.latest ?? 'now'}
            {ui && ` · ${ui.rowCount} rows · ${ui.durationMs}ms`}
          </div>
        </div>
        {entry.status === 'pending' && entry.needsApproval && (
          <div className={s.toolCallActions}>
            <button className={`${s.btn} ${s.btnDanger}`} onClick={onSkip}>
              Skip
            </button>
            <button className={`${s.btn} ${s.btnPrimary}`} onClick={onApprove}>
              Run Query
            </button>
          </div>
        )}
      </div>
      <pre className={s.toolCallQuery}>{args.query ?? '(no query)'}</pre>
      {ui?.error && <div className={s.toolResultError}>{ui.error}</div>}
      {ui && !ui.error && ui.rows.length > 0 && <ResultTable ui={ui} />}
      {ui && !ui.error && ui.rows.length === 0 && (
        <div className={s.toolResultMeta}>No results</div>
      )}
    </div>
  );
}

function TraceCard({
  entry,
  ui,
}: {
  entry: ToolCallEntry;
  ui?: RenderTraceUi;
}) {
  // Keep the selected-span state local to this card so each rendered
  // trace has its own independent selection.
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const args = parseRenderTraceArgs(entry.call.function.arguments);
  const traceId = ui?.traceId ?? args.traceId ?? '(unknown)';
  const description = ui?.description || args.description || 'Render trace';

  return (
    <div className={s.toolCall}>
      <div className={s.toolCallHeader}>
        <div>
          <div className={s.toolCallDescription}>
            🧵 Trace: {description}
          </div>
          <div className={s.toolCallMeta}>
            {traceId}
            {ui?.trace && (() => {
              const summary = summarizeTrace(ui.trace);
              const durMs = (summary.duration / 1000).toFixed(1);
              return ` · ${summary.spanCount} spans · ${durMs}ms · ${summary.errorCount} errors`;
            })()}
          </div>
        </div>
      </div>
      {!ui && <div className={s.toolResultMeta}>Loading trace…</div>}
      {ui?.error && <div className={s.toolResultError}>{ui.error}</div>}
      {ui?.trace && (
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

function SummaryCard({ ui }: { ui?: SummaryUi }) {
  if (!ui) {
    return (
      <div className={s.summaryCard}>
        <div className={s.summaryTitle}>📋 Investigation summary</div>
        <div className={s.toolResultMeta}>Preparing…</div>
      </div>
    );
  }
  return (
    <div className={s.summaryCard}>
      <div className={s.summaryTitle}>📋 Investigation summary</div>
      {ui.findings.length > 0 && (
        <div className={s.summaryFindings}>
          {ui.findings.map((f, i) => (
            <div key={i} className={s.summaryFinding}>
              <div className={s.summaryCategory}>{f.category}</div>
              <div className={s.summaryDetails}>
                {renderAssistantMarkdown(f.details)}
              </div>
            </div>
          ))}
        </div>
      )}
      {ui.conclusion && (
        <div className={s.summaryConclusion}>
          <div className={s.summaryConclusionLabel}>Conclusion</div>
          <div>{renderAssistantMarkdown(ui.conclusion)}</div>
        </div>
      )}
    </div>
  );
}

function parseRenderTraceArgs(raw: string): {
  traceId?: string;
  description?: string;
} {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function ResultTable({ ui }: { ui: RunSearchUi }) {
  const { cols, rows } = useMemo(() => {
    const capped = ui.rows.slice(0, 20);
    const keyCounts = new Map<string, number>();
    for (const r of capped) {
      for (const k of Object.keys(r)) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
    const cols = Array.from(keyCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k)
      .slice(0, 8);
    return { cols, rows: capped };
  }, [ui.rows]);

  return (
    <div className={s.toolResult}>
      <table className={s.toolResultTable}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{formatCell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ui.rowCount > 20 && (
        <div className={s.toolResultMeta}>
          … {ui.rowCount - 20} more row{ui.rowCount - 20 === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseRunSearchArgs(raw: string): {
  query?: string;
  earliest?: string;
  latest?: string;
  description?: string;
} {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────
// Reducer — apply a LoopEvent to the transcript array
// ─────────────────────────────────────────────────────────────────

function applyLoopEvent(
  prev: TranscriptEntry[],
  ev: LoopEvent,
): TranscriptEntry[] {
  switch (ev.kind) {
    case 'assistantText': {
      // Find the most recent in-progress assistant entry for this
      // turn; append to it, or create one if missing.
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx !== -1) {
        const next = prev.slice();
        const entry = next[lastIdx] as AssistantEntry;
        next[lastIdx] = { ...entry, content: entry.content + ev.chunk };
        return next;
      }
      return [
        ...prev,
        {
          kind: 'assistant',
          id: `a-${ev.turnId}`,
          turnId: ev.turnId,
          content: ev.chunk,
          inProgress: true,
        },
      ];
    }
    case 'assistantDone': {
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx === -1) return prev;
      const next = prev.slice();
      const entry = next[lastIdx] as AssistantEntry;

      // If a SummaryCard was already rendered in this transcript
      // (from a real tool call), the agent sometimes ALSO writes a
      // redundant markdown dump starting with "## Findings". Drop
      // the entire assistant message in that case — the card is
      // the canonical rendering.
      const hasRenderedSummary = next.some(
        (e) =>
          e.kind === 'toolCall' &&
          e.call.function.name === 'present_investigation_summary' &&
          e.result?.ui?.kind === 'summary',
      );
      const looksLikeRedundantSummary =
        hasRenderedSummary &&
        /^\s*##\s*(Findings|Conclusion)\b/m.test(entry.content);
      if (looksLikeRedundantSummary) {
        next.splice(lastIdx, 1);
        return next;
      }

      // Scrub any {% present_investigation_summary {...} %} text the
      // agent may have written instead of calling the tool. If we
      // find any, split the assistant entry into cleaned text +
      // synthetic summary entries that render via SummaryCard.
      const { cleaned, summaries } = scrubTemplateSummaries(entry.content);
      if (summaries.length === 0) {
        next[lastIdx] = { ...entry, inProgress: false };
        return next;
      }
      const insertions: TranscriptEntry[] = [];
      // Replace the assistant entry with the cleaned version (if any
      // text remains) and append a synthetic toolCall entry per
      // parsed summary. Use a nanoid-ish key so React keeps stable.
      next[lastIdx] = { ...entry, inProgress: false, content: cleaned };
      // If the cleaned content is now empty, drop the assistant entry.
      if (!cleaned.trim()) {
        next.splice(lastIdx, 1);
      }
      for (let i = 0; i < summaries.length; i++) {
        const synthId = `synthetic-summary-${ev.turnId}-${i}`;
        insertions.push({
          kind: 'toolCall',
          id: synthId,
          turnId: ev.turnId,
          call: {
            id: synthId,
            function: {
              name: 'present_investigation_summary',
              arguments: JSON.stringify(summaries[i]),
            },
          },
          needsApproval: false,
          status: 'done',
          result: {
            id: synthId,
            name: 'present_investigation_summary',
            content: '',
            ui: summaries[i],
          },
        });
      }
      return [...next, ...insertions];
    }
    case 'toolCall': {
      return [
        ...prev,
        {
          kind: 'toolCall',
          id: `tc-${ev.call.id}`,
          turnId: ev.turnId,
          call: ev.call,
          needsApproval: ev.needsApproval,
          status: ev.needsApproval ? 'pending' : 'running',
        },
      ];
    }
    case 'toolResult': {
      return prev.map((e) => {
        if (e.kind !== 'toolCall' || e.call.id !== ev.result.id) return e;
        const ui = ev.result.ui;
        const hasError =
          (ui?.kind === 'search' && !!ui.error) ||
          (ui?.kind === 'trace' && !!ui.error);
        return { ...e, status: hasError ? 'error' : 'done', result: ev.result };
      });
    }
    case 'notification':
    case 'done':
      return prev;
    case 'error':
      return [
        ...prev,
        {
          kind: 'error',
          id: `err-${Date.now()}`,
          message: ev.error.message,
          sessionExpired: isSessionExpiredError(ev.error),
        },
      ];
  }
}

function findLastAssistant(entries: TranscriptEntry[], turnId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'assistant' && e.turnId === turnId) return i;
  }
  return -1;
}

/**
 * Scrub any occurrences of `{% present_investigation_summary {...} %}`
 * text that the agent sometimes emits as plain text instead of
 * calling the tool properly. Returns the cleaned text (for the
 * assistant bubble) and an array of parsed summaries (to render as
 * Summary cards inline).
 *
 * This is a belt-and-suspenders fallback: the prompt in
 * agentContext.ts instructs the agent to CALL the tool, but LLMs
 * occasionally improvise this template-literal format, and we don't
 * want the user to see raw JSON dumps in a pretty chat UI.
 */
function scrubTemplateSummaries(text: string): {
  cleaned: string;
  summaries: SummaryUi[];
} {
  const summaries: SummaryUi[] = [];
  // Two flavors seen in the wild:
  //   {% present_investigation_summary {...} %}
  //   {% present_investigation_summary("findings":[...]) %}
  // Match the tool name, then a balanced JSON object up to `%}`.
  const regex = /\{%\s*present_investigation_summary\s+(\{[\s\S]*?\})\s*%\}/g;
  let cleaned = text;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const findings: Array<{ category: string; details: string }> = [];
      if (Array.isArray(obj.findings)) {
        for (const f of obj.findings) {
          findings.push({
            category: typeof f.category === 'string' ? f.category : 'Finding',
            details: typeof f.details === 'string' ? f.details : '',
          });
        }
      }
      summaries.push({
        kind: 'summary',
        findings,
        conclusion: typeof obj.conclusion === 'string' ? obj.conclusion : '',
      });
      cleaned = cleaned.replace(m[0], '').trim();
    } catch {
      /* leave the raw template in place if parsing fails */
    }
  }
  return { cleaned, summaries };
}
