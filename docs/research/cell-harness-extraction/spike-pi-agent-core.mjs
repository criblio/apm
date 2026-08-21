/**
 * Spike: can pi-agent-core drive the cell's alarm-per-turn model?
 *
 * Simulates two DO alarm invocations:
 *   Alarm 1: fresh Agent, prompt() with shouldStopAfterTurn => true.
 *            The scripted LLM calls a tool; the loop must stop after
 *            the turn (assistant msg + tool result) WITHOUT a second
 *            LLM call. Serialize state.messages to JSON ("DO storage").
 *   Alarm 2: brand-new Agent instance rehydrated from the JSON,
 *            continue(). The scripted LLM now answers with text; loop
 *            ends normally.
 *
 * Pass criteria printed at the end.
 */
import { Agent } from './node_modules/@earendil-works/pi-agent-core/dist/index.js';

let llmCalls = 0;
const scriptedStream = (model, context /*, options */) => {
  llmCalls++;
  const call = llmCalls;
  const listeners = [];
  const result = (async () => {
    const msg =
      call === 1
        ? {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me look at that file.' },
              { type: 'toolCall', id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
            ],
            stopReason: 'toolUse',
            usage: { input: 1, output: 1 },
            provider: 'spike', model: 'spike', api: 'spike',
          }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: 'Root cause: off-by-one in a.ts.' }],
            stopReason: 'stop',
            usage: { input: 1, output: 1 },
            provider: 'spike', model: 'spike', api: 'spike',
          };
    for (const fn of listeners) {
      fn({ type: 'start', partial: { ...msg, content: [] } });
      fn({ type: 'done', message: msg, reason: msg.stopReason });
    }
    return msg;
  })();
  return {
    // pi-ai AssistantMessageEventStream surface used by the loop
    on: (fn) => listeners.push(fn),
    result: () => result,
    abort: () => {},
    [Symbol.asyncIterator]: async function* () {
      const msg = await result;
      yield { type: 'done', message: msg, reason: msg.stopReason };
    },
  };
};

const readTool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  execute: async (toolCallId, args) => ({
    content: [{ type: 'text', text: `contents of ${args.path}: const i = rows.length` }],
  }),
};

const model = {
  provider: 'spike', id: 'spike', name: 'spike', api: 'spike',
  baseUrl: 'http://invalid', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000, maxTokens: 4096,
};

function makeAgent(messages) {
  return new Agent({
    initialState: {
      systemPrompt: 'You are an investigator.',
      model,
      tools: [readTool],
      ...(messages ? { messages } : {}),
    },
    streamFn: scriptedStream,
    shouldStopAfterTurn: async () => true, // one turn per alarm
  });
}

// ── Alarm 1 ──
const a1 = new Promise((resolve) => {
  const agent = makeAgent();
  agent.subscribe(async (ev) => {
    if (ev.type === 'agent_end') resolve(agent.state.messages);
  });
  agent.prompt('Investigate the checkout failure.');
});
const messagesAfterTurn1 = await a1;
const llmCallsAfterTurn1 = llmCalls;

// "DO storage" round-trip
const persisted = JSON.stringify(messagesAfterTurn1);
const rehydrated = JSON.parse(persisted);

// ── Alarm 2 ──
const a2 = new Promise((resolve) => {
  const agent2 = makeAgent(rehydrated);
  agent2.subscribe(async (ev) => {
    if (ev.type === 'agent_end') resolve(agent2.state.messages);
  });
  agent2.continue();
});
const finalMessages = await a2;

// ── Verdict ──
const roles = (msgs) => msgs.map((m) => m.role).join(',');
const lastFinal = finalMessages[finalMessages.length - 1];
const checks = [
  ['turn 1 stopped after exactly 1 LLM call', llmCallsAfterTurn1 === 1],
  ['turn 1 ended on toolResult (continue()-compatible)',
    messagesAfterTurn1[messagesAfterTurn1.length - 1]?.role === 'toolResult'],
  ['messages JSON round-trip preserved shape',
    persisted === JSON.stringify(rehydrated)],
  ['continue() on rehydrated agent ran turn 2 (2nd LLM call)', llmCalls === 2],
  ['final answer present',
    lastFinal?.role === 'assistant' &&
    JSON.stringify(lastFinal.content).includes('Root cause')],
];
console.log('history turn1:', roles(messagesAfterTurn1));
console.log('history final:', roles(finalMessages));
for (const [name, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', '—', name);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
