#!/usr/bin/env node
// The website's link previews and search metadata: every tag points at the live GitHub Pages URL,
// the share image exists at 1200x630, sitemap.xml agrees with the canonical URL, and the version shown is the released one.
// It reads the source tree; after publishing gh-pages, curl the live og.png too (a project site can't have its own robots.txt).
//   node tests/site-seo.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const URL_BASE = 'https://ifeolulesi.github.io/proof/';
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
let pass = 0, fail = 0;
const expect = (name, ok) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };

const meta = (attr, key) => {
  const m = head.match(new RegExp(`<meta ${attr}="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)"`));
  return m ? m[1] : null;
};
const link = rel => { const m = head.match(new RegExp(`<link rel="${rel}" href="([^"]*)"`)); return m ? m[1] : null; };

const title = (head.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const desc = meta('name', 'description') || '';
expect('title is 30-65 characters', title.length >= 30 && title.length <= 65);
expect('description is 70-160 characters', desc.length >= 70 && desc.length <= 160);
expect('canonical is the GitHub Pages URL', link('canonical') === URL_BASE);
expect('no tag points at the retired Vercel domain', !/proof\.ifeolulesi\.com/.test(html));

for (const k of ['og:title', 'og:description', 'og:type', 'og:site_name', 'og:image:alt', 'og:locale'])
  expect(`${k} is set`, !!meta('property', k));
expect('og:url is the canonical URL', meta('property', 'og:url') === URL_BASE);
expect('og:image is absolute under the canonical URL', (meta('property', 'og:image') || '').startsWith(URL_BASE));
expect('og:image is declared 1200x630', meta('property', 'og:image:width') === '1200' && meta('property', 'og:image:height') === '630');
expect('twitter card is summary_large_image', meta('name', 'twitter:card') === 'summary_large_image');
for (const k of ['twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'])
  expect(`${k} is set`, !!meta('name', k));

// The version on the page is the released one (plugin.json), wherever it's printed; the page also refreshes it live.
const version = JSON.parse(readFileSync(join(ROOT, 'plugins/proof/.claude-plugin/plugin.json'), 'utf8')).version;
const printed = [...html.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map(m => m[1]);
expect(`every version printed on the page is ${version} (found ${[...new Set(printed)].join(', ') || 'none'})`, printed.length > 0 && printed.every(v => v === version));
expect('each printed version is a .ver the page refreshes live', (html.match(/<span class="ver">v\d/g) || []).length === printed.length);

// The share image file the tags name, read from the repo (site/assets links to ../assets).
const ogPath = (meta('property', 'og:image') || '').replace(URL_BASE, '');
const png = ogPath && existsSync(join(SITE, ogPath)) ? readFileSync(join(SITE, ogPath)) : null;
expect('og:image file exists', !!png);
if (png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  expect(`og:image file is 1200x630 (is ${w}x${h})`, w === 1200 && h === 630);
  expect('og:image file is under 1 MB', png.length < 1024 * 1024);
}
expect('twitter:image matches og:image', meta('name', 'twitter:image') === meta('property', 'og:image'));

const ld = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
let data = null; try { data = ld && JSON.parse(ld[1]); } catch { data = null; }
expect('JSON-LD parses', !!data);
expect('JSON-LD describes free software at the canonical URL',
  !!data && data['@type'] === 'SoftwareApplication' && data.url === URL_BASE && data.offers?.price === '0');

const sitemap = existsSync(join(SITE, 'sitemap.xml')) ? readFileSync(join(SITE, 'sitemap.xml'), 'utf8') : '';
expect('sitemap.xml lists the canonical URL', sitemap.includes(`<loc>${URL_BASE}</loc>`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
