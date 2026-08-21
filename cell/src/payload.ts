/**
 * The seam between the generic cell harness and the domain payload
 * it runs.
 *
 * Harness = everything in this directory that knows nothing about
 * APM: the router + auth (index.ts), the coordinator (dedupe, queue,
 * concurrency, index), the session DO (alarm-per-turn loop,
 * transcript store, WS/poll replay), the pi turn runner, and the
 * workspace/code tools. Payload = what the app plugs in: trigger
 * parsing, seeding, domain tools, lifecycle recording (today: the
 * APM investigator in ./payloads/apm.ts, wired via
 * ./payload.instance.ts).
 *
 * This is the server-side mirror of the framework's RunLoopOptions —
 * the client agent loop already injects tool definitions, executors,
 * and a context builder; the cell injects the same plus the
 * server-only concerns (triggers, seeds, lifecycle).
 *
 * Extraction target (docs/research/cell-harness-extraction/design.md):
 * this interface and the harness modules that consume it move to
 * @criblio/cell-harness; a payload implementation stays with its app.
 * Step 1 (this PR) carves the seam in place — the wire protocol, the
 * DO SQL schemas, and live behavior are unchanged; the DOs just reach
 * APM behavior through `payload` instead of importing it directly.
 */
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type {
  ToolCallInvocation,
  ToolExecutionResult,
} from '@cribl/app-utils/agent-tools';
import type { Env } from './env';
import type { WireLoopEvent } from './protocol';

/** The executor surface the turn runner calls. Structurally identical
 *  to the app's ApmToolExecutors — the framework types are the shared
 *  contract. Executors report tool failures as explanatory `content`
 *  the model can react to, never as thrown errors. */
export interface ToolExecutors {
  executeToolCall(
    call: ToolCallInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

/** Identity facts the coordinator persists for an admitted trigger.
 *  Column mapping (unchanged since the scaffold): dedupeKey →
 *  event_id (UNIQUE), subjectId → alert_id, groupKey → incident_key. */
export interface TriggerFacts {
  /** Stable id webhook retries / overlapping poll windows collapse on. */
  dedupeKey: string;
  /** What the session is about (APM: the alert id). */
  subjectId: string;
  /** Groups sessions about the same ongoing problem (APM: incidentKey). */
  groupKey: string;
}

/** A built seed: the opening user message plus the small metadata
 *  blob the UI shows when replaying a session. */
export interface SeedResult {
  /** history[0] — the full seed prompt (can be ~75 KB; the DO stores
   *  it as a KV entry, never in a scanned SQLite table). */
  prompt: string;
  /** Persisted to seed_json and served on /status and the WS hello. */
  seed: unknown;
}

/** The user-supplied opening of an interactive session. */
export interface InteractiveInput {
  prompt: string;
  context?: { service?: string; earliest?: string; latest?: string } | null;
}

/** A durable lifecycle record request (APM: the dataset commit that
 *  powers the Alerts page badges). */
export interface LifecycleEvent<TTrigger> {
  type: 'started' | 'concluded' | 'failed';
  sessionId: string;
  subjectId: string;
  triggerDedupeKey: string;
  /** Null for interactive sessions (no trigger fired them). */
  trigger: TTrigger | null;
  /** ≤1KB conclusion text, present on 'concluded'. */
  conclusionText?: string;
}

/** One canned turn from a payload's stub agent (configless smoke). */
export interface StubTurn {
  events: WireLoopEvent[];
  done: boolean;
  /** The conclusion payload when this turn concluded the session. */
  conclusion?: unknown;
}

export interface CellPayload<TTrigger> {
  /** Validate + normalize one raw trigger row (webhook body or poll
   *  result). Null ⇒ the row is silently skipped. */
  parseTrigger(raw: unknown): TTrigger | null;

  /** Identity facts for an admitted trigger (see TriggerFacts). */
  triggerFacts(trigger: TTrigger): TriggerFacts;

  /** Group key for a UI-initiated interactive session. */
  interactiveGroupKey(context: InteractiveInput['context']): string;

  /** Pull-based triggering: fetch the currently-firing trigger rows
   *  (raw — each goes through parseTrigger on admission). Optional;
   *  without it the coordinator's poll alarm only reclaims orphans. */
  pollTriggers?(env: Env): Promise<unknown[]>;

  /** Whether env carries what the payload needs to run real sessions
   *  (APM: Cribl credentials). The harness gates real mode on this
   *  AND its own LLM config; otherwise the stub path runs. */
  ready(env: Env): boolean;

  /** Seed for an autonomous (trigger-fired) session. */
  buildSeed(trigger: TTrigger, env: Env): Promise<SeedResult>;

  /** Seed for an interactive (UI-started) session. */
  buildInteractiveSeed(input: InteractiveInput, env: Env): Promise<SeedResult>;

  /** The domain tools for a turn. Called only when ready(env). The
   *  harness composes its own server-only tools (the workspace code
   *  tools) on top. */
  createTools(env: Env): {
    definitions: AgentToolDefinition[];
    executors: ToolExecutors;
  };

  /** The tool call that concludes a session; its result `ui` becomes
   *  the conclusion. Absent ⇒ a turn with no tool calls concludes. */
  concludingToolName?: string;

  /** Extract a ≤1KB text snippet from a conclusion payload. */
  conclusionSnippet?(conclusion: unknown): string;

  /** The service a trigger implicates — used by the workspace tools
   *  to resolve which repo to check out. */
  targetService?(trigger: TTrigger | null): string | undefined;

  /** Write the durable lifecycle record. May throw — the harness
   *  catches and notes the gap in the transcript (an outage of the
   *  record store must not fail the session). */
  commitLifecycle?(env: Env, event: LifecycleEvent<TTrigger>): Promise<void>;

  /** Canned turns for the configless smoke (no LLM configured). */
  stubTurn?(turnIndex: number, trigger: TTrigger): StubTurn;
}
