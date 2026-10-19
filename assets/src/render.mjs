// Renders how-it-works.html to assets/how-it-works.png and how-it-works-dark.png. Needs playwright (npx playwright).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const b = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: 880, height: 600 }, deviceScaleFactor: 2 });
  await p.goto(`file://${here}how-it-works.html?theme=${theme}`);
  await p.waitForSelector('body[data-ready]');
  await p.evaluate(() => document.fonts.ready);
  await p.locator('#frame').screenshot({ path: `${here}../how-it-works${theme === 'dark' ? '-dark' : ''}.png` });
}
await b.close();
