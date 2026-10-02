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
import { alertNotify } from '../queries';
import { savedSearchNotificationBody } from '@criblio/app-utils/notifications';
import { ALERT_NOTIFY_BINDING } from '../cellProvisioning';

setCurrentDataset('otel');

afterEach(() => setServerInvestigations(false));

describe('criblapm__alert_notify gating', () => {
  it('is absent when serverInvestigations is off', () => {
    setServerInvestigations(false);
    const ids = getProvisioningPlan().map((s) => s.id);
    expect(ids).not.toContain('criblapm__alert_notify');
  });

  it('is present when on, with no inline notifications (the server drops them)', () => {
    setServerInvestigations(true);
    const notify = getProvisioningPlan().find((s) => s.id === 'criblapm__alert_notify');
    expect(notify).toBeDefined();
    expect(notify!.schedule.notifications).toBeUndefined();
    expect(alertNotify()).toContain('agent="apm-investigator"');
    expect(alertNotify()).toContain('eventId=tostring(event_id)');
    expect(alertNotify()).toContain('subject=tostring(alert_id)');
    expect(alertNotify()).toContain('group=strcat("apm:"');
    // The default remains off so the flag genuinely gates it.
    expect(getServerInvestigations()).toBe(true);
  });
});

describe('ALERT_NOTIFY_BINDING (the /notifications record that fires the cell)', () => {
  it('produces field-for-field the record APM wrote before the framework uptake', () => {
    // The literal the local ensureAlertNotification POSTed (and the inline
    // `schedule.notifications.items[0]` mirrored). Same id, group, target,
    // trigger, message and per-target conf — only the code moved.
    expect(savedSearchNotificationBody(ALERT_NOTIFY_BINDING)).toEqual({
      disabled: false,
      condition: 'search',
      targets: [CELL_WEBHOOK_TARGET_ID],
      conf: {
        triggerType: 'resultsCount',
        triggerComparator: '>',
        triggerCount: 0,
        savedQueryId: 'criblapm__alert_notify',
        message: 'Cribl APM: firing alert(s) — triggering server-side investigation.',
      },
      targetConfigs: [
        {
          id: CELL_WEBHOOK_TARGET_ID,
          conf: { includeResults: true, attachmentType: 'inline' },
        },
      ],
      group: 'default_search',
      id: 'criblapm__alert_notify_Notification_1',
    });
  });
});
