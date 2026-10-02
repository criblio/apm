/**
 * Alert episodes for the Alerts page: one firing → resolved pair per alert.
 *
 * Pairing is on `alert_id`, the identity the evaluator's state machine is
 * keyed on, NOT on `svc` + `signal_type`. The health arm's alert id
 * (`auto:health:<svc>`) is deliberately stable across signals, and its
 * resolved event's `signal_type` comes from the current, now-good
 * evaluation — `"none"` — so a signal-keyed pairing never closed a health
 * episode. The per-operation latency arm (`auto:latency:<svc>:<op>`) has
 * the opposite problem: every op of a service, and the service-level
 * latency signal, share `svc` + `"latency"` and collapsed into one key.
 *
 * Per alert id the state machine emits strictly alternating firing /
 * resolved transitions (resolving → firing relapses emit nothing), so the
 * first firing opens an episode and the next resolved closes it. The
 * episode's signal type is the firing event's — the signal that caused it.
 *
 * Legacy rows without an `alert_id` fall back to the old svc + signal_type
 * key. Every stored row the current producers wrote carries alert_id.
 */

export interface AlertEvent {
  time: number;
  eventType: string;
  alertId: string;
  service: string;
  signalType: string;
  errorRate: number;
  prevErrorRate: number;
}

export function mapHistoryRow(r: Record<string, unknown>): AlertEvent {
  return {
    time: Number(r._time) * 1000,
    eventType: String(r.event_type ?? ''),
    alertId: String(r.alert_id ?? ''),
    service: String(r.svc ?? ''),
    signalType: String(r.signal_type ?? ''),
    errorRate: Number(r.curr_error_rate ?? 0),
    prevErrorRate: Number(r.prev_error_rate ?? 0),
  };
}

export interface AlertEpisode {
  service: string;
  signalType: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  errorRate: number;
}

function episodeKey(ev: AlertEvent): string {
  return ev.alertId ? `id:${ev.alertId}` : `legacy:${ev.service}:${ev.signalType}`;
}

export function buildEpisodes(events: AlertEvent[]): AlertEpisode[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const openByKey = new Map<string, Omit<AlertEpisode, 'endTime' | 'duration'>>();
  const episodes: AlertEpisode[] = [];

  for (const ev of sorted) {
    const key = episodeKey(ev);
    if (ev.eventType === 'firing') {
      if (!openByKey.has(key)) {
        openByKey.set(key, {
          service: ev.service,
          signalType: ev.signalType,
          startTime: ev.time,
          errorRate: ev.errorRate,
        });
      }
    } else if (ev.eventType === 'resolved') {
      const open = openByKey.get(key);
      if (open) {
        episodes.push({ ...open, endTime: ev.time, duration: ev.time - open.startTime });
        openByKey.delete(key);
      }
    }
  }

  // Still-open episodes
  for (const open of openByKey.values()) {
    episodes.push({ ...open, endTime: null, duration: null });
  }

  return episodes.sort((a, b) => b.startTime - a.startTime);
}
