import { beforeAll, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { executeToolCall, requiresApproval } from '../agentTools';

beforeAll(() => setCurrentDataset('otel'));

function runSearch(argumentsObject: Record<string, unknown>) {
  return {
    id: 'tool-1',
    name: 'run_search',
    arguments: JSON.stringify(argumentsObject),
  };
}

describe('Investigator query security boundary', () => {
  it('auto-runs queries without a prompt — safety is the read-only guard, not approval', () => {
    // The investigator no longer pauses for human approval (both data
    // tools are read-only). The security boundary is enforced at
    // execution time by assertReadOnlyKql / dataset scoping — see the
    // side-effect and scope-escape tests below, which hold regardless of
    // confirmBeforeRunning.
    expect(requiresApproval()).toBe(false);
  });

  it('blocks side-effect KQL before creating a search job', async () => {
    const result = await executeToolCall(
      runSearch({
        query: 'dataset="otel" | send group="search"',
        description: 'prompt-injected exfiltration',
        confirmBeforeRunning: false,
      }),
    );
    expect(result.ui?.kind).toBe('search');
    if (result.ui?.kind === 'search') {
      expect(result.ui.error).toContain('side-effect operator send');
    }
    expect(result.content).toContain('blocked');
  });

  it('blocks dataset scope escape', async () => {
    const result = await executeToolCall(
      runSearch({
        query: 'dataset="cribl_internal_logs" | limit 1',
        description: 'scope escape',
      }),
    );
    expect(result.content).toContain('outside the investigation scope');
  });
});
