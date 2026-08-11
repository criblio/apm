/**
 * The server-investigations flag must be truly off by default — the
 * design's kill-switch story depends on "KV unreachable ⇒ feature
 * dark". (metricsEmit/metricsRead historically shipped with a
 * default-true discrepancy; this pin prevents a repeat here.)
 */
import { describe, expect, it } from 'vitest';
import {
  getServerInvestigations,
  setServerInvestigations,
  subscribeServerInvestigations,
} from '../serverInvestigations';

describe('serverInvestigations flag', () => {
  it('defaults to off', () => {
    expect(getServerInvestigations()).toBe(false);
  });

  it('notifies subscribers on change and supports unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeServerInvestigations(() => {
      calls++;
    });
    setServerInvestigations(true);
    expect(getServerInvestigations()).toBe(true);
    expect(calls).toBe(1);
    setServerInvestigations(true); // no-op, same value
    expect(calls).toBe(1);
    unsub();
    setServerInvestigations(false);
    expect(calls).toBe(1);
    expect(getServerInvestigations()).toBe(false);
  });
});
