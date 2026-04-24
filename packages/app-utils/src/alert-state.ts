export interface DetectedIssue {
  service: string;
  signalType: string;
  severity: string;
  detail: string;
  operation?: string;
  rootCauseHint?: string;
  alertStatus?: string;
  isPersistent?: boolean;
}

export type AlertStatus = 'ok' | 'pending' | 'firing' | 'resolving';

export interface AlertState {
  id: string;
  status: AlertStatus;
  consecutiveBad: number;
  consecutiveGood: number;
  firstFiredAt?: string;
  lastFiredAt?: string;
  lastNotifiedAt?: string;
  lastResolvedAt?: string;
  lastEvaluatedAt: string;
  lastDetail?: string;
  fireCount: number;
}

export interface DebounceConfig {
  fireAfter: number;
  clearAfter: number;
}

export const DEFAULT_DEBOUNCE: DebounceConfig = {
  fireAfter: 2,
  clearAfter: 3,
};

export interface Transition {
  prev: AlertStatus;
  next: AlertStatus;
  shouldNotify: 'firing' | 'resolved' | null;
}

export function alertIdFromIssue(issue: DetectedIssue): string {
  if (issue.signalType === 'latency_anomaly' && issue.operation) {
    return `auto:latency:${issue.service}:${issue.operation}`;
  }
  const typeMap: Record<DetectedIssue['signalType'], string> = {
    error_rate_critical: 'error_rate',
    error_rate_warn: 'error_rate',
    traffic_drop: 'traffic_drop',
    latency_anomaly: 'latency',
    silent: 'silent',
  };
  return `auto:${typeMap[issue.signalType]}:${issue.service}`;
}

export function evaluateTransition(
  state: AlertState,
  isBad: boolean,
  debounce: DebounceConfig = DEFAULT_DEBOUNCE,
): Transition {
  const now = new Date().toISOString();
  const prev = state.status;

  if (isBad) {
    state.consecutiveGood = 0;
    state.consecutiveBad++;
    state.lastEvaluatedAt = now;

    switch (prev) {
      case 'ok':
        state.status = 'pending';
        return { prev, next: 'pending', shouldNotify: null };

      case 'pending':
        if (state.consecutiveBad >= debounce.fireAfter) {
          state.status = 'firing';
          state.firstFiredAt = state.firstFiredAt ?? now;
          state.lastFiredAt = now;
          state.lastNotifiedAt = now;
          state.fireCount++;
          return { prev, next: 'firing', shouldNotify: 'firing' };
        }
        return { prev, next: 'pending', shouldNotify: null };

      case 'firing':
        state.lastFiredAt = now;
        return { prev, next: 'firing', shouldNotify: null };

      case 'resolving':
        state.status = 'firing';
        state.consecutiveGood = 0;
        state.lastFiredAt = now;
        return { prev: 'resolving', next: 'firing', shouldNotify: null };
    }
  } else {
    state.consecutiveBad = 0;
    state.consecutiveGood++;
    state.lastEvaluatedAt = now;

    switch (prev) {
      case 'ok':
        return { prev, next: 'ok', shouldNotify: null };

      case 'pending':
        state.status = 'ok';
        state.consecutiveGood = 0;
        state.consecutiveBad = 0;
        return { prev, next: 'ok', shouldNotify: null };

      case 'firing':
        state.status = 'resolving';
        return { prev, next: 'resolving', shouldNotify: null };

      case 'resolving':
        if (state.consecutiveGood >= debounce.clearAfter) {
          state.status = 'ok';
          state.lastResolvedAt = now;
          state.consecutiveGood = 0;
          state.consecutiveBad = 0;
          const result: Transition = { prev, next: 'ok', shouldNotify: 'resolved' };
          state.firstFiredAt = undefined;
          return result;
        }
        return { prev, next: 'resolving', shouldNotify: null };
    }
  }
}

export function newAlertState(id: string): AlertState {
  return {
    id,
    status: 'ok',
    consecutiveBad: 0,
    consecutiveGood: 0,
    lastEvaluatedAt: new Date().toISOString(),
    fireCount: 0,
  };
}

export function alertLabel(id: string): string {
  const parts = id.split(':');
  if (parts[0] === 'auto' && parts.length >= 3) {
    const type = parts[1];
    const service = parts[2];
    const op = parts[3];
    const typeLabels: Record<string, string> = {
      error_rate: 'Error Rate',
      traffic_drop: 'Traffic Drop',
      latency: 'Latency Anomaly',
      silent: 'Service Silent',
    };
    const label = typeLabels[type] ?? type;
    return op ? `${service} — ${label} (${op})` : `${service} — ${label}`;
  }
  return id;
}
