#!/usr/bin/env node
// The dashboard page in a real browser: the interactions in mockup/interactions.json, live polling and going offline.
// Needs Playwright and a static server at the repo root (python3 -m http.server 47400 --bind 127.0.0.1):
//   node tests/dashboard-page.mjs [http://127.0.0.1:47400]
// Not part of tests/run.sh, which runs without a browser.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:47400';
const PAGE = `${BASE}/plugins/proof/scripts/dashboard.html`;
const FIX = `${BASE}/tests/fixtures/dashboard`;
let pass = 0, fail = 0;
// expect(name, check): passes once check() is true, polling for up to a second (the page re-renders asynchronously).
const expect = async (name, check) => {
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) { try { ok = !!(await check()); } catch { ok = false; } if (!ok) await new Promise(r => setTimeout(r, 50)); }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`); ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const id = t => page.locator(`[data-testid="${t}"]`).first();
const text = async t => (await id(t).innerText()).replace(/\s+/g, ' ').trim();
const count = t => page.locator(`[data-testid="${t}"]`).count();
const hash = () => page.evaluate(() => location.hash);
const open = async (q = '', fixture = 'home--working') => { await page.goto(`${PAGE}?data=/tests/fixtures/dashboard/${fixture}.json${q}&r=${Math.random()}`); await id('title').waitFor(); };

console.log('== switcher');
await open();
await id('tab-2').click();
await expect('a tab selects its session', async () => (await text('title')) === 'Admin access on production' && (await hash()).includes('s=admin'));
await page.keyboard.press('1');
await expect('1 to 4 select tabs', async () => (await text('title')) === 'Checkout flow build');

console.log('== command palette');
await page.keyboard.press('Control+k');
await expect('Ctrl+K opens the palette with the search focused', async () => await id('sw-search').evaluate(e => e === document.activeElement));
await page.keyboard.type('eap');
await expect('typing filters to the project, needs-you still on top', async () => (await text('sw-group-1')) === 'eap_multi_agent_backend' && !(await count('sw-group-2')) && (await text('sw-item-1')).startsWith('Admin access on production'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await expect('arrow and Enter open a session, which takes the last tab', async () => (await text('title')) === 'TRB test case documents review' && (await text('tab-4')).startsWith('TRB') && !(await count('switcher')));
await id('more').click();
await page.keyboard.press('Escape');
await expect('Esc closes the palette', async () => !(await count('switcher')));
await open('', 'switcher--hidden-needs-you');
await expect('a hidden session that needs you shows on +N more', async () => (await text('more')).includes('1 needs you'));

console.log('== range');
await open();
await id('range-1').click();
await expect('Last hour re-draws the chart in 5-minute bars', async () => (await text('act-desc')).startsWith('every 5 minutes'));
await id('range-2').click();
await expect('Session goes back to 10-minute bars', async () => (await text('act-desc')).startsWith('every 10 minutes'));

console.log('== tooltips');
await page.locator('[data-testid="activity"] rect[data-tip]').nth(3).hover();
await expect('a chart column lists its activity', async () => (await page.locator('.tip').innerText()).includes('Thinking & writing'));
await id('node-lane-b').hover();
await expect('an agent node says what it is doing', async () => (await page.locator('.tip').innerText()).includes('Running e2e tests'));

console.log('== bottom sheet');
await page.keyboard.press('w');
await expect('W opens where the time went', async () => await id('t-cats').isVisible());
await page.keyboard.press('t');
await expect('T switches to the timeline', async () => await id('wf-title').isVisible());
await page.locator('[data-testid="wf-chart"] rect[data-tip]').nth(5).hover();
await expect('hovering a block shows what ran', async () => /Main thread · \d\d:\d\d/.test(await page.locator('.tip').innerText()));
await id('sheet-log').click();
await id('log-tab-5').click();
await expect('log filters change what is listed', async () => (await text('log-count')).endsWith('of 40'));
await id('sheet-log').click();
await expect('the current sheet tab closes it', async () => !(await count('sheet')));
await page.keyboard.press('l');
await page.keyboard.press('Escape');
await expect('Esc closes the sheet', async () => !(await count('sheet')));
await page.keyboard.press('l');
await page.mouse.click(700, 120);
await expect('a click on the scrim closes it', async () => !(await count('sheet')));

console.log('== drill-down and views');
await id('node-lane-b').click();
await expect('an agent opens its drill-down', async () => (await text('title')) === 'Lane B unit 13: payment screen' && (await text('brief-text')).startsWith('Build the payment screen'));
await id('show-earlier').click();
await expect('show earlier lists every tool call', async () => (await page.locator('[data-testid^="call-"][data-testid$="-time"]').count()) === 40);
await page.keyboard.press('Backspace');
await expect('Backspace goes back', async () => await id('agents-card').isVisible());
await id('node-main').click();
await expect('the main thread has a drill-down', async () => (await text('title')) === 'Main thread' && (await text('status-title')) === 'Waiting on 3 agents');
await id('back').click();
await expect('back returns to the session', async () => await id('agents-card').isVisible());
await id('mem-pill').click();
await expect('the memory pill opens the memory view', async () => (await text('mem-used')).startsWith('68% used'));
await open('#s=admin');
await id('answer-copy').click();
await expect('copy path says Copied', async () => (await text('answer-copy')) === 'Copied');
await open('#s=release');
await id('time-open').click();
await expect('Open in full opens the time sheet', async () => await id('t-cats').isVisible());

console.log('== theme');
await open('&theme=light');
await id('theme').click();
await expect('the toggle switches to dark and remembers it', async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await page.evaluate(() => localStorage.getItem('proof-theme'))) === 'dark');
await page.evaluate(() => localStorage.removeItem('proof-theme'));

console.log('== live');
let n = 0, down = false; const t0 = Date.now();
const feed = await (await fetch(`${FIX}/home--working.json`)).json();
await page.route('**/data.json*', route => {
  n++;
  if (down) return route.abort();
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...feed, now: feed.now + (Date.now() - t0), live: true }) });
});
await page.goto(PAGE);
await id('title').waitFor();
await expect('rings draw in on the live page', async () => (await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'ring-in').length)) === 3);
const t1 = await text('status-timer');
await page.waitForTimeout(2300);
await expect('polls data.json every 2 seconds', async () => n >= 2);
await expect('timers tick between polls', async () => (await text('status-timer')) !== t1);
await expect('the logo dot is live', async () => !(await page.locator('.logo.off').count()));
down = true;
await page.waitForTimeout(4500);
await expect('a failed poll shows Not live and greys the dot', async () => (await id('offline-banner').isVisible()) && (await page.locator('.logo.off').count()) === 1);
down = false;
await page.waitForTimeout(2500);
await expect('and recovers by itself', async () => !(await count('offline-banner')));

console.log('== reduced motion');
const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await rm.goto(`${PAGE}?data=/tests/fixtures/dashboard/home--working.json`);
await rm.locator('[data-testid="title"]').waitFor();
await expect('no pulse, spin, wire flow or ring animation', async () => (await rm.evaluate(() => document.getAnimations().length)) === 0);

await expect('no page errors', async () => errors.length === 0);
if (errors.length) console.log(errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
