/**
 * Type-level parity between @criblio/agent-protocol's WireLoopEvent
 * and the framework's LoopEvent union (@criblio/app-utils agent-loop) —
 * the assertion the old hand-mirrored protocol.ts asked for. The
 * protocol package deliberately doesn't depend on app-utils, so the
 * pin lives here, where both packages are installed.
 *
 * The wire form differs from LoopEvent by design in exactly two ways:
 *   - `error` carries a plain message string (survives JSON), not an
 *     Error instance;
 *   - `userMessage` exists only on the wire (interactive replay).
 * Everything else must stay structurally interchangeable. If either
 * side adds/renames an event kind or field, this file stops
 * compiling — vitest runs it, and `tsc --noEmit` gates it.
 */
import { describe, expect, it } from 'vitest';
import type { WireLoopEvent } from '@criblio/agent-protocol';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';

type Extends<A, B> = A extends B ? true : false;
type Assert<T extends true> = T;

type WireKind = WireLoopEvent['kind'];
type LoopKind = LoopEvent['kind'];

// Kind parity: wire = loop kinds + 'userMessage', nothing else.
export type _WireCoversLoop = Assert<Extends<LoopKind, WireKind>>;
export type _LoopCoversWire = Assert<Extends<Exclude<WireKind, 'userMessage'>, LoopKind>>;

type WireOf<K extends WireKind> = Extract<WireLoopEvent, { kind: K }>;
type LoopOf<K extends LoopKind> = Extract<LoopEvent, { kind: K }>;

// Structural parity where the shapes must be interchangeable. The
// wire's toolResult widens `ui` to unknown (pass-through) and its
// `done.reason`/`notification.content` widen for forward compat, so
// the assertions run in the direction that matters: a LoopEvent the
// client loop produces must be expressible on the wire.
export type _AssistantText = Assert<Extends<LoopOf<'assistantText'>, WireOf<'assistantText'>>>;
export type _AssistantDone = Assert<Extends<LoopOf<'assistantDone'>, WireOf<'assistantDone'>>>;
export type _ToolResult = Assert<Extends<LoopOf<'toolResult'>, WireOf<'toolResult'>>>;
export type _Done = Assert<Extends<LoopOf<'done'>, WireOf<'done'>>>;
// toolCall: the framework's AgentToolCall lacks the wire's literal
// `type: 'function'` discriminator (the cell stamps it), so assert
// the payload the UI actually consumes — id + function — matches.
export type _ToolCallFn = Assert<
  Extends<LoopOf<'toolCall'>['call']['function'], WireOf<'toolCall'>['call']['function']>
>;

describe('wire protocol ↔ framework LoopEvent parity', () => {
  it('compiles (the assertions above are the test)', () => {
    const kinds: Record<Exclude<WireKind, 'userMessage'>, true> = {
      assistantText: true,
      assistantDone: true,
      toolCall: true,
      toolResult: true,
      notification: true,
      error: true,
      done: true,
    } satisfies Record<LoopKind, true>;
    expect(Object.keys(kinds).length).toBe(7);
  });
});
