#!/usr/bin/env node
/**
 * Offline test doubles for the cell's two upstreams on one port:
 *
 *  - OpenAI-compatible chat completions (streaming SSE) with a
 *    scripted two-turn investigation: turn 1 emits text + a
 *    run_search tool call; turn 2 (after it sees a tool result)
 *    emits present_investigation_summary. Exercises the full real
 *    loop — streaming deltas, tool-call assembly, tool execution,
 *    conclusion — with no LLM key.
 *  - Mock Cribl Search API: search jobs (immediately completed),
 *    NDJSON results with the schema line 0, the app-settings KV
 *    read, generic rows for any query.
 *
 * GET /mock/stats reports what arrived (queries seen, commit events)
 * so the smoke can assert the cell actually wrote its lifecycle
 * events. Default port 9100.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 9100);

const stats = {
  chatCalls: 0,
  searchJobs: 0,
  queries: [],
  commits: [],
  kvReads: 0,
};

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** Stream one scripted assistant message based on how far the
 *  conversation has progressed (count of tool-role messages). */
function streamChat(req, res, body) {
  stats.chatCalls++;
  const messages = body.messages ?? [];
  const toolResults = messages.filter((m) => m.role === 'tool').length;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  sse(res, chunk({ role: 'assistant' }));

  if (toolResults === 0) {
    for (const piece of ['Looking into the ', 'payment error spike now.']) {
      sse(res, chunk({ content: piece }));
    }
    const args = JSON.stringify({
      query: 'dataset="otel" | where service_name == "payment" | summarize n=count() by status_code',
      earliest: '-1h',
      latest: 'now',
      limit: 100,
      description: 'Status-code breakdown for payment',
      confirmBeforeRunning: false,
    });
    sse(res, chunk({
      tool_calls: [{ index: 0, id: 'call-mock-1', type: 'function', function: { name: 'run_search', arguments: '' } }],
    }));
    for (let i = 0; i < args.length; i += 40) {
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }));
    }
    sse(res, chunk({}, 'tool_calls'));
  } else {
    const args = JSON.stringify({
      findings: [
        { category: 'Root cause', details: 'payment returns ERROR on 4.2% of spans in the mock window.' },
      ],
      conclusion: 'Mock conclusion: payment error spike confirmed by the scripted scenario.',
    });
    sse(res, chunk({ content: 'I have enough to conclude.' }));
    sse(res, chunk({
      tool_calls: [{ index: 0, id: 'call-mock-2', type: 'function', function: { name: 'present_investigation_summary', arguments: '' } }],
    }));
    for (let i = 0; i < args.length; i += 40) {
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }));
    }
    sse(res, chunk({}, 'tool_calls'));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const NDJSON_SCHEMA_LINE = JSON.stringify({ fields: [], isSchema: true });
const GENERIC_ROWS = [
  { svc: 'payment', service_name: 'payment', status_code: 'ERROR', n: 42, requests: 1000, errors: 42, error_rate: 0.042, p50_us: 12000, p95_us: 88000, p99_us: 130000, _time: Math.floor(Date.now() / 1000) },
  { svc: 'checkout', service_name: 'checkout', status_code: '2', n: 958, requests: 2000, errors: 4, error_rate: 0.002, p50_us: 9000, p95_us: 41000, p99_us: 70000, _time: Math.floor(Date.now() / 1000) },
];

function handleCribl(req, res, url, body) {
  if (url.pathname === '/api/v1/kvstore/settings/app') {
    stats.kvReads++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ serverInvestigations: true, dataset: 'otel' }));
    return true;
  }
  if (url.pathname === '/api/v1/m/default_search/search/jobs' && req.method === 'POST') {
    stats.searchJobs++;
    const query = String(body?.query ?? '');
    stats.queries.push(query.slice(0, 200));
    if (query.includes('record_kind="investigation"') && query.startsWith('print')) {
      stats.commits.push(query);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: `job-${stats.searchJobs}`, status: 'completed' }] }));
    return true;
  }
  const jobMatch = url.pathname.match(/^\/api\/v1\/m\/default_search\/search\/jobs\/(job-\d+)(\/results)?$/);
  if (jobMatch && req.method === 'GET') {
    if (jobMatch[2]) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const lines = [NDJSON_SCHEMA_LINE, ...GENERIC_ROWS.map((r) => JSON.stringify(r))];
      res.end(lines.join('\n') + '\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: jobMatch[1], status: 'completed' }] }));
    }
    return true;
  }
  return false;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    } catch {
      /* non-JSON body */
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return streamChat(req, res, body ?? {});
    }
    if (url.pathname === '/mock/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    if (handleCribl(req, res, url, body)) return;

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `mock: no route for ${req.method} ${url.pathname}` }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-backends listening on http://127.0.0.1:${PORT}`);
});
