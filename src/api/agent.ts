/**
 * APM binding for the shared Copilot agent streaming client.
 *
 * The NDJSON protocol client lives in @cribl/app-utils/agent; this
 * wrapper preserves the historical `src/api/agent` import surface
 * and pins the analytics `surface` tag every logAgentEvent() call
 * carries. Import this module (not the framework subpath) from APM
 * code so the configureAgent() side effect below always runs before
 * an investigation starts.
 */
import { configureAgent } from '@cribl/app-utils/agent';

configureAgent({ surface: 'criblApmInvestigation' });

export {
  SessionExpiredError,
  isSessionExpiredError,
  logAgentEvent,
  parseAgentFrame,
  streamAgent,
  type AgentContext,
  type AgentFrame,
  type AgentMessage,
  type AgentRequest,
  type AgentToolCall,
  type AgentToolDefinition,
} from '@cribl/app-utils/agent';
