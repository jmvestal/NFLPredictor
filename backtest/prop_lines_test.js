// Tests the props model against real DraftKings closing prop lines (2026, weeks 2+).
// Assumes -115 on both sides (DraftKings' usual prop price; ESPN doesn't provide the prices).
// Usage: node prop_lines_test.js
const P = require('./props.js');
const prm = require('./props_params.json');
const lines = require('./proplines.json');

const TYPE_TO_STAT = {
  'Total Passing Yards (incl. overtime)': 'passYds',
  'Total Pass Completions (incl. overtime)': 'cmp',
  'Total Passing Touchdowns (incl. overtime)': 'passTD',
  'Total Carries (incl. overtime)': 'rushAtt',
  'Total Rushing Yards (incl. overtime)': 'rushYds',
  'Total Receiving Yards (incl. overtime)': 'recYds',
  'Total Receptions (incl. overtime)': 'rec',
};
const PRICE = -115, WIN = 100 * 100 / 115; // profit on a $100 bet at -115

const rowByKey = {};
for (const r of P.rows) rowByKey[r.eid + ':' + r.pid] = r;

const bets = [];
let dnp = 0, noProj = 0;
for (const [eid, list] of Object.entries(lines)) {
  for (const pl of list) {
    const sk = TYPE_TO_STAT[pl.type]; if (!sk) continue;
    const row = rowByKey[eid + ':' + pl.aid];
    if (!row) { dnp++; continue; } // player not in box score = didn't play, bet voided
    if (row.week < 2) continue;
    const ps = prm.stats[sk];
    const pr = P.project(row, sk, { ...ps.params, prior: prm.prior });
    if (!pr) { noProj++; continue; }
    const pOver = P.pOverEmp(ps.emp, pr.mu, pl.line);
    const x = row.r[P.STATS[sk].idx];
    if (x === pl.line) continue; // push
    const over = pOver >= 0.5;
    bets.push({ sk, week: row.week, line: pl.line, pOver, conf: over ? pOver : 1 - pOver, over, won: (x > pl.line) === over, actualOver: x > pl.line });
  }
}

const rec = bs => {
  const w = bs.filter(b => b.won).length, l = bs.length - w;
  const net = w * WIN - l * 100;
  return `${(w + '-' + l).padEnd(9)} ${(bs.length ? w / bs.length * 100 : 0).toFixed(1).padStart(5)}%  ROI ${((net / (bs.length * 100 || 1)) * 100).toFixed(1).padStart(6)}%`;
};
console.log(`Props tested: ${bets.length}  (skipped: ${dnp} player didn't play, ${noProj} not enough history)`);
console.log('Break-even at -115 is 53.5%\n');
console.log('All model picks                  ' + rec(bets));
console.log('Baseline: always Under           ' + rec(bets.map(b => ({ ...b, won: !b.actualOver }))));
console.log('Baseline: always Over            ' + rec(bets.map(b => ({ ...b, won: b.actualOver }))));
console.log('\nBy model confidence in its side:');
for (const [lo, hi] of [[0.5, 0.535], [0.535, 0.55], [0.55, 0.58], [0.58, 0.62], [0.62, 1.01]])
  console.log(`  ${(lo * 100).toFixed(1)}-${Math.min(100, hi * 100).toFixed(1)}%`.padEnd(33) + rec(bets.filter(b => b.conf >= lo && b.conf < hi)));
console.log('\nModel picks Over vs Under:');
console.log('  Over picks'.padEnd(33) + rec(bets.filter(b => b.over)));
console.log('  Under picks'.padEnd(33) + rec(bets.filter(b => !b.over)));
console.log('  Under picks, 55%+'.padEnd(33) + rec(bets.filter(b => !b.over && b.conf >= 0.55)));
console.log('  Over picks, 55%+'.padEnd(33) + rec(bets.filter(b => b.over && b.conf >= 0.55)));
console.log('\nBy stat (all picks | 55%+ picks):');
for (const sk of Object.keys(P.STATS)) {
  const bs = bets.filter(b => b.sk === sk);
  console.log(`  ${P.STATS[sk].label}`.padEnd(33) + rec(bs) + '  |  ' + rec(bs.filter(b => b.conf >= 0.55)));
}
console.log('\nBy week (55%+ picks):');
for (const w of [2, 3, 4, 5]) console.log(`  Week ${w}`.padEnd(33) + rec(bets.filter(b => b.week === w && b.conf >= 0.55)));

console.log('\nFiner confidence bands (good stats = receptions, rush yds, rush att, completions):');
const good = new Set(['rec', 'rushYds', 'rushAtt', 'cmp']);
for (const [lo, hi] of [[0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 1.01]]) {
  const bs = bets.filter(b => good.has(b.sk) && b.conf >= lo && b.conf < hi);
  console.log(`  ${(lo * 100).toFixed(0)}-${Math.min(100, hi * 100).toFixed(0)}%`.padEnd(33) + rec(bs));
}
console.log('  55-70%, good stats'.padEnd(33) + rec(bets.filter(b => good.has(b.sk) && b.conf >= 0.55 && b.conf < 0.7)));
console.log('  lines of 0.5-1.5 (alt-style)'.padEnd(33) + rec(bets.filter(b => b.line <= 1.5 && b.sk !== 'passTD')));

// Realistic-chance rule used by the app (trust factors fitted on these same lines, so in-sample)
const TRUST = { rec: 0.45, rushYds: 0.45, rushAtt: 0.45, cmp: 0.45, passTD: 0.3, recYds: 0.1, passYds: 0.1 };
const real = b => 0.5 + TRUST[b.sk] * (b.conf - 0.5);
console.log('\nApp rating rule at -115 (break-even 53.5%):');
console.log('  STRONG (realistic 58%+)'.padEnd(33) + rec(bets.filter(b => real(b) >= 0.58)));
console.log('  LEAN (realistic 55-58%)'.padEnd(33) + rec(bets.filter(b => real(b) >= 0.55 && real(b) < 0.58)));
console.log('  No rating'.padEnd(33) + rec(bets.filter(b => real(b) < 0.55)));
console.log('  avg predicted realistic, STRONG: ' + (bets.filter(b => real(b) >= 0.58).reduce((a, b) => a + real(b), 0) / bets.filter(b => real(b) >= 0.58).length * 100).toFixed(1) + '%');
