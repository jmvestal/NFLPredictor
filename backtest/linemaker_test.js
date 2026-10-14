// Tests the "high-probability prop" strategies from the LINEMAKER SPORTS YouTube channel on 2021-2026 games:
//  A) QB 1+ passing TD: QB hit 1+ TD in 90%+ of last season's games (same team), opponent allows 1.5+ pass TD/game.
//  B) RB alt rushing yards (30+/40+/50+): opponent allows 4.5+ yards/carry and ranks 23rd+ in rush yds allowed,
//     RB averages 14+ carries; "true probability" = his hit rate at that threshold over the last two seasons.
// Their claim: the past hit rate is the true chance, so bet when it beats the price (e.g. -400 = 80%).
// Usage: node linemaker_test.js
const P = require('./props.js');
const prm = require('./props_params.json');

const pct = x => (x * 100).toFixed(1) + '%';
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

// ----- per team-game: who started at QB (most pass attempts), plus team totals allowed -----
const byGameTeam = {};
for (const r of P.rows) (byGameTeam[r.eid + ':' + r.team] ??= []).push(r);
const starterQB = {}; // eid:team -> row
for (const [k, list] of Object.entries(byGameTeam)) {
  const qb = list.filter(r => r.r[1] > 0).sort((a, b) => b.r[1] - a.r[1])[0];
  if (qb && qb.r[1] >= 10) starterQB[k] = qb;
}
// what each defense allowed, by season & week (idx: 3 passTD, 5 rushAtt, 6 rushYds)
function defAllowed(season, team, beforeWeek) {
  const games = (P.allowed[season + ':' + team] || []).filter(x => x.week < beforeWeek);
  if (games.length < 3) return null;
  const t = i => sum(games, x => x.tot[i]);
  return { gp: games.length, passTDpg: t(3) / games.length, ypc: t(6) / t(5), rushYdsPg: t(6) / games.length };
}
function rushRank(season, team, beforeWeek) { // 1 = allows the fewest rush yards per game
  const teams = [...new Set(Object.keys(P.allowed).filter(k => k.startsWith(season + ':')).map(k => k.split(':')[1]))];
  const vals = teams.map(t => [t, defAllowed(season, t, beforeWeek)?.rushYdsPg]).filter(x => x[1] != null).sort((a, b) => a[1] - b[1]);
  return vals.findIndex(x => x[0] === team) + 1;
}

// ===== A) QB 1+ passing TD =====
const qbBets = [];
for (const [k, row] of Object.entries(starterQB)) {
  if (row.week < 2 || row.g.type !== 'REG') continue;
  // last season, same team, as the starter
  const last = P.byPlayer[row.pid].filter(h => h.season === row.season - 1 && h.team === row.team && h.r[1] >= 10);
  if (last.length < 8) continue;
  const hist = sum(last, h => h.r[3] >= 1 ? 1 : 0) / last.length;
  if (hist < 0.9) continue;
  const d = defAllowed(row.season, row.opp, row.week);
  if (!d || d.passTDpg < 1.5) continue;
  // our model's chance of 1+ TD (line 0.5)
  const ps = prm.stats.passTD, pr = P.project(row, 'passTD', { ...ps.params, prior: prm.prior });
  qbBets.push({ row, hist, hit: row.r[3] >= 1 ? 1 : 0, model: pr ? P.pOverEmp(ps.emp, pr.mu, 0.5) : null });
}
// baseline: every starting QB, no filters
const allQB = Object.values(starterQB).filter(r => r.week >= 2 && r.g.type === 'REG');

console.log('===== A) QB 1+ passing TD (their filters: 90%+ last season, opponent allows 1.5+ pass TD/g) =====');
console.log(`Qualifying bets: ${qbBets.length}`);
console.log(`Their "true probability" (last-season hit rate): avg ${pct(sum(qbBets, b => b.hist) / qbBets.length)}`);
console.log(`ACTUAL hit rate:                                 ${pct(sum(qbBets, b => b.hit) / qbBets.length)}`);
const mb = qbBets.filter(b => b.model != null);
console.log(`Our model's average estimate for the same bets:  ${pct(sum(mb, b => b.model) / mb.length)}`);
console.log(`All starting QBs, no filters:                    ${pct(sum(allQB, r => r.r[3] >= 1 ? 1 : 0) / allQB.length)}  (n=${allQB.length})`);
for (const s of [2021, 2022, 2023, 2024, 2025, 2026]) {
  const b = qbBets.filter(x => x.row.season === s);
  if (b.length) console.log(`  ${s}: ${sum(b, x => x.hit)}/${b.length} = ${pct(sum(b, x => x.hit) / b.length)}`);
}
console.log('Break-even at their example prices: -400 = 80.0%, -480 = 82.8%, -500 = 83.3%');

// ===== B) RB alternate rushing yards =====
console.log('\n===== B) RB alt rushing yards (opp 4.5+ YPC allowed & 23rd+ in rush yds allowed, RB 14+ carries/game) =====');
const rbBets = [];
for (const row of P.rows) {
  if (row.season < 2021 || row.week < 4 || row.g.type !== 'REG' || row.r[1] >= 10) continue; // skip QBs; need a few weeks of defense data
  const hist = P.byPlayer[row.pid].filter(h => (h.season === row.season && h.week < row.week || h.season === row.season - 1) && h.r[5] >= 3 && h.r[1] < 10);
  const cur = hist.filter(h => h.season === row.season);
  if (cur.length < 3 || hist.length < 6) continue;
  const carries = sum(cur, h => h.r[5]) / cur.length;
  if (carries < 14) continue;
  const d = defAllowed(row.season, row.opp, row.week);
  if (!d || d.ypc < 4.5 || rushRank(row.season, row.opp, row.week) < 23) continue;
  const ps = prm.stats.rushYds, pr = P.project(row, 'rushYds', { ...ps.params, prior: prm.prior });
  rbBets.push({ row, hist, carries, ceiling: carries * d.ypc, pr, ps });
}
console.log(`Qualifying RB games: ${rbBets.length}`);
console.log('Threshold | their "true prob" (2-season hit rate) | ACTUAL | our model | break-even prices they cite');
for (const t of [30, 40, 50, 60]) {
  const histRate = sum(rbBets, b => sum(b.hist, h => h.r[6] >= t ? 1 : 0) / b.hist.length) / rbBets.length;
  const actual = sum(rbBets, b => b.row.r[6] >= t ? 1 : 0) / rbBets.length;
  const model = sum(rbBets.filter(b => b.pr), b => P.pOverEmp(b.ps.emp, b.pr.mu, t - 0.5)) / rbBets.filter(b => b.pr).length;
  console.log(`  ${t}+ yds  | ${pct(histRate).padStart(6)}                                | ${pct(actual).padStart(6)} | ${pct(model).padStart(6)}`);
}
// their exact selection rule: only bets where the 2-season hit rate is 90%+ at 30+
const sel = rbBets.filter(b => sum(b.hist, h => h.r[6] >= 30 ? 1 : 0) / b.hist.length >= 0.9);
console.log(`Only RBs who hit 30+ in 90%+ of the last two seasons' games: n=${sel.length}, their est ${pct(sum(sel, b => sum(b.hist, h => h.r[6] >= 30 ? 1 : 0) / b.hist.length) / sel.length)}, ACTUAL ${pct(sum(sel, b => b.row.r[6] >= 30 ? 1 : 0) / sel.length)}`);
console.log('(Games the RB missed entirely are excluded, as voided bets. Games where he got hurt early count as losses, as they would at a sportsbook.)');
