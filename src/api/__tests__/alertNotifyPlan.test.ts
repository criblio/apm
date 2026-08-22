/**
 * The alert-notify trigger search is the server-investigations
 * on/off at provision time: it exists only when the flag is on, and
 * when it does it must fire the investigator-cell webhook target.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  getProvisioningPlan,
  CELL_WEBHOOK_TARGET_ID,
} from '../provisionedSearches';
import {
  getServerInvestigations,
  setServerInvestigations,
} from '../serverInvestigations';

setCurrentDataset('otel');

afterEach(() => setServerInvestigations(false));

describe('criblapm__alert_notify gating', () => {
  it('is absent when serverInvestigations is off', () => {
    setServerInvestigations(false);
    const ids = getProvisioningPlan().map((s) => s.id);
    expect(ids).not.toContain('criblapm__alert_notify');
  });

  it('is present and fires the cell webhook when on', () => {
    setServerInvestigations(true);
    const notify = getProvisioningPlan().find((s) => s.id === 'criblapm__alert_notify');
    expect(notify).toBeDefined();
    const n = notify!.schedule.notifications as {
      items: Array<{ targets: string[]; conf: { triggerType: string; triggerCount: number }; targetConfigs: Array<{ conf: { includeResults: boolean } }> }>;
    };
    expect(n.items[0].targets).toEqual([CELL_WEBHOOK_TARGET_ID]);
    expect(n.items[0].conf.triggerType).toBe('resultsCount');
    expect(n.items[0].conf.triggerCount).toBe(0);
    expect(n.items[0].targetConfigs[0].conf.includeResults).toBe(true);
    // The default remains off so the flag genuinely gates it.
    expect(getServerInvestigations()).toBe(true);
  });
});
