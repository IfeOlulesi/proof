#!/usr/bin/env node
// Keeps GitHub's releases in step with the version proof ships. Run from the repo root.
//   node .github/release.mjs --check     plugin.json's version must be the newest CHANGELOG entry
//   node .github/release.mjs --dry-run   print the tags and releases it would create
//   node .github/release.mjs             tag and release every CHANGELOG version that has no tag yet
// A version is tagged at the commit that first set it in plugin.json, so a missed release is backfilled where it was made.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MANIFEST = 'plugins/proof/.claude-plugin/plugin.json';
const args = new Set(process.argv.slice(2));
const sh = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }).trim();
const die = (msg) => { console.error(msg); process.exit(1); };

const version = JSON.parse(readFileSync(MANIFEST, 'utf8')).version;
// CHANGELOG entries, newest first: "## 0.7.0 (2026-11-03)" and the lines under it.
const entries = [];
for (const line of readFileSync('CHANGELOG.md', 'utf8').split('\n')) {
  const m = line.match(/^## (\d+\.\d+\.\d+)\b/);
  if (m) entries.push({ version: m[1], notes: [] });
  else if (entries.length) entries.at(-1).notes.push(line);
}
if (!entries.length) die('CHANGELOG.md has no "## X.Y.Z" entries');
if (entries[0].version !== version) die(`plugin.json is ${version} but the newest CHANGELOG entry is ${entries[0].version}: add a "## ${version}" entry, or fix the version`);
if (args.has('--check')) { console.log(`ok: ${version} in plugin.json and CHANGELOG.md`); process.exit(0); }

const tags = new Set(sh('git', ['tag', '--list', 'v*']).split('\n').filter(Boolean));
// A version is done when it has a release, not just a tag: a run that pushed the tag and then failed is finished next run.
// PROOF_RELEASES (comma-separated tags) stands in for GitHub in the tests.
const releases = new Set((process.env.PROOF_RELEASES ?? sh('gh', ['release', 'list', '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName']))
  .split(/[\n,]/).filter(Boolean));
const plan = [];
for (const e of [...entries].reverse()) {
  if (releases.has(`v${e.version}`)) continue;
  const sha = sh('git', ['log', '--reverse', '--format=%H', '-G', `"version": "${e.version.replaceAll('.', '\\.')}"`, '--', MANIFEST]).split('\n')[0];
  if (!sha) { console.log(`skip ${e.version}: no commit sets it in plugin.json`); continue; }
  // "Release 0.7.0: the new dashboard (0.7.0)" -> "the new dashboard", as the earlier tags read.
  const subject = sh('git', ['log', '-1', '--format=%s', sha]);
  const summary = subject.match(/^Release [\d.]+: (.+?)(?: \([\d.]+\))?$/)?.[1];
  plan.push({ ...e, sha, tagged: tags.has(`v${e.version}`), message: summary ? `proof ${e.version}: ${summary}` : `proof ${e.version}`, notes: e.notes.join('\n').trim() });
}
if (!plan.length) { console.log(`up to date: v${version} is released`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'release-'));
for (const r of plan) {
  const latest = r.version === version;
  console.log(`${args.has('--dry-run') ? 'would release' : 'release'} v${r.version} at ${r.sha.slice(0, 7)}${latest ? ' (latest)' : ''}${r.tagged ? ' (already tagged)' : ''}: ${r.message}`);
  if (args.has('--dry-run')) continue;
  const notes = join(dir, `${r.version}.md`);
  writeFileSync(notes, r.notes + '\n');
  if (!r.tagged) {
    sh('git', ['tag', '-a', `v${r.version}`, r.sha, '-m', r.message]);
    sh('git', ['push', 'origin', `refs/tags/v${r.version}`]);
  }
  sh('gh', ['release', 'create', `v${r.version}`, '--verify-tag', '--title', `proof ${r.version}`, '--notes-file', notes, `--latest=${latest}`]);
}
