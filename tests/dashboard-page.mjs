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
const hash = () => page.evaluate(() => location.hash);
const open = async (q = '') => { await page.goto(`${PAGE}?data=/tests/fixtures/dashboard/home--working.json${q}&r=${Math.random()}`); await id('status-text').waitFor(); };

console.log('== switcher');
await open();
await id('tab-2').click();
await expect('a tab selects its session', async () => (await text('session-title')) === 'Admin access on production' && (await hash()).includes('s=admin'));
await page.keyboard.press('1');
await expect('1 to 4 select tabs', async () => (await text('session-title')) === 'Checkout flow build');

console.log('== session menu');
await page.keyboard.press('Control+k');
await expect('Ctrl+K opens the menu with the search focused', async () => await id('menu-search').evaluate(e => e === document.activeElement));
await page.keyboard.type('eap');
await expect('typing filters to the project', async () => (await page.locator('[data-testid^="menu-project-"]').count()) === 1 && (await text('menu-project-1')).startsWith('eap_multi_agent_backend'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await expect('arrow and Enter open a session', async () => (await text('session-title')) === 'TRB test case documents review' && !(await id('menu-search').count()));
await id('tab-more').click(); await page.keyboard.press('Escape'); 
await expect('Esc closes the menu', async () => !(await id('menu-search').count()));

console.log('== drawers and views');
await open();
await page.keyboard.press('w');
await expect('W opens where the time went', async () => await id('time-headline').isVisible());
await id('time-row-2').hover();
await expect('hovering a row explains it', async () => (await text('time-tip')).startsWith('Tests & checks'));
await page.keyboard.press('t');
await expect('T switches to the timeline', async () => await id('tl-axis').isVisible());
const lane = id('tl-lane-3').locator('.trk');
const box = await lane.boundingBox();
await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
await expect('hovering a block shows what ran', async () => (await text('tl-tip')).startsWith('lane-b · Tests'));
await id('tl-lane-3').focus();
await page.mouse.move(0, 0);
await page.keyboard.press('ArrowLeft');
await expect('arrow keys move between a focused lane\'s blocks', async () => (await text('tl-tip')).startsWith('lane-b · Tests'));
await page.keyboard.press('ArrowLeft');
await expect('and on to the one before', async () => (await text('tl-tip')).startsWith('lane-b · Editing code'));
await page.keyboard.press('l');
await id('log-tools').click();
await expect('log filters change what is listed', async () => (await text('log-count')).endsWith('of 40'));
await page.keyboard.press('Escape');
await expect('Esc closes the drawer', async () => await id('run-title').isVisible());
await id('job-1').click();
await expect('an agent opens its drill-down', async () => (await text('crumb-here')) === 'Lane B unit 13: payment screen' && (await text('brief-text')).startsWith('Build the payment screen'));
await id('act-more').click();
await expect('show earlier lists every tool call', async () => (await page.locator('[data-testid^="act-"]:not([data-testid="act-more"])').count()) === 40);
await page.keyboard.press('Backspace');
await expect('Backspace goes back too', async () => await id('run-title').isVisible());
await id('job-4').click();
await expect('a finished agent shows its last message', async () => (await text('result-text')).startsWith('Cart screen is built'));
await id('back').click();
await id('job-main').click();
await expect('the main thread drill-down lists the task list as its steps, with no brief', async () => (await text('jstep-5')).startsWith('Payment screen') && !(await id('brief-text').count()));
await id('back').click();
await expect('back returns to the session', async () => await id('run-title').isVisible());
await id('mem-chip').click();
await expect('the memory chip opens the memory view', async () => (await text('mem-title')).startsWith('68% used'));

console.log('== theme');
await open('&theme=light');
await id('theme-toggle').click();
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
await id('status-text').waitFor();
const t1 = await text('status-timer');
await page.waitForTimeout(2300);
await expect('polls data.json every 2 seconds', async () => n >= 2);
await expect('timers tick between polls', async () => (await text('status-timer')) !== t1);
await expect('the logo dot is live', async () => !(await page.locator('.brand.off').count()));
down = true;
await page.waitForTimeout(4500);
await expect('a failed poll shows Not live and greys the dot', async () => (await id('offline-banner').isVisible()) && (await page.locator('.brand.off').count()) === 1);
down = false;
await page.waitForTimeout(2500);
await expect('and recovers by itself', async () => !(await id('offline-banner').count()));

console.log('== reduced motion');
const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await rm.goto(`${PAGE}?data=/tests/fixtures/dashboard/home--working.json`);
await rm.locator('[data-testid="status-text"]').waitFor();
await expect('no pulse or halo animation', async () => (await rm.evaluate(() => document.getAnimations().length)) === 0);

await expect('no page errors', async () => errors.length === 0);
if (errors.length) console.log(errors);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
