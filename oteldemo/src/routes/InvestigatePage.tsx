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
import { buildSeedPrompt, type InvestigationSeed } from '../api/agentContext';
import type { AgentMessage, AgentToolCall } from '../api/agent';
import type { ToolExecutionResult, RunSearchUi } from '../api/agentTools';
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
        setTranscript((prev) => [
          ...prev,
          { kind: 'error', id: `err-${Date.now()}`, message: msg },
        ]);
        setRunning(false);
      });
    },
    [sessionId, handleLoopEvent, approveToolCall],
  );

  // Seed the conversation on first mount if we arrived with a seed.
  const didSeedRef = useRef(false);
  useEffect(() => {
    if (didSeedRef.current) return;
    didSeedRef.current = true;
    if (!seed) return;
    const prompt = buildSeedPrompt(seed);
    setTranscript([
      {
        kind: 'user',
        id: `u-${Date.now()}`,
        content: seed.question,
      },
    ]);
    startInvestigation([
      { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
    ]);
    // Clear the seed from location state so a reload doesn't re-fire
    // the same investigation.
    navigate(location.pathname, { replace: true, state: {} });
  }, [seed, startInvestigation, navigate, location.pathname]);

  const submitFreeForm = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      const freeSeed: InvestigationSeed = { question: trimmed };
      const prompt = buildSeedPrompt(freeSeed);
      setTranscript((prev) => [
        ...prev,
        { kind: 'user', id: `u-${Date.now()}`, content: trimmed },
      ]);
      setComposerText('');
      startInvestigation([
        { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
      ]);
    },
    [running, startInvestigation],
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
  // We only render a rich card for run_search. Other tools (update_context,
  // summaries, etc.) are agent plumbing the user doesn't need to see —
  // they're represented by the surrounding assistant text.
  if (entry.call.function.name !== 'run_search') {
    return null;
  }

  const args = parseRunSearchArgs(entry.call.function.arguments);
  const resultUi = entry.result?.ui;

  return (
    <div className={s.toolCall}>
      <div className={s.toolCallHeader}>
        <div>
          <div className={s.toolCallDescription}>
            {args.description || 'Run search'}
          </div>
          <div className={s.toolCallMeta}>
            {args.earliest ?? '-15m'} to {args.latest ?? 'now'}
            {resultUi && ` · ${resultUi.rowCount} rows · ${resultUi.durationMs}ms`}
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
      {resultUi?.error && (
        <div className={s.toolResultError}>{resultUi.error}</div>
      )}
      {resultUi && !resultUi.error && resultUi.rows.length > 0 && (
        <ResultTable ui={resultUi} />
      )}
      {resultUi && !resultUi.error && resultUi.rows.length === 0 && (
        <div className={s.toolResultMeta}>No results</div>
      )}
    </div>
  );
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
      if (lastIdx !== -1) {
        const next = prev.slice();
        const entry = next[lastIdx] as AssistantEntry;
        next[lastIdx] = { ...entry, inProgress: false };
        return next;
      }
      return prev;
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
      return prev.map((e) =>
        e.kind === 'toolCall' && e.call.id === ev.result.id
          ? {
              ...e,
              status: ev.result.ui?.error ? 'error' : 'done',
              result: ev.result,
            }
          : e,
      );
    }
    case 'notification':
    case 'done':
      return prev;
    case 'error':
      return [
        ...prev,
        { kind: 'error', id: `err-${Date.now()}`, message: ev.error.message },
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
