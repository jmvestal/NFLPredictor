// Season-by-season replication of the three LINEMAKER SPORTS NFL systems (2021-2026), with profit at the
// price range he quotes. Historical alt-line prices aren't available, so results are shown at fixed prices.
//  System 1 (video "NFL bet that wins 92%"): RB alt rushing 30+. Opponent allows 4.0+ yds/carry, RB averages 14+ carries,
//     RB hit 30+ in 90%+ of his games over the last two seasons ("true probability"). Example price: -400.
//  System 2 (video "NFL bet that almost never loses (90%)"): QB 1+ passing TD. QB hit 1+ TD in 90%+ of last season's
//     games (same team), opponent allows 1.5+ pass TD/game. Example price: -480.
//  System 3 (video "NFL pick that wins 85%"): RB alt rushing ladder. Opponent allows 4.5+ yds/carry and ranks 23rd or
//     worse in rush yds allowed per game; RB average carries; rungs 30+ to 80+. Example price: 30+ at 86% (about -614).
// Usage: node linemaker_seasons.js
const P = require('./props.js');
const SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const pct = x => (x * 100).toFixed(1) + '%';
const profit100 = odds => odds > 0 ? odds : 10000 / -odds; // win on a $100 stake
const be = odds => odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);

function defAllowed(season, team, beforeWeek) {
  const games = (P.allowed[season + ':' + team] || []).filter(x => x.week < beforeWeek);
  if (games.length < 3) return null;
  const t = i => sum(games, x => x.tot[i]);
  return { passTDpg: t(3) / games.length, ypc: t(6) / t(5), rushYdsPg: t(6) / games.length };
}
const rankCache = {};
function rushRank(season, team, beforeWeek) { // 32 = allows the most rush yds/game
  const key = season + ':' + beforeWeek;
  rankCache[key] ??= (() => {
    const teams = [...new Set(Object.keys(P.allowed).filter(k => k.startsWith(season + ':')).map(k => k.split(':')[1]))];
    return teams.map(t => [t, defAllowed(season, t, beforeWeek)?.rushYdsPg]).filter(x => x[1] != null).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  })();
  return rankCache[key].indexOf(team) + 1;
}
const isRB = r => r.r[5] >= 3 && r.r[1] < 10;

// ---------- System 1 ----------
const s1 = [];
for (const row of P.rows) {
  if (row.season < 2021 || row.week < 4 || row.g.type !== 'REG' || !(row.r[5] > 0) || row.r[1] >= 10) continue;
  const hist = P.byPlayer[row.pid].filter(h => (h.season === row.season && h.week < row.week || h.season === row.season - 1) && isRB(h));
  const cur = hist.filter(h => h.season === row.season);
  if (cur.length < 3 || hist.length < 6 || sum(cur, h => h.r[5]) / cur.length < 14) continue;
  const d = defAllowed(row.season, row.opp, row.week);
  if (!d || d.ypc < 4.0) continue;
  const rate = sum(hist, h => h.r[6] >= 30 ? 1 : 0) / hist.length;
  if (rate < 0.9) continue;
  s1.push({ season: row.season, est: rate, win: row.r[6] >= 30 });
}

// ---------- System 2 ----------
const byGameTeam = {};
for (const r of P.rows) (byGameTeam[r.eid + ':' + r.team] ??= []).push(r);
const s2 = [];
for (const list of Object.values(byGameTeam)) {
  const row = list.filter(r => r.r[1] >= 10).sort((a, b) => b.r[1] - a.r[1])[0];
  if (!row || row.season < 2021 || row.week < 4 || row.g.type !== 'REG') continue;
  const last = P.byPlayer[row.pid].filter(h => h.season === row.season - 1 && h.team === row.team && h.r[1] >= 10);
  if (last.length < 8) continue;
  const rate = sum(last, h => h.r[3] >= 1 ? 1 : 0) / last.length;
  if (rate < 0.9) continue;
  const d = defAllowed(row.season, row.opp, row.week);
  if (!d || d.passTDpg < 1.5) continue;
  s2.push({ season: row.season, est: rate, win: row.r[3] >= 1 });
}

// ---------- System 3 (ladder) ----------
const RUNGS = [30, 40, 50, 60, 70, 80];
const s3 = [];
for (const row of P.rows) {
  if (row.season < 2021 || row.week < 4 || row.g.type !== 'REG' || !(row.r[5] > 0) || row.r[1] >= 10) continue;
  const cur = P.byPlayer[row.pid].filter(h => h.season === row.season && h.week < row.week && isRB(h));
  if (cur.length < 3) continue;
  const carries = sum(cur, h => h.r[5]) / cur.length;
  if (carries < 12) continue; // a lead back
  const d = defAllowed(row.season, row.opp, row.week);
  if (!d || d.ypc < 4.5 || rushRank(row.season, row.opp, row.week) < 23) continue;
  const hist = P.byPlayer[row.pid].filter(h => (h.season === row.season && h.week < row.week || h.season === row.season - 1) && isRB(h));
  s3.push({ season: row.season, yds: row.r[6], ceiling: carries * d.ypc, rate: t => sum(hist, h => h.r[6] >= t ? 1 : 0) / hist.length });
}

// ---------- report ----------
function seasonTable(name, bets, prices) {
  console.log(`\n===== ${name} =====`);
  console.log('Season  Bets  Won   Win%    Their est.  ' + prices.map(p => `Profit @${p}`.padStart(13)).join(''));
  for (const s of [...SEASONS, 'ALL']) {
    const b = s === 'ALL' ? bets : bets.filter(x => x.season === s);
    if (!b.length) continue;
    const w = sum(b, x => x.win ? 1 : 0), l = b.length - w;
    const cells = prices.map(p => { const net = w * profit100(p) - l * 100; return ((net >= 0 ? '+$' : '-$') + Math.abs(net).toFixed(0)).padStart(13); });
    console.log(`${String(s).padEnd(8)}${String(b.length).padEnd(6)}${String(w).padEnd(6)}${pct(w / b.length).padEnd(8)}${pct(sum(b, x => x.est) / b.length).padEnd(12)}${cells.join('')}`);
  }
  console.log('Break-even win% at those prices: ' + prices.map(p => `${p} = ${pct(be(p))}`).join(', ') + '   ($100 per bet)');
}
seasonTable('System 1: RB 30+ rushing yards (his example price -400)', s1, [-400, -500, -600, -800]);
seasonTable('System 2: QB 1+ passing TD (his example price -480)', s2, [-400, -480, -600, -800]);

console.log('\n===== System 3: RB rushing ladder vs bad run defenses (actual hit rate at each rung) =====');
console.log('Season  Games  ' + RUNGS.map(t => `${t}+`.padStart(8)).join('') + '   his "true prob" at 30+');
for (const s of [...SEASONS, 'ALL']) {
  const b = s === 'ALL' ? s3 : s3.filter(x => x.season === s);
  if (!b.length) continue;
  console.log(`${String(s).padEnd(8)}${String(b.length).padEnd(7)}` + RUNGS.map(t => pct(sum(b, x => x.yds >= t ? 1 : 0) / b.length).padStart(8)).join('') +
    `   ${pct(sum(b, x => x.rate(30)) / b.length)}`);
}
console.log('His CMC example priced 30+ at 86% (about -614); break-even there is 86%.');
// his exact pick rule: the rung with the biggest (history rate - price) gap needs prices; show how often the history
// rate at 30+ overstated vs understated the actual result
const over = s3.filter(x => x.rate(30) >= 0.9);
console.log(`Backs with a 90%+ history at 30+: ${over.length} games, actual 30+ rate ${pct(sum(over, x => x.yds >= 30 ? 1 : 0) / over.length)}`);
