/**
 * Every APM flag states its own default. "KV unreachable ⇒ feature
 * dark" holds only for the flags that are off by default; the stream
 * filter and both metrics gates are on by owner decision.
 */
import { describe, expect, it } from 'vitest';
import { getStreamFilterEnabled } from '../streamFilter';
import { getLowVolumeMode } from '../lowVolumeMode';
import { getMetricsRead } from '../metricsRead';
import { getMetricsEmit } from '../metricsEmit';
import { getServerInvestigations } from '../serverInvestigations';

describe('flag defaults', () => {
  it('match the documented defaults', () => {
    expect(getStreamFilterEnabled()).toBe(true);
    expect(getLowVolumeMode()).toBe(false);
    expect(getMetricsRead()).toBe(true);
    expect(getMetricsEmit()).toBe(true);
    expect(getServerInvestigations()).toBe(false);
  });
});
