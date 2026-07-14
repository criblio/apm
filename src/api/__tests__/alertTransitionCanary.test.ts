import { describe, expect, it } from 'vitest';
import {
  alertTransitionCanaryRead,
  alertTransitionCanaryStep,
} from '../alertTransitionCanary';

describe('alert transition canary KQL', () => {
  it('suppresses durable retries before the send boundary', () => {
    const query = alertTransitionCanaryStep('run_1', 'eval_1', true, 'otel');
    expect(query).toContain('persisted_evaluation_id == evaluation_id');
    expect(query).toContain('| where not(is_retry)');
    expect(query).toContain('| send tee=true group="search"');
    expect(query).toContain('is_canary=true');
  });

  it('rejects IDs and datasets that could alter the query', () => {
    expect(() => alertTransitionCanaryStep('x" | send', 'eval', true, 'otel')).toThrow();
    expect(() => alertTransitionCanaryStep('run', 'eval', true, 'otel | send')).toThrow();
    expect(() => alertTransitionCanaryRead('x;', 'otel')).toThrow();
  });
});
