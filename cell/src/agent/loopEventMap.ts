/**
 * pi-ai stream events → the app's wire LoopEvents.
 *
 * The UI renders anything that speaks the LoopEvent union through
 * its existing `applyLoopEvent` reducer, so this mapping is what
 * makes a server-run investigation render identically to a
 * client-run one. Pure and table-tested.
 *
 * Delta policy: text deltas stream as assistantText chunks (live
 * typing in the UI); thinking deltas are NOT streamed — one
 * notification per completed thinking block keeps transcripts
 * compact. Tool calls are emitted at completion (toolcall_end has
 * the full arguments), not per-delta.
 */
import type { AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';
import type { WireLoopEvent } from '../protocol';

export function mapPiEvent(ev: AssistantMessageEvent, turnId: string): WireLoopEvent[] {
  switch (ev.type) {
    case 'text_delta':
      return ev.delta ? [{ kind: 'assistantText', turnId, chunk: ev.delta }] : [];

    case 'thinking_end':
      return ev.content.trim()
        ? [{ kind: 'notification', turnId, content: `Thinking: ${ev.content.trim()}` }]
        : [];

    case 'toolcall_end':
      return [
        {
          kind: 'toolCall',
          turnId,
          call: {
            id: ev.toolCall.id,
            type: 'function',
            function: {
              name: ev.toolCall.name,
              arguments: JSON.stringify(ev.toolCall.arguments ?? {}),
            },
          },
          needsApproval: false,
        },
      ];

    case 'error': {
      const msg =
        ev.error.errorMessage ??
        (ev.reason === 'aborted' ? 'LLM stream aborted' : 'LLM stream error');
      return [{ kind: 'error', message: msg }];
    }

    // start / text_start / text_end / thinking_start / thinking_delta /
    // toolcall_start / toolcall_delta / done carry no transcript
    // payload of their own (done's terminal handling is the loop's
    // job — it needs the full message, not an event).
    default:
      return [];
  }
}

/** The tool calls of a finished assistant message, in content order. */
export function toolCallsOf(content: ReadonlyArray<{ type: string }>): ToolCall[] {
  return content.filter((c): c is ToolCall => c.type === 'toolCall');
}
