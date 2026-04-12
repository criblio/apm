// Smoke-test the new embedded Investigate page on the staging deployment.
// Navigates to /investigate, submits a prompt, auto-approves queries,
// and captures screenshots of the chat conversation until completion.
import { connect } from './browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const BASE = 'https://main-objective-shirley-sho21r7.cribl-staging.cloud';
const APP = `${BASE}/app-ui/oteldemo/investigate`;
const OUT = 'docs/research/investigator-spike/embedded';
mkdirSync(OUT, { recursive: true });

async function main() {
  const { browser, context, close } = await connect();
  const page = await context.newPage();

  // Capture console messages from the app (useful if something explodes)
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      console.log(`[browser ${t}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  // Capture agent API calls (for comparison vs native UI)
  const apiCalls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/v1/ai/') || url.includes('/search/jobs')) {
      apiCalls.push({
        ts: new Date().toISOString(),
        method: req.method(),
        url: url.replace(BASE, ''),
      });
      console.log(`>> ${req.method()} ${url.replace(BASE, '').substring(0, 100)}`);
    }
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/v1/ai/q/agents/local_search')) {
      console.log(`<< ${resp.status()} /api/v1/ai/q/agents/local_search`);
    }
  });

  console.log('Navigating to', APP);
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/01-landing.png` });

  // Verify the page rendered
  const title = await page
    .locator('text=Copilot Investigation')
    .first()
    .textContent()
    .catch(() => null);
  console.log('Page title found:', title);

  // Type a prompt and submit
  const prompt =
    'The payment service is failing on gRPC Charge calls. Investigate the root cause in the last 15 minutes.';

  console.log('Typing prompt...');
  const textarea = page.locator('textarea').first();
  await textarea.click();
  await textarea.fill(prompt);
  await page.screenshot({ path: `${OUT}/02-prompt.png` });
  await textarea.press('Enter');

  // Follow the conversation and auto-approve Run Query cards
  const startTime = Date.now();
  let shotNum = 3;
  let lastLen = 0;
  let lastAutoClick = 0;

  while (Date.now() - startTime < 540000) {
    await page.waitForTimeout(3000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Auto-click "Run Query"
    if (Date.now() - lastAutoClick > 2000) {
      const rq = page.locator('button:has-text("Run Query")');
      if ((await rq.count()) > 0) {
        console.log(`\n[${elapsed}s] Auto-clicking Run Query`);
        await rq.first().click();
        lastAutoClick = Date.now();
      }
    }

    const txt = await page.evaluate(() => document.body.innerText);

    if (txt.length !== lastLen) {
      lastLen = txt.length;
      await page.screenshot({
        path: `${OUT}/${String(shotNum).padStart(2, '0')}-progress.png`,
      });
      const tail = txt.substring(Math.max(0, txt.length - 400));
      console.log(`[${elapsed}s] ${txt.length} chars: ...${tail.replace(/\n+/g, ' | ').substring(0, 300)}`);
      shotNum++;
    } else {
      process.stdout.write('.');
    }

    // Termination heuristics — assistant done + no thinking indicator
    // for a while, or explicit Findings/Conclusion markers
    if (
      txt.includes('Findings') ||
      txt.includes('Conclusion') ||
      txt.includes('Root Cause') ||
      txt.includes('investigation summary presented')
    ) {
      // Wait one more turn for trailing text to stream in
      await page.waitForTimeout(5000);
      console.log(`\n[${elapsed}s] Appears complete`);
      break;
    }
    if (txt.includes('Error:') && elapsed > 30) {
      console.log(`\n[${elapsed}s] Error surfaced`);
      break;
    }
  }

  await page.screenshot({ path: `${OUT}/final.png` });

  // Scroll through the whole page for multi-screen capture
  const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => window.innerHeight);
  const scrollable = await page.evaluate(() => {
    const tr = document.querySelector('[class*="transcript"]');
    return tr ? { top: tr.scrollTop, height: tr.scrollHeight } : null;
  });
  console.log('Scroll container:', scrollable, 'totalHeight:', totalHeight, 'vh:', vh);

  // Scroll the transcript to capture everything
  for (let y = 0; y < (scrollable?.height ?? totalHeight); y += vh) {
    await page.evaluate((sy) => {
      const tr = document.querySelector('[class*="transcript"]');
      if (tr) tr.scrollTop = sy;
      else window.scrollTo(0, sy);
    }, y);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${OUT}/scroll-${Math.floor(y / vh)}.png`,
    });
  }

  const finalText = await page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT}/results.txt`, finalText);
  writeFileSync(`${OUT}/api-calls.json`, JSON.stringify(apiCalls, null, 2));

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const agentCalls = apiCalls.filter((c) => c.url.includes('ai/q/agents') && c.method === 'POST');
  const searchJobs = apiCalls.filter((c) => c.url.includes('/search/jobs') && c.method === 'POST');
  console.log(`\n=== SMOKE TEST DONE ===`);
  console.log(`Total time: ${totalTime}s`);
  console.log(`Agent POSTs: ${agentCalls.length}`);
  console.log(`Search jobs: ${searchJobs.length}`);

  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
