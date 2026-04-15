// Spike: run Copilot Investigation with rich pre-filled APM context
// and compare speed/accuracy vs the bare investigation
import { connect } from './browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const BASE = 'https://main-objective-shirley-sho21r7.cribl-staging.cloud';
const OUT = 'docs/research/investigator-spike';
mkdirSync(OUT, { recursive: true });

const apiCalls = [];
let callIndex = 0;

const APM_CONTEXT = `
## Dataset & Schema Context (Cribl APM)

The "otel" dataset contains OpenTelemetry traces, logs, and metrics ingested
from an OTel Collector. **Records are pre-parsed JSON** — ALL fields are
available as structured columns. Do NOT use regex extraction on _raw.

### Span identification
- Spans: \`dataset="otel" | where isnotnull(end_time_unix_nano)\`
- Metrics: \`dataset="otel" | where datatype == "generic_metrics"\`

### Key field mappings (use exactly these patterns)
- Service name: \`tostring(resource.attributes['service.name'])\`
- Duration (microseconds): \`(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0\`
- Error detection: \`tostring(status.code)=="2"\`  (status.code is a STRING "2", not int 2)
- Status message: \`status.message\`
- Span kind: \`kind\` (1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER)
- Operation name: \`name\`
- RPC method: \`tostring(attributes['rpc.method'])\`
- RPC service: \`tostring(attributes['rpc.service'])\`
- gRPC status code: \`tostring(attributes['rpc.grpc.status_code'])\`
- Exception type: look in events array for exception.type
- Parent span: \`parent_span_id\` (empty string = root span)
- Trace ID: \`trace_id\`
- Span ID: \`span_id\`
- K8s pod: \`resource.attributes['k8s.pod.name']\`

### KQL dialect notes (Cribl Search KQL, NOT standard Kusto)
- Use \`summarize\` for aggregation (not \`stats\`)
- Use \`timestats\` for time-bucketed aggregation
- Use \`extend\` for computed columns
- Use \`sort by field desc\` (not \`order by\`)
- \`countif(predicate)\` works inside summarize
- Bracket-quote dotted fields: \`["resource.attributes.service.name"]\`
- Or use the nested accessor: \`resource.attributes['service.name']\`
- String comparisons: \`tostring(x)=="value"\`

### Service topology (from our System Architecture graph)
Services in this environment and their dependencies:
- \`frontend-proxy\` → \`frontend\` (HTTP)
- \`frontend\` → \`checkout\`, \`cart\`, \`product-catalog\`, \`recommendation\`, \`ad\`, \`currency\`, \`shipping\` (gRPC)
- \`checkout\` → \`payment\` (gRPC oteldemo.PaymentService/Charge)
- \`checkout\` → \`cart\`, \`product-catalog\`, \`currency\`, \`shipping\`, \`email\` (gRPC)
- \`payment\` → no downstream service dependencies (leaf node)
- Messaging: \`cart\` → Kafka → \`accounting\`; \`checkout\` → Kafka → \`accounting\`, \`email\`
- \`flagd\` is the feature flag service, called by many services

### Example working queries
Service summary with error rates:
\`\`\`kql
dataset="otel" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
          is_error=(tostring(status.code)=="2")
  | summarize requests=count(),
              errors=countif(is_error),
              p50=percentile(dur_us, 50),
              p95=percentile(dur_us, 95),
              p99=percentile(dur_us, 99)
    by svc
  | extend error_rate=round(100.0*errors/requests, 2)
  | sort by requests desc
\`\`\`

Dependencies (service-to-service call graph):
\`\`\`kql
dataset="otel" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          parent=tostring(parent_span_id),
          is_error=(tostring(status.code)=="2")
  | where parent != "" and isnotempty(parent)
  | project trace_id, parent, svc, is_error
  | join kind=inner (
      dataset="otel" | where isnotnull(end_time_unix_nano)
      | extend psvc=tostring(resource.attributes['service.name']),
              psid=tostring(span_id)
      | project trace_id, psid, psvc
    ) on trace_id, $left.parent == $right.psid
  | where svc != psvc
  | summarize callCount=count(), errorCount=countif(is_error) by parent=psvc, child=svc
  | sort by callCount desc
\`\`\`
`.trim();

async function main() {
  const { browser, context, close } = await connect();
  const page = await context.newPage();

  // Capture AI API traffic
  page.on('request', req => {
    const url = req.url();
    if (!url.includes(BASE)) return;
    const path = url.replace(BASE, '');
    if (!path.includes('/api/v1/ai/') && !path.includes('/search/jobs')) return;
    apiCalls.push({
      idx: callIndex++, ts: new Date().toISOString(),
      method: req.method(), url: path,
      postData: req.postData() || null,
    });
    console.log(`>> [${callIndex-1}] ${req.method()} ${path.substring(0, 100)}`);
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (!url.includes(BASE)) return;
    const path = url.replace(BASE, '');
    if (!path.includes('/api/v1/ai/') && !path.includes('/search/jobs')) return;
    const existing = apiCalls.findLast(c => c.url === path && !c.response);
    if (!existing) return;
    try {
      const body = await resp.text();
      existing.response = { status: resp.status(), bodyLength: body.length, body: body.substring(0, 100000) };
      console.log(`<< [${existing.idx}] ${resp.status()} (${body.length} bytes)`);
    } catch (e) {
      existing.response = { status: resp.status(), error: 'streaming' };
      console.log(`<< [${existing.idx}] streaming`);
    }
  });

  // Navigate to the investigator (fresh session)
  console.log('=== Navigating to /search/agent ===');
  await page.goto(`${BASE}/search/agent`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Reset tracking
  apiCalls.length = 0;
  callIndex = 0;

  // Build the prompt with rich context
  const prompt = `${APM_CONTEXT}

## Current Investigation

The payment service's gRPC Charge operation (called by checkout) is experiencing a high error rate in the last 15 minutes. Investigate the root cause. Use the field mappings and query patterns above — do NOT use regex extraction.`;

  console.log('=== Submitting prompt with APM context ===');
  console.log(`Prompt length: ${prompt.length} chars`);
  const textarea = page.locator('textarea[placeholder="Help me with..."]').first();
  await textarea.click();
  await textarea.fill(prompt);
  await page.screenshot({ path: `${OUT}/ctx-01-prompt.png` });
  await textarea.press('Enter');

  // Follow the investigation
  const startTime = Date.now();
  let screenshotNum = 2;
  let lastLen = 0;
  let lastAutoClick = 0;

  while (Date.now() - startTime < 600000) {
    await page.waitForTimeout(3000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const txt = await page.evaluate(() => {
      const main = document.querySelector('[class*="CriblCopilot"]') || document.body;
      return main.innerText;
    });

    // Auto-click "Run Query" if it appears
    if (Date.now() - lastAutoClick > 3000) {
      const rq = page.locator('button:has-text("Run Query")');
      if (await rq.count() > 0 && await rq.isEnabled()) {
        console.log(`\n=== Auto-clicking Run Query at ${elapsed}s ===`);
        await rq.click();
        lastAutoClick = Date.now();
        await page.waitForTimeout(500);
      }
    }

    if (txt.length !== lastLen) {
      lastLen = txt.length;
      await page.screenshot({ path: `${OUT}/ctx-${String(screenshotNum).padStart(2,'0')}.png` });
      const tail = txt.substring(Math.max(0, txt.length - 400));
      console.log(`\n[${elapsed}s] ${txt.length} chars: ...${tail.substring(0, 300)}`);
      screenshotNum++;
    } else {
      process.stdout.write('.');
    }

    // Check for completion
    if (txt.includes('Key Findings') || txt.includes('Conclusion') ||
        txt.includes('Root Cause') || txt.includes('Save to Notebook') ||
        txt.includes('What would you like')) {
      console.log(`\n=== INVESTIGATION COMPLETE at ${elapsed}s ===`);
      break;
    }
    if (txt.includes('Failed to fetch') && elapsed > 60) {
      console.log(`\n=== ERROR at ${elapsed}s ===`);
      break;
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`\nTotal time: ${totalTime}s`);

  // Final capture — scroll through entire page
  await page.screenshot({ path: `${OUT}/ctx-final.png` });
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  const vh = await page.evaluate(() => window.innerHeight);
  for (let y = 0; y < totalHeight; y += vh) {
    await page.evaluate((sy) => window.scrollTo(0, sy), y);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/ctx-scroll-${Math.floor(y/vh)}.png` });
  }

  const finalText = await page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT}/ctx-results.txt`, finalText);
  writeFileSync(`${OUT}/ctx-api-calls.json`, JSON.stringify(apiCalls, null, 2));

  // Count actual search queries run
  const searchJobs = apiCalls.filter(c => c.url.includes('/search/jobs') && c.method === 'POST');
  const agentCalls = apiCalls.filter(c => c.url.includes('ai/q/agents') && c.method === 'POST');
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total time: ${totalTime}s`);
  console.log(`Agent API calls: ${agentCalls.length}`);
  console.log(`Search jobs run: ${searchJobs.length}`);
  console.log(`Total API calls: ${apiCalls.length}`);
  console.log(`Results in ctx-results.txt`);

  await close();
}

main().catch(e => { console.error(e); process.exit(1); });
