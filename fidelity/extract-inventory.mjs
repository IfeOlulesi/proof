// node fidelity/extract-inventory.mjs <mockup.html[#state]> <screen-id> [scope-selector]
// Writes fidelity/inventory/<screen>.json (the contract) and fidelity/refs/<screen>*.png (the references).
// Pass a scope selector (e.g. '#screen-welcome') when one HTML file holds every screen. Set DEVICE to the phone's
// logical size; mockup and app both need <meta name="viewport" content="width=device-width, initial-scale=1">.
// Run from the repo root. Review each JSON once (fix "route"), then freeze: git add -A && git commit && git tag -f contract
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const DIR = 'fidelity';
const [VW, VH] = (process.env.FIDELITY_VIEWPORT || '393x852').split('x').map(Number);   // match the mockup's frame size
export const DEVICE = { viewport: { width: VW, height: VH }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export async function open(browser, url, device = DEVICE) {
  const page = await browser.newPage(device);
  await page.goto(url);
  await page.waitForSelector('[data-testid]', { timeout: 60_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return page;
}
// One pass at scroll 0, so boxes are stable coordinates relative to the scope (the phone frame or the page).
export const probeAll = (page, scope = 'html') => page.evaluate(sel => {
  scrollTo(0, 0);
  const root = document.querySelector(sel); root.scrollTo?.(0, 0);
  const o = root.getBoundingClientRect();
  return [...root.querySelectorAll('[data-testid]')].filter(e => e.checkVisibility({ visibilityProperty: true }))
    .map(e => {
      const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      return { id: e.dataset.testid,
        text: e.querySelector('[data-testid]') ? null       // containers carry no copy of their own
          : (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('alt') || '').trim(),
        box: { x: Math.round(r.x - o.x), y: Math.round(r.y - o.y), w: Math.round(r.width), h: Math.round(r.height) },
        style: { font: `${c.fontFamily.split(',')[0]} ${c.fontWeight} ${c.fontSize}/${c.lineHeight}`,
                 color: c.color, bg: c.backgroundColor, radius: c.borderRadius, shadow: c.boxShadow },
        motion: { transition: c.transition, animation: c.animation } };
    });
}, scope);
// Visible text, controls and media that no leaf data-testid covers: tag them in the mockup, then re-extract.
export const untagged = (page, scope = 'html') => page.evaluate(sel => {
  const root = document.querySelector(sel);
  const covered = e => { const t = e.closest('[data-testid]'); return t && root.contains(t) && !t.querySelector('[data-testid]'); };
  return [...root.querySelectorAll('*')].filter(e => e.checkVisibility() && !covered(e) &&
      (/^(button|a|input|textarea|select|img|svg|video)$/i.test(e.tagName) ||
       [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())))
    .map(e => `${e.tagName.toLowerCase()} "${(e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40)}"`);
}, scope);
export async function capture(page, items, dir, screen, scope = 'html') {
  mkdirSync(dir, { recursive: true });
  await (scope === 'html' ? page : page.locator(scope).first()).screenshot({ path: `${dir}/${screen}.png` });
  for (const i of items.filter(i => i.text !== null))       // leaf crops for the screen judge
    await page.locator(`${scope} [data-testid="${i.id}"]`).first()
      .screenshot({ path: `${dir}/${screen}--${i.id}.png` }).catch(() => {});
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, screen, scope = 'html'] = process.argv.slice(2), [path, hash] = source.split('#');
  const browser = await chromium.launch();
  const page = await open(browser, pathToFileURL(path).href + (hash ? `#${hash}` : ''));
  const items = await probeAll(page, scope);
  for (const u of await untagged(page, scope)) console.error(`WARN untagged ${u}`);
  await capture(page, items, `${DIR}/refs`, screen, scope);
  mkdirSync(`${DIR}/inventory`, { recursive: true });
  writeFileSync(`${DIR}/inventory/${screen}.json`,
    JSON.stringify({ screen, source, scope, route: `/${screen}`, device: DEVICE, items }, null, 2));
  await browser.close();
}
