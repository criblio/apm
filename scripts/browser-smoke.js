// Smoke test: attach to the running Chromium over CDP, open a new tab,
// navigate to about:blank, and print the title + URL.
//
// Run with:  npm run browser:smoke

import { connect } from './browser.js';

const { page, close } = await connect({ newPage: true });

try {
  await page.goto('about:blank');
  const title = await page.title();
  const url = page.url();
  console.log(JSON.stringify({ ok: true, title, url }));
} finally {
  await close();
}
