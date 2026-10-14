// Fixed (not searched) QB and WR/TE "high-probability" systems using the Vegas-aware props model, season by season.
// The model's own estimate is the "true probability" (it was calibrated; past hit rates ran 5-10 pts high).
// Usage: node systems_qbwr.js
const P = require('./props.js');
const prm = require('./props_params.json');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const pct = x => (x * 100).toFixed(1) + '%';
const fair = p => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];

function defAllowed(season, team, beforeWeek) {
  const games = (P.allowed[season + ':' + team] || []).filter(x => x.week < beforeWeek);
  if (games.length < 3) return null;
  return { passTDpg: sum(games, x => x.tot[3]) / games.length };
}

const isQB = r => r.r[1] >= 10, isRec = r => (r.r[11] >= 1 || r.r[8] >= 1) && r.r[5] < 3 && r.r[1] < 10;
const bets = { qbModel: [], qbHisPlusModel: [], qbHis: [], wr3: [], wr4: [], wr2: [] };
for (const row of P.rows) {
  if (row.season < 2021 || row.week < 4 || row.g.type !== 'REG') continue;
  if (isQB(row)) {
    const ps = prm.stats.passTD, pr = P.project(row, 'passTD', { ...ps.params, prior: prm.prior });
    if (!pr) continue;
    const model = P.pOverEmp(ps.emp, pr.mu, 0.5), win = row.r[3] >= 1;
    const last = P.byPlayer[row.pid].filter(h => h.season === row.season - 1 && h.team === row.team && h.r[1] >= 10);
    const hist = last.length >= 8 ? sum(last, h => h.r[3] >= 1 ? 1 : 0) / last.length : 0;
    const d = defAllowed(row.season, row.opp, row.week);
    const his = hist >= 0.9 && d && d.passTDpg >= 1.5;
    if (model >= 0.85) bets.qbModel.push({ season: row.season, est: model, win });
    if (his) bets.qbHis.push({ season: row.season, est: model, win });
    if (his && model >= 0.85) bets.qbHisPlusModel.push({ season: row.season, est: model, win });
  } else if (isRec(row)) {
    const ps = prm.stats.rec, pr = P.project(row, 'rec', { ...ps.params, prior: prm.prior });
    if (!pr) continue;
    const hist = P.byPlayer[row.pid].filter(h => (h.season === row.season && h.week < row.week || h.season === row.season - 1) && isRec(h));
    if (hist.length < 6) continue;
    for (const [t, key] of [[2, 'wr2'], [3, 'wr3'], [4, 'wr4']]) {
      const model = P.pOverEmp(ps.emp, pr.mu, t - 0.5);
      const hr = sum(hist, h => h.r[8] >= t ? 1 : 0) / hist.length;
      if (model >= 0.85 && hr >= 0.85) bets[key].push({ season: row.season, est: model, win: row.r[8] >= t });
    }
  }
}

function table(name, b) {
  console.log(`\n===== ${name} =====`);
  console.log('Season  Bets  Win%     Model est.  Fair odds of actual');
  for (const s of [...SEASONS, 'ALL']) {
    const x = s === 'ALL' ? b : b.filter(v => v.season === s);
    if (!x.length) continue;
    const r = sum(x, v => v.win) / x.length;
    console.log(`${String(s).padEnd(8)}${String(x.length).padEnd(6)}${pct(r).padEnd(9)}${pct(sum(x, v => v.est) / x.length).padEnd(12)}${fair(r)}`);
  }
}
table("QB 1+ TD: HIS rules only (90%+ last season, opp allows 1.5+ TD/g)", bets.qbHis);
table('QB 1+ TD: OUR model 85%+ (uses Vegas team total)', bets.qbModel);
table('QB 1+ TD: his rules AND our model 85%+', bets.qbHisPlusModel);
table('WR/TE 2+ receptions: model 85%+ and hit it in 85%+ of last 2 seasons', bets.wr2);
table('WR/TE 3+ receptions: model 85%+ and hit it in 85%+ of last 2 seasons', bets.wr3);
table('WR/TE 4+ receptions: model 85%+ and hit it in 85%+ of last 2 seasons', bets.wr4);
console.log('\nNote: a receiver who played but had 0 targets is missing from ESPN box scores, so WR hit rates may read ~1 pt high.');
