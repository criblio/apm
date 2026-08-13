#!/usr/bin/env node
/**
 * End-to-end smoke for the investigator cell against a running celld
 * node. Exercises: bearer auth, fire → dedupe → queue → alarm-driven
 * stub turns → transcript, the poll transport, the WS ticket + replay
 * transport, and the kill-switch 202.
 *
 * Prereqs (see cell/README.md): MinIO (or any S3) + celld running
 * with the cell deployed and vars set. Env:
 *   CELL_URL        default http://127.0.0.1:8787
 *   WEBHOOK_BEARER  must match the cell's var
 *   UI_BEARER       must match the cell's var
 */
const CELL = process.env.CELL_URL ?? 'http://127.0.0.1:8787';
const WEBHOOK_BEARER = process.env.WEBHOOK_BEARER ?? 'dev-webhook-bearer';
const UI_BEARER = process.env.UI_BEARER ?? 'dev-ui-bearer';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const eventId = `smoke:${Date.now()}`;
const firing = [
  {
    event_id: eventId,
    alert_id: 'auto:health:payment',
    svc: 'payment',
    signal_type: 'error_rate',
    curr_error_rate: 0.042,
    fire_count: 1,
    _time: Math.floor(Date.now() / 1000),
  },
];

console.log(`Smoke against ${CELL}`);

// 1. Health.
{
  const { status, json } = await api('/healthz', { bearer: null });
  check('healthz responds', status === 200 && json?.ok === true);
}

// 2. Auth is closed by default.
{
  const noAuth = await api('/alerts/fire', { method: 'POST', bearer: null, body: firing });
  check('fire without bearer is 401', noAuth.status === 401);
  const badAuth = await api('/investigations', { bearer: 'wrong' });
  check('list with wrong bearer is 401', badAuth.status === 401);
}

// 3. Fire → accepted.
{
  const { status, json } = await api('/alerts/fire', {
    method: 'POST',
    bearer: WEBHOOK_BEARER,
    body: firing,
  });
  check('fire accepted (202, accepted=1)', status === 202 && json?.accepted === 1, JSON.stringify(json));
}

// 4. Duplicate fire (same event_id, webhook-retry shape) → deduped.
{
  const { status, json } = await api('/alerts/fire', {
    method: 'POST',
    bearer: WEBHOOK_BEARER,
    body: { items: firing }, // alternate envelope on purpose
  });
  check('duplicate fire deduped (accepted=0)', status === 202 && json?.accepted === 0, JSON.stringify(json));
}

// 5. Index lists the investigation.
let invId = null;
{
  const { status, json } = await api('/investigations');
  const inv = json?.investigations?.find((i) => i.alertId === 'auto:health:payment');
  invId = inv?.id ?? null;
  check('index lists the investigation', status === 200 && !!invId, JSON.stringify(json));
}

// 6. Poll transport: wait for the stub run to conclude.
let sawToolCall = false;
let sawSummary = false;
{
  let status = null;
  let latestSeq = 0;
  for (let i = 0; i < 30 && status !== 'concluded'; i++) {
    await sleep(1000);
    const r = await api(`/investigations/${invId}/events?since=0`);
    status = r.json?.status ?? null;
    latestSeq = r.json?.latestSeq ?? 0;
    for (const f of r.json?.frames ?? []) {
      if (f.ev?.kind === 'toolCall') sawToolCall = true;
      if (f.ev?.kind === 'toolResult' && f.ev?.result?.name === 'present_investigation_summary') {
        sawSummary = true;
      }
    }
  }
  check('stub run concluded via poll', status === 'concluded', `status=${status}`);
  check('transcript has a toolCall', sawToolCall);
  check('transcript has the summary toolResult', sawSummary);
  check('latestSeq advanced', latestSeq >= 5, `latestSeq=${latestSeq}`);
}

// 7. Status endpoint carries the conclusion.
{
  const { json } = await api(`/investigations/${invId}/status`);
  check(
    'status carries conclusion after conclude',
    json?.status === 'concluded' && json?.conclusion != null,
    JSON.stringify(json),
  );
}

// 8. WS transport: ticket + replay from mid-stream.
{
  const t = await api(`/ws-ticket?investigation=${invId}`);
  check('ws-ticket minted', !!t.json?.ticket);

  const badWs = await new Promise((resolve) => {
    const ws = new WebSocket(
      `${CELL.replace(/^http/, 'ws')}/investigations/${invId}/ws?since=0&ticket=bogus`,
    );
    ws.onopen = () => resolve('open');
    ws.onerror = () => resolve('error');
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('ws with bogus ticket rejected', badWs !== 'open', `got ${badWs}`);

  const frames = await new Promise((resolve) => {
    const got = [];
    const ws = new WebSocket(
      `${CELL.replace(/^http/, 'ws')}/investigations/${invId}/ws?since=2&ticket=${t.json.ticket}`,
    );
    ws.onmessage = (m) => got.push(JSON.parse(m.data));
    ws.onerror = () => resolve(got);
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(got);
    }, 2500);
  });
  const hello = frames.find((f) => f.type === 'hello');
  const eventFrames = frames.filter((f) => f.type === 'event');
  check('ws hello received', !!hello && hello.protocolVersion === 1, JSON.stringify(hello));
  check(
    'ws replay respects since=2 (no seq ≤ 2, includes later seqs)',
    eventFrames.length > 0 && eventFrames.every((f) => f.seq > 2),
    JSON.stringify(eventFrames.map((f) => f.seq)),
  );
}

// 9. Kill switch: DISABLED=true is deploy-config, so just verify the
//    healthz surface reports it (full drill is a hardening-phase test).
{
  const { json } = await api('/healthz', { bearer: null });
  check('kill switch surface present on healthz', typeof json?.disabled === 'boolean');
}

// 10. Interactive investigations: create → run to idle → follow-up
//     message → resume → idle again, plus the recall-panel search.
const marker = `smokemark${Date.now()}`;
let interactiveId = null;
{
  const create = await api('/investigations', {
    method: 'POST',
    bearer: UI_BEARER,
    body: { prompt: `${marker}: why is payment slow right now?` },
  });
  interactiveId = create.json?.id ?? null;
  check(
    'interactive create returns an id',
    (create.status === 202 || create.status === 200) && !!interactiveId,
    JSON.stringify(create.json),
  );
  const noAuth = await api('/investigations', { method: 'POST', bearer: 'wrong', body: { prompt: 'x' } });
  check('interactive create without bearer is 401', noAuth.status === 401);
}

// Wait for the first turn to park at 'idle' (interactive never
// auto-concludes; the stub answers one turn then parks).
async function waitForStatus(id, target, tries = 30) {
  let status = null;
  let latestSeq = 0;
  let sawText = false;
  for (let i = 0; i < tries && status !== target; i++) {
    await sleep(1000);
    const r = await api(`/investigations/${id}/events?since=0`);
    status = r.json?.status ?? null;
    latestSeq = r.json?.latestSeq ?? 0;
    for (const f of r.json?.frames ?? []) {
      if (f.ev?.kind === 'assistantText') sawText = true;
    }
  }
  return { status, latestSeq, sawText };
}
{
  const r = await waitForStatus(interactiveId, 'idle');
  check('interactive run parks at idle (not concluded)', r.status === 'idle', `status=${r.status}`);
  check('interactive transcript has assistant text', r.sawText);
}

// Status reports mode=interactive so the UI shows the input box.
{
  const { json } = await api(`/investigations/${interactiveId}/status`);
  check('status reports mode=interactive', json?.mode === 'interactive', JSON.stringify(json));
}

// Follow-up message resumes the loop, which parks at idle again.
{
  const seqBefore = (await api(`/investigations/${interactiveId}/status`)).json?.latestSeq ?? 0;
  const send = await api(`/investigations/${interactiveId}/messages`, {
    method: 'POST',
    bearer: UI_BEARER,
    body: { content: 'and what about the checkout service?' },
  });
  check('follow-up message accepted', send.status === 200, JSON.stringify(send.json));
  const r = await waitForStatus(interactiveId, 'idle');
  check('interactive resumes then parks at idle again', r.status === 'idle', `status=${r.status}`);
  check('follow-up produced new transcript events', r.latestSeq > seqBefore, `before=${seqBefore} after=${r.latestSeq}`);
}

// Recall panel: search by the unique marker in the title, and paginate.
{
  const search = await api(`/investigations?q=${marker}`);
  const hit = search.json?.investigations?.find((i) => i.id === interactiveId);
  check('recall search finds the interactive investigation by title', !!hit, JSON.stringify(search.json?.investigations?.map((i) => i.title)));
  check('recall row carries title + mode', hit?.title?.includes(marker) && hit?.mode === 'interactive');

  const limited = await api('/investigations?limit=1');
  check('recall respects limit', (limited.json?.investigations?.length ?? 0) <= 1);
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
