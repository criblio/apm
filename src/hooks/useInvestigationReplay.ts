/**
 * Drive a read-only replay of a server-side investigation.
 *
 * Subscribes to the cell (poll transport), feeds each rehydrated
 * LoopEvent through the SAME `applyLoopEvent` reducer the live
 * client Investigator uses, and exposes the resulting transcript
 * entries + status. The InvestigatePage renders these entries with
 * the shared `InvestigatorTranscript` view so a replayed
 * investigation looks identical to a live one.
 *
 * Resume is built in: we always subscribe from the last seq we've
 * applied, so a reconnect (poll error, remount) continues rather
 * than duplicating.
 */
import { useEffect, useRef, useState } from 'react';
import { applyLoopEvent, type InvestigatorTranscriptEntry } from '@cribl/app-utils/investigator';
import {
  subscribeInvestigation,
  type InvestigationStatus,
} from '../api/investigationTransport';

export interface InvestigationReplay {
  entries: InvestigatorTranscriptEntry[];
  status: InvestigationStatus | null;
  running: boolean;
  error: string | null;
}

export function useInvestigationReplay(id: string | null): InvestigationReplay {
  const [entries, setEntries] = useState<InvestigatorTranscriptEntry[]>([]);
  const [status, setStatus] = useState<InvestigationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track the highest applied seq so a resubscribe continues from
  // there without replaying (or double-applying) earlier events.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!id) {
      setEntries([]);
      setStatus(null);
      setError(null);
      seqRef.current = 0;
      return;
    }
    // Fresh investigation id ⇒ fresh transcript.
    setEntries([]);
    setStatus(null);
    setError(null);
    seqRef.current = 0;

    const unsubscribe = subscribeInvestigation(id, 0, {
      onEvent: (ev, seq) => {
        seqRef.current = Math.max(seqRef.current, seq);
        setEntries((prev) => applyLoopEvent(prev, ev));
      },
      onStatus: (s) => setStatus(s),
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    });
    return unsubscribe;
  }, [id]);

  return {
    entries,
    status,
    running: status === 'queued' || status === 'running',
    error,
  };
}
