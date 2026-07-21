/**
 * APM binding for the shared Copilot Investigator agent loop.
 *
 * The tool-use orchestration lives in @cribl/app-utils/agent-loop;
 * this wrapper preserves the historical `src/api/agentLoop` import
 * surface (runInvestigation with APM's options shape) by pre-wiring
 * the app-specific pieces: APM's tool definitions, the dataset-aware
 * context builder, and the tool executors in agentTools.ts.
 */
// Side effect: pins the analytics surface tag before any loop runs.
import './agent';
import {
  runInvestigation as runSharedInvestigation,
  type RunLoopOptions as SharedRunLoopOptions,
} from '@cribl/app-utils/agent-loop';
import { executeToolCall, requiresApproval } from './agentTools';
import { buildAgentContext } from './agentContext';
import { APM_TOOL_DEFINITIONS } from './agentToolDefs';
import { getCurrentDataset } from '@cribl/app-utils/dataset';

export type { LoopEvent } from '@cribl/app-utils/agent-loop';

/** APM's loop options — the shared options minus the app-specific
 *  fields this wrapper injects. */
export type RunLoopOptions = Omit<
  SharedRunLoopOptions,
  'toolDefinitions' | 'buildContext' | 'executeToolCall' | 'requiresApproval'
>;

/**
 * Run a complete investigation loop against APM's dataset with
 * APM's tool surface. See the shared runInvestigation for the loop
 * semantics (streaming, approvals, turn cap).
 */
export async function runInvestigation(opts: RunLoopOptions): Promise<void> {
  return runSharedInvestigation({
    ...opts,
    toolDefinitions: APM_TOOL_DEFINITIONS,
    buildContext: () => buildAgentContext(getCurrentDataset()),
    executeToolCall,
    requiresApproval,
  });
}
