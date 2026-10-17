// APP_URL=http://localhost:8081 node fidelity/verify-screen.mjs <screen>  ->  "ALL PASS" (exit 0) or FAIL lines (exit 1)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DIR, open, probeAll, capture } from './extract-inventory.mjs';
const screen = process.argv[2], inv = JSON.parse(readFileSync(`${DIR}/inventory/${screen}.json`, 'utf8'));
const TOL = 2, scope = inv.appScope ?? 'html', browser = await chromium.launch();
const page = await open(browser, (process.env.APP_URL || 'http://localhost:8081') + inv.route, inv.device);
const got = new Map(); for (const i of await probeAll(page, scope)) if (!got.has(i.id)) got.set(i.id, i);
const out = [], ledger = [];
for (const want of inv.items) {
  const g = got.get(want.id), fails = [];
  if (!g) fails.push('missing');
  else {
    if (want.text !== null && g.text !== want.text) fails.push(`text "${g.text}" ≠ "${want.text}"`);
    for (const k of ['x', 'y', 'w', 'h'])
      if (Math.abs(g.box[k] - want.box[k]) > TOL) fails.push(`${k}=${g.box[k]}, expected ${want.box[k]}`);
    for (const k of ['font', 'color', 'bg', 'radius', 'shadow'])
      if (g.style[k] !== want.style[k]) fails.push(`${k} ${g.style[k]}, expected ${want.style[k]}`);
  }
  ledger.push({ id: want.id, passes: !fails.length, fails });     // only the gate records pass/fail
  out.push(...fails.map(f => `FAIL ${want.id}: ${f}`));
}
// The full-screen capture is taken every run. Per-element crops are only for the screen judge, which runs once
// everything passes, so they're skipped while items are still failing.
await capture(page, out.length ? [] : [...got.values()], `${DIR}/shots`, screen, scope);
await browser.close();
mkdirSync(`${DIR}/ledger`, { recursive: true });
writeFileSync(`${DIR}/ledger/${screen}.json`, JSON.stringify(ledger, null, 2));
console.log(out.length ? out.join('\n') : 'ALL PASS');
process.exit(out.length ? 1 : 0);
