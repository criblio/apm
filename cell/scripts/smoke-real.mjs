#!/usr/bin/env node
/**
 * Real-mode smoke: the cell running the ACTUAL pi-ai loop against
 * the scripted mock backends (scripts/mock-backends.mjs). Verifies:
 * streaming assistant text, a real run_search tool call executed
 * through the shared executors against the (mock) Cribl API, the
 * summary conclusion, and the started/investigated lifecycle
 * commits arriving at Cribl.
 *
 * Env: CELL_URL, WEBHOOK_BEARER, UI_BEARER (as smoke.mjs), plus
 * MOCK_URL (default http://127.0.0.1:9100).
 */
const CELL = process.env.CELL_URL ?? 'http://127.0.0.1:8788';
const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:9100';
const WEBHOOK_BEARER = process.env.WEBHOOK_BEARER ?? 'dev-webhook-bearer';
const UI_BEARER = process.env.UI_BEARER ?? 'dev-ui-bearer';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', bearer = UI_BEARER, body } = {}) {
  const res = await fetch(`${CELL}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

console.log(`Real-mode smoke: cell=${CELL} mocks=${MOCK}`);

const eventId = `real-smoke:${Date.now()}`;
const fire = await api('/alerts/fire', {
  method: 'POST',
  bearer: WEBHOOK_BEARER,
  body: [{
    event_id: eventId,
    alert_id: 'auto:health:payment',
    svc: 'payment',
    signal_type: 'error_rate',
    curr_error_rate: 0.042,
    fire_count: 1,
  }],
});
check('fire accepted', fire.status === 202 && fire.json?.accepted === 1, JSON.stringify(fire.json));

// Find the investigation id.
await sleep(1000);
const list = await api('/investigations');
const inv = list.json?.investigations?.find((i) => i.alertId === 'auto:health:payment');
check('investigation listed', Boolean(inv), JSON.stringify(list.json));

// Poll to conclusion (preflight + 2 LLM turns; generous budget).
let status = null;
let frames = [];
for (let i = 0; i < 60 && status !== 'concluded' && status !== 'failed'; i++) {
  await sleep(1000);
  const r = await api(`/investigations/${inv.id}/events?since=0`);
  status = r.json?.status ?? null;
  frames = r.json?.frames ?? [];
}
check('concluded (not failed)', status === 'concluded', `status=${status}, last frames: ${JSON.stringify(frames.slice(-3))}`);

const kinds = frames.map((f) => f.ev.kind);
const texts = frames.filter((f) => f.ev.kind === 'assistantText').map((f) => f.ev.chunk).join('');
const toolCalls = frames.filter((f) => f.ev.kind === 'toolCall').map((f) => f.ev.call.function.name);
const toolResults = frames.filter((f) => f.ev.kind === 'toolResult').map((f) => f.ev.result.name);
const searchResult = frames.find((f) => f.ev.kind === 'toolResult' && f.ev.result.name === 'run_search');

check('streamed assistant text', texts.includes('payment error spike'), texts.slice(0, 120));
check('real run_search toolCall', toolCalls.includes('run_search'), JSON.stringify(toolCalls));
check('run_search executed (result has rows ui)', Boolean(searchResult?.ev.result.ui), JSON.stringify(searchResult?.ev.result)?.slice(0, 200));
check('summary toolResult present', toolResults.includes('present_investigation_summary'), JSON.stringify(toolResults));
check('done event terminal', kinds[kinds.length - 1] === 'done', JSON.stringify(kinds));

const st = await api(`/investigations/${inv.id}/status`);
check(
  'status conclusion carries mock conclusion',
  JSON.stringify(st.json?.conclusion ?? {}).includes('Mock conclusion'),
  JSON.stringify(st.json?.conclusion)?.slice(0, 200),
);

// Lifecycle commits landed at (mock) Cribl.
const stats = await fetch(`${MOCK}/mock/stats`).then((r) => r.json());
const commitKinds = stats.commits.map((q) => (q.match(/event_type="([a-z_]+)"/) ?? [])[1]);
check('started commit reached Cribl', commitKinds.includes('started'), JSON.stringify(commitKinds));
check('investigated commit reached Cribl', commitKinds.includes('investigated'), JSON.stringify(commitKinds));
check('KV kill-switch flag was consulted', stats.kvReads >= 1, `kvReads=${stats.kvReads}`);
check(
  'search tool query reached Cribl',
  stats.queries.some((q) => q.includes('service_name == "payment"')),
  JSON.stringify(stats.queries.slice(0, 5)),
);

console.log(failures === 0 ? '\nREAL SMOKE PASS' : `\nREAL SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
