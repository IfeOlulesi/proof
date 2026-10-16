#!/usr/bin/env node
// proof:design check — is this mockup complete enough for engineering to be verified against it?
// Usage: node check-design.mjs <mockup.html|URL> [--viewport 393x852] [--interactions <file>] [--min-target 44] [--out .proof/design]
// Exit 0 pass, 1 fail, 2 usage, 3 setup needed (Playwright or Chromium missing).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = new Map();
const pos = [];
for (let i = 0; i < args.length; i++) args[i].startsWith('--') ? flags.set(args[i], args[++i]) : pos.push(args[i]);
const src = pos[0];
if (!src) {
  console.log('usage: node check-design.mjs <mockup.html|URL> [--viewport 393x852] [--interactions interactions.json] [--min-target 44] [--out .proof/design]');
  process.exit(2);
}
const [vw, vh] = (flags.get('--viewport') || '393x852').split('x').map(Number);
const minTarget = Number(flags.get('--min-target') || 44);
const outDir = flags.get('--out') || '.proof/design';
const isUrl = /^https?:\/\//i.test(src);
if (!isUrl && !existsSync(src)) { console.log(`FAIL design: ${src} not found`); process.exit(1); }
const url = isUrl ? src : pathToFileURL(resolve(src)).href;
const interPath = flags.get('--interactions') || (isUrl ? null : join(dirname(resolve(src)), 'interactions.json'));

const pw = loadPlaywright();
if (!pw) setup('Playwright is not installed for this project.');
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { setup(`Chromium did not launch: ${String(e.message).split('\n')[0]}`); }
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready.then(() => true));
const screens = await page.evaluate(analyze, { minTarget });

const fails = [], warns = [];
const head = await page.evaluate(() => ({
  charset: (document.querySelector('meta[charset]')?.getAttribute('charset')
    || (document.querySelector('meta[http-equiv="Content-Type" i]')?.content.match(/charset=([\w-]+)/i) || [])[1] || '').toLowerCase(),
  viewport: !!document.querySelector('meta[name="viewport"]'),
}));
if (head.charset !== 'utf-8') fails.push('design: add <meta charset="utf-8"> to <head> — without it, served copy such as ₦, accents or emoji can decode differently from the file you reviewed');
if (!head.viewport) fails.push('design: add <meta name="viewport" content="width=device-width, initial-scale=1"> — the fidelity check renders mockup and app at device width');
if (!screens.length) fails.push('design: no [data-screen] containers — wrap each screen and state frame in <div data-screen="<id>">');
mkdirSync(outDir, { recursive: true });
for (const s of screens) {
  if (Math.abs(s.width - vw) > 1)
    fails.push(`${s.id}: frame renders ${Math.round(s.width)}px wide, expected ${vw} — give screen frames a fixed width and flex-shrink: 0, or pass --viewport <w>x<h> for your device size`);
  for (const [kind, msg] of s.issues) fails.push(`${s.id}: ${kind} ${msg}`);
  await page.locator(`[data-screen="${s.id}"]`).first().screenshot({ path: join(outDir, `${s.id}.png`) })
    .catch(e => warns.push(`${s.id}: screenshot failed (${String(e.message).split('\n')[0]})`));
}

const interactive = [...new Set(screens.flatMap(s => s.interactive))];
if (interactive.length) {
  if (!interPath || !existsSync(interPath)) {
    fails.push(`interactions: no interactions.json next to the mockup — spec ${interactive.length} interactive elements (trigger, states, effect, duration_ms, easing)`);
  } else {
    let spec = null;
    try { spec = JSON.parse(readFileSync(interPath, 'utf8')); } catch (e) { fails.push(`interactions: invalid JSON (${e.message})`); }
    if (spec) {
      const entries = Array.isArray(spec) ? spec : Array.isArray(spec.interactions) ? spec.interactions : [];
      const covered = new Set(entries.map(e => e && e.element).filter(Boolean));
      for (const id of interactive) if (!covered.has(id)) fails.push(`interactions: no entry for "${id}"`);
    }
  }
}
await browser.close();

for (const w of warns) console.log(`WARN ${w}`);
for (const f of fails.slice(0, 80)) console.log(`FAIL ${f}`);
if (fails.length > 80) console.log(`… and ${fails.length - 80} more`);
console.log(fails.length
  ? `\n${fails.length} issue(s) across ${screens.length} screen(s). Screenshots: ${outDir}/`
  : `PASS design: ${screens.length} screen(s), ${interactive.length} interactive element(s) specced. Now review the screenshots in ${outDir}/.`);
process.exit(fails.length ? 1 : 0);

function setup(why) {
  console.log(`SETUP ${why} Run in the project: npm i -D playwright && npx playwright install chromium`);
  process.exit(3);
}

function loadPlaywright() {
  const bases = [join(process.cwd(), 'noop.js')];
  if (process.env.CLAUDE_PLUGIN_DATA) bases.push(join(process.env.CLAUDE_PLUGIN_DATA, 'noop.js'));
  try { bases.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'noop.js')); } catch {}
  for (const b of bases) { try { return createRequire(b)('playwright'); } catch {} }
  return null;
}

// Runs in the page.
function analyze({ minTarget }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const blend = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const effectiveBg = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // gradients and images: can't compute reliably
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  };
  const visible = e => (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !!(e.offsetWidth || e.offsetHeight));
  const directText = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const label = e => (e.innerText || e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const idOf = e => e.dataset?.testid || e.closest('[data-testid]')?.dataset.testid || e.tagName.toLowerCase();
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [onclick], [tabindex]:not([tabindex="-1"])';
  const PLACEHOLDER = /lorem ipsum|dolor sit amet|\b(TODO|TBD|XXX)\b|\[(text|copy|title|label)\]/i;

  return [...document.querySelectorAll('[data-screen]')].map(root => {
    const issues = [];
    const covered = e => { const t = e.closest('[data-testid]'); return t && root.contains(t) && !t.querySelector('[data-testid]'); };
    const all = [...root.querySelectorAll('*')].filter(e => visible(e) && !(e.closest('svg') && e.tagName.toLowerCase() !== 'svg'));

    for (const e of all) {
      if (covered(e)) continue;
      if (/^(button|a|input|textarea|select|img|svg|video|canvas)$/i.test(e.tagName) || directText(e))
        issues.push(['untagged', `${e.tagName.toLowerCase()} "${label(e)}" — add a data-testid`]);
    }

    const counts = new Map();
    for (const e of root.querySelectorAll('[data-testid]')) counts.set(e.dataset.testid, (counts.get(e.dataset.testid) || 0) + 1);
    for (const [k, n] of counts) if (n > 1) issues.push(['duplicate-id', `"${k}" ×${n} — make IDs unique within the screen (${k}-1, ${k}-2)`]);

    for (const e of all) if (directText(e) && PLACEHOLDER.test(e.innerText)) issues.push(['placeholder', `${idOf(e)} "${label(e)}"`]);

    for (const e of all) {
      if (!directText(e) || e.closest(':disabled, [aria-disabled="true"]')) continue;
      const bg = effectiveBg(e);
      if (!bg) continue;
      const cs = getComputedStyle(e);
      const fg = blend(rgba(cs.color), bg);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (ratio < need) issues.push(['contrast', `${idOf(e)} "${label(e)}" ${ratio.toFixed(2)}:1 (needs ${need}:1)`]);
    }

    const interactive = [];
    for (const e of root.querySelectorAll(INTERACTIVE)) {
      if (!visible(e)) continue;
      interactive.push(idOf(e));
      if (getComputedStyle(e).display === 'inline') continue;
      const r = e.getBoundingClientRect();
      if (r.width < minTarget || r.height < minTarget)
        issues.push(['target', `${idOf(e)} is ${Math.round(r.width)}×${Math.round(r.height)} (min ${minTarget}×${minTarget})`]);
    }
    return { id: root.dataset.screen, width: root.getBoundingClientRect().width, issues, interactive: [...new Set(interactive)] };
  });
}
