/**
 * Drive an interactive server-side investigation.
 *
 * It folds the cell's event stream through the shared `applyLoopEvent`
 * reducer so the transcript renders identically to a live client run.
 * Beyond a read-only replay, it also:
 *
 *   - seeds the opening user question as a `user` bubble (the cell
 *     keeps the prompt as history[0] but never emits it as an event),
 *   - exposes `sendMessage(content)` to append a follow-up user turn
 *     and resume the loop,
 *   - stops polling when the run parks at `idle` (a follow-up
 *     re-subscribes), so an idle conversation isn't polled forever.
 *
 * Reopening a past multi-turn conversation replays the user's side too:
 * the cell records each follow-up as a `userMessage` transcript event,
 * which this hook renders as a user bubble (deduped against the local
 * optimistic append during a live send). The opening question comes
 * from the stored seed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
} from '@cribl/app-utils/investigator';
import {
  fetchInvestigationStatus,
  sendInvestigationMessage,
  subscribeInvestigation,
  type InvestigationMode,
  type InvestigationStatus,
} from '../api/investigationTransport';

export interface InvestigationSession {
  entries: InvestigatorTranscriptEntry[];
  status: InvestigationStatus | null;
  mode: InvestigationMode | null;
  /** The agent is working the current turn (queued or running). */
  running: boolean;
  /** Parked awaiting a user message (interactive) — safe to send. */
  idle: boolean;
  /** Whether the composer should be shown: an interactive investigation
   *  that hasn't reached a terminal state. */
  canSend: boolean;
  error: string | null;
  sending: boolean;
  sendMessage: (content: string) => Promise<void>;
}

export interface UseInvestigationSessionOptions {
  /** The opening question, when this hook mounts on a freshly created
   *  investigation. Shown as the first user bubble immediately. When
   *  omitted (reopening from the recall panel), the hook fetches the
   *  seed from the cell to recover it. */
  openingPrompt?: string;
}

function userEntry(content: string): InvestigatorTranscriptEntry {
  return { kind: 'user', id: `user-${crypto.randomUUID()}`, content };
}

export function useInvestigationSession(
  id: string | null,
  opts: UseInvestigationSessionOptions = {},
): InvestigationSession {
  const { openingPrompt } = opts;
  const [entries, setEntries] = useState<InvestigatorTranscriptEntry[]>([]);
  const [status, setStatus] = useState<InvestigationStatus | null>(null);
  const [mode, setMode] = useState<InvestigationMode | null>(
    openingPrompt ? 'interactive' : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const seqRef = useRef(0);
  const unsubRef = useRef<(() => void) | null>(null);
  // Contents of optimistically-appended user turns awaiting their echo
  // from the cell's userMessage frames. Lets us skip the streamed copy
  // of a message we already rendered locally (live send), while still
  // appending user turns we've never seen (replay of a saved session).
  const pendingUserRef = useRef<string[]>([]);
  // Guards a stale async setup (id changed / unmounted) from wiring a
  // subscription for the previous investigation.
  const genRef = useRef(0);

  const subscribe = useCallback(
    (investigationId: string, fromSeq: number) => {
      unsubRef.current?.();
      unsubRef.current = subscribeInvestigation(investigationId, fromSeq, {
        stopOnIdle: true,
        onEvent: (ev, seq) => {
          seqRef.current = Math.max(seqRef.current, seq);
          setEntries((prev) => applyLoopEvent(prev, ev));
        },
        onUserMessage: (content, seq) => {
          seqRef.current = Math.max(seqRef.current, seq);
          // Dedup the echo of a message we already appended optimistically.
          if (pendingUserRef.current[0] === content) {
            pendingUserRef.current.shift();
            return;
          }
          setEntries((prev) => [...prev, userEntry(content)]);
        },
        onStatus: (s) => setStatus(s),
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      });
    },
    [],
  );

  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    unsubRef.current?.();
    unsubRef.current = null;
    seqRef.current = 0;
    pendingUserRef.current = [];
    setError(null);
    setStatus(null);

    if (!id) {
      setEntries([]);
      return;
    }

    // Seed the opening user bubble, then start streaming. If we were
    // handed the prompt (fresh create), use it immediately; otherwise
    // recover it from the cell's stored seed (reopen from the panel).
    if (openingPrompt) {
      setEntries([userEntry(openingPrompt)]);
      setMode('interactive');
      subscribe(id, 0);
    } else {
      setEntries([]);
      setMode(null);
      fetchInvestigationStatus(id)
        .then((s) => {
          if (genRef.current !== gen) return;
          const q = s.seed?.question;
          if (q) setEntries([userEntry(q)]);
          setStatus(s.status);
          setMode(s.mode ?? 'autonomous');
          subscribe(id, 0);
        })
        .catch(() => {
          if (genRef.current !== gen) return;
          // Status fetch failed — still try to stream the transcript.
          subscribe(id, 0);
        });
    }

    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
    // subscribe is stable; re-run only when the target investigation or
    // the provided opening prompt changes.
  }, [id, openingPrompt, subscribe]);

  const sendMessage = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!id || !text || sending) return;
      setSending(true);
      setError(null);
      // Optimistic: show the user's turn before the round-trip, and record
      // it so we skip the cell's echoed userMessage frame for it.
      setEntries((prev) => [...prev, userEntry(text)]);
      pendingUserRef.current.push(text);
      try {
        await sendInvestigationMessage(id, text);
        // The prior subscription stopped at idle; resume from where we
        // left off so the new assistant turn streams in.
        setStatus('running');
        subscribe(id, seqRef.current);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    },
    [id, sending, subscribe],
  );

  return {
    entries,
    status,
    mode,
    running: status === 'queued' || status === 'running',
    idle: status === 'idle',
    // A follow-up can be sent to any investigation that isn't actively
    // working — including a concluded/failed one, which the cell reopens
    // (a message resumes the loop). Hidden only while queued/running.
    canSend: status != null && status !== 'queued' && status !== 'running',
    error,
    sending,
    sendMessage,
  };
}
