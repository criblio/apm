// Smoke-test the embedded Investigate page against the authenticated
// staging deployment. Attaches to the existing /apps/oteldemo shell
// tab (session cookies intact), navigates the iframe to /investigate,
// submits a prompt about the payment failure, auto-approves Run Query
// cards, and captures screenshots of the conversation.
import { connect } from './browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const BASE = 'https://main-objective-shirley-sho21r7.cribl-staging.cloud';
const OUT = 'docs/research/investigator-spike/embedded';
mkdirSync(OUT, { recursive: true });

async function main() {
  const { browser, context, close } = await connect();

  // Find the authenticated shell tab (it wraps the app in an iframe
  // that gets CRIBL_API_URL / CRIBL_BASE_PATH injected).
  const pages = context.pages();
  let page = pages.find((p) => p.url().includes('/apps/oteldemo'));
  if (!page) {
    // Fall back: any tab on the staging origin that isn't a login
    page = pages.find(
      (p) =>
        p.url().includes('main-objective-shirley-sho21r7.cribl-staging.cloud') &&
        !p.url().includes('login'),
    );
  }
  if (!page) {
    console.log('No authenticated staging tab found. Available tabs:');
    for (const p of pages) console.log('  ', p.url());
    await close();
    return;
  }
  console.log('Attached to:', page.url());

  // Reload to pick up the latest deployed build
  console.log('Reloading...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);

  // Capture agent API calls for comparison vs the native UI spike
  const apiCalls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/v1/ai/') || url.includes('/search/jobs')) {
      apiCalls.push({
        ts: new Date().toISOString(),
        method: req.method(),
        url: url.replace(BASE, ''),
      });
    }
  });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') console.log(`[console ${t}]`, msg.text());
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  // Make sure we're on the shell, not app-ui/... directly
  if (!page.url().includes('/apps/oteldemo')) {
    console.log('Navigating to shell...');
    await page.goto(`${BASE}/apps/oteldemo/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
  }

  console.log('Current URL:', page.url());
  if (page.url().includes('login')) {
    console.log('Session expired, cannot proceed');
    await close();
    return;
  }

  await page.screenshot({ path: `${OUT}/smoke-01-shell.png` });

  // Find the app frame. The app is sandboxed into an iframe with
  // an opaque URL (blank/blob), so we find it by locating the frame
  // that contains our composer textarea.
  async function findAppFrame() {
    for (const f of page.frames()) {
      const hasOurTextarea = await f
        .evaluate(() => !!document.querySelector('textarea[placeholder="Ask me to investigate something..."]'))
        .catch(() => false);
      if (hasOurTextarea) return f;
    }
    return null;
  }

  // Before navigating, the Investigate page isn't loaded yet, so we
  // first need to click the nav link from whatever frame contains
  // the nav. Since the nav lives alongside the composer in the app
  // iframe, try to find it by looking for frames with our nav link.
  async function findFrameWithNav() {
    for (const f of page.frames()) {
      const hasNav = await f
        .evaluate(() => {
          return Array.from(document.querySelectorAll('a')).some(
            (a) => a.textContent?.trim() === 'Investigate' && a.getAttribute('href')?.includes('investigate'),
          );
        })
        .catch(() => false);
      if (hasNav) return f;
    }
    return null;
  }

  let appFrame = (await findFrameWithNav()) ?? page;

  // Click Investigate in the app nav
  const navInvestigate = appFrame.locator('a:has-text("Investigate")').first();
  const navCount = await navInvestigate.count();
  console.log('Investigate nav link count:', navCount);
  if (navCount > 0) {
    await navInvestigate.click();
    await page.waitForTimeout(3000);
  } else {
    console.log('No Investigate nav link found');
    await close();
    return;
  }

  // After navigation, find the frame with our composer textarea
  appFrame = (await findAppFrame()) ?? appFrame;
  console.log('App frame URL after nav:', appFrame.url() || '(opaque)');

  await page.screenshot({ path: `${OUT}/smoke-02-investigate-landing.png` });

  // Verify Copilot Investigation page rendered in our frame
  const textareas = await appFrame.locator(
    'textarea[placeholder="Ask me to investigate something..."]',
  ).count();
  console.log('Our composer textarea count:', textareas);
  if (textareas === 0) {
    console.log('Page did not render. Body text:');
    const body = await appFrame
      .evaluate(() => document.body.innerText.substring(0, 1000))
      .catch(() => '(eval failed)');
    console.log(body);
    await close();
    return;
  }

  // Type prompt and submit. Use our app's textarea specifically —
  // there's also a hidden native Cribl Copilot textarea in the shell.
  const prompt =
    'The payment service is failing on gRPC Charge calls. Investigate the root cause in the last 15 minutes.';
  console.log('Submitting prompt...');
  const textarea = appFrame.locator(
    'textarea[placeholder="Ask me to investigate something..."]',
  );
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  await textarea.click();
  await textarea.fill(prompt);
  await page.screenshot({ path: `${OUT}/smoke-03-prompt.png` });
  await textarea.press('Enter');

  // Follow the conversation. Auto-approve Run Query. Take screenshot
  // on every text change.
  const startTime = Date.now();
  let shotNum = 4;
  let lastLen = 0;
  let lastAutoClick = 0;
  let searchJobsObserved = 0;

  while (Date.now() - startTime < 540000) {
    await page.waitForTimeout(3000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (Date.now() - lastAutoClick > 2000) {
      const rq = appFrame.locator('button:has-text("Run Query")');
      const rqCount = await rq.count();
      if (rqCount > 0) {
        console.log(`\n[${elapsed}s] Auto-clicking Run Query (${rqCount} pending)`);
        await rq.first().click();
        lastAutoClick = Date.now();
      }
    }

    const txt = await appFrame.evaluate(() => document.body.innerText);

    if (txt.length !== lastLen) {
      lastLen = txt.length;
      await page.screenshot({ path: `${OUT}/smoke-${String(shotNum).padStart(2, '0')}.png` });
      const tail = txt.substring(Math.max(0, txt.length - 500)).replace(/\s+/g, ' ');
      console.log(`[${elapsed}s] ${txt.length} chars: ...${tail.substring(0, 400)}`);
      shotNum++;
    } else {
      process.stdout.write('.');
    }

    const latestJobs = apiCalls.filter(
      (c) => c.url.includes('/search/jobs') && c.method === 'POST',
    ).length;
    if (latestJobs !== searchJobsObserved) {
      console.log(`\n[${elapsed}s] Search jobs so far: ${latestJobs}`);
      searchJobsObserved = latestJobs;
    }

    // Check for completion markers
    if (
      txt.includes('Findings') ||
      txt.includes('Conclusion') ||
      txt.includes('Root Cause') ||
      txt.includes('Investigation summary presented') ||
      txt.includes('ECONNREFUSED')
    ) {
      await page.waitForTimeout(5000);
      console.log(`\n[${elapsed}s] Appears complete`);
      break;
    }
    if (txt.includes('Error:') && !txt.includes('error rate') && elapsed > 30) {
      console.log(`\n[${elapsed}s] Error surfaced — may still be recoverable`);
    }
  }

  await page.screenshot({ path: `${OUT}/smoke-final.png` });

  // Scroll transcript from top to capture everything
  await appFrame.evaluate(() => {
    const tr = document.querySelector('[class*="transcript"]');
    if (tr) tr.scrollTop = 0;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/smoke-scroll-top.png` });

  const scrollHeight = await appFrame.evaluate(() => {
    const tr = document.querySelector('[class*="transcript"]');
    return tr ? tr.scrollHeight : 0;
  });
  const vh = await appFrame.evaluate(() => window.innerHeight);
  console.log(`Transcript scrollHeight: ${scrollHeight}, viewport: ${vh}`);

  for (let y = 0; y < scrollHeight; y += vh) {
    await appFrame.evaluate((sy) => {
      const tr = document.querySelector('[class*="transcript"]');
      if (tr) tr.scrollTop = sy;
    }, y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/smoke-scroll-${Math.floor(y / vh)}.png` });
  }

  const finalText = await appFrame.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT}/smoke-results.txt`, finalText);
  writeFileSync(`${OUT}/smoke-api-calls.json`, JSON.stringify(apiCalls, null, 2));

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const agentCalls = apiCalls.filter((c) => c.url.includes('ai/q/agents') && c.method === 'POST');
  const searchJobs = apiCalls.filter((c) => c.url.includes('/search/jobs') && c.method === 'POST');
  console.log(`\n=== EMBEDDED SMOKE TEST DONE ===`);
  console.log(`Total time: ${totalTime}s`);
  console.log(`Agent POSTs: ${agentCalls.length}`);
  console.log(`Search jobs: ${searchJobs.length}`);

  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
