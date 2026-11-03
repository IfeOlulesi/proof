#!/usr/bin/env node
// proof recap: what the gate did, from the ledger (ledger.mjs).
//   node recap.mjs                     the last 7 days
//   node recap.mjs --since 30d         a longer period (h, d or w)
//   node recap.mjs --session <id>      one session
//   node recap.mjs --json              the numbers as JSON
//   node recap.mjs --backfill          add the gate runs already in Claude Code's session logs (backfill.mjs)
import { duration, readLedger, tally } from './ledger.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--backfill')) {
  const { backfillCli } = await import('./backfill.mjs');
  await backfillCli(argv.includes('--quiet'));
  process.exit(0);
}
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const session = opt('--session');
const since = opt('--since') || '7d';

const all = readLedger();
let t, label;
if (session) {
  t = tally(all.filter(e => e.session === session));
  label = `session ${session}`;
} else {
  const m = /^(\d+)([hdw])$/.exec(since);
  const ms = m ? Number(m[1]) * { h: 3600e3, d: 864e5, w: 7 * 864e5 }[m[2]] : 7 * 864e5;
  t = tally(all, { from: Date.now() - ms });
  label = `the last ${m ? since : '7d'}`;
}

if (argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(t)}\n`);
} else {
  const top = Object.entries(t.caughtChecks).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(', ');
  const flaky = Object.keys(t.flakyChecks).join(', ');
  console.log([
    `proof, ${label}: ${t.runs} gate run${t.runs === 1 ? '' : 's'} across ${t.sessions} session${t.sessions === 1 ? '' : 's'}`,
    `  caught before you saw them  ${t.caught}${top ? `  (${top})` : ''}`,
    `  commits blocked             ${t.commitsBlocked}`,
    `  handed back to you          ${t.gaveUp + t.askedUser}  (gave up ${t.gaveUp}, asked you ${t.askedUser})`,
    `  flaky (passed on a rerun)   ${t.flaky}${flaky ? `  (${flaky})` : ''}`,
    `  time in checks              ${duration(t.checkMs)} over ${t.checksRun} check run${t.checksRun === 1 ? '' : 's'}`,
  ].join('\n'));
}
