// Helper for driving the user's already-running Chromium over CDP.
//
// The user launches Chromium manually (typically inside a VNC session) with
//   --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
// and this helper attaches to that instance instead of spawning a new one.
// That way we share cookies/sessions with the live browser window the user
// is looking at.
//
// Usage:
//   import { connect } from './browser.js';
//   const { browser, context, page, close } = await connect();
//   await page.goto('https://example.com');
//   await close(); // detaches without killing the user's browser
//
// Env overrides:
//   CDP_ENDPOINT  - override the CDP HTTP endpoint (default http://127.0.0.1:9222)

import { chromium } from 'playwright-core';

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

/**
 * Attach to the running Chromium over CDP and return the first usable page.
 *
 * @param {object} [opts]
 * @param {string} [opts.endpoint]   CDP HTTP endpoint; defaults to CDP_ENDPOINT env or 127.0.0.1:9222
 * @param {boolean} [opts.newPage]   If true, always open a fresh page instead of reusing an existing one
 * @returns {Promise<{browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext, page: import('playwright-core').Page, close: () => Promise<void>}>}
 */
export async function connect(opts = {}) {
  const endpoint = opts.endpoint ?? process.env.CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT;
  const browser = await chromium.connectOverCDP(endpoint);

  // With connectOverCDP the "default" context is the one that holds the pages
  // the user already has open. Prefer it so we share their real session.
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());

  let page;
  if (opts.newPage || context.pages().length === 0) {
    page = await context.newPage();
  } else {
    page = context.pages()[0];
  }

  // close() only disconnects the CDP client; it does NOT kill the user's Chromium.
  const close = async () => {
    await browser.close();
  };

  return { browser, context, page, close };
}
