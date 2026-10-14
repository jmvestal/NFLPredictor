// LINEMAKER "86% same game parlay": QB alt passing yards + his WR1 (most targets) alt receiving yards,
// when the defense allows 10.5+ yards per completion. Tested on 2021-2026 regular seasons, weeks 4+.
// "His estimate" = QB hit rate x WR hit rate (this + last season), as in the video.
// Usage: node sgp_test.js
const P = require('./props.js');
const prm = require('./props_params.json');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const pct = x => (x * 100).toFixed(1) + '%';
const fair = p => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);

const byGameTeam = {};
for (const r of P.rows) (byGameTeam[r.eid + ':' + r.team] ??= []).push(r);

// defense: yards per completion allowed (and per game) before this week; needs 3+ games
function ypcAllowed(season, team, week) {
  const g = (P.allowed[season + ':' + team] || []).filter(x => x.week < week);
  if (g.length < 3) return null;
  return sum(g, x => x.tot[2]) / sum(g, x => x.tot[0]);
}
// WR1 = most targets for this team this season before this week (players not passing/rushing much)
function wr1(season, team, week) {
  const t = {};
  for (const [pid, l] of Object.entries(P.byPlayer)) for (const h of l)
    if (h.season === season && h.team === team && h.week < week && h.r[1] < 10 && h.r[5] < 5) t[pid] = (t[pid] || 0) + h.r[11];
  return Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
const histRate = (pid, season, week, f, idx, line) => {
  const h = P.byPlayer[pid].filter(x => (x.season === season && x.week < week || x.season === season - 1) && f(x));
  return h.length >= 6 ? sum(h, x => x.r[idx] >= line ? 1 : 0) / h.length : null;
};

const QB_LINES = [175, 200, 225], WR_LINES = [30, 40, 50];
const bets = [];
for (const [k, list] of Object.entries(byGameTeam)) {
  const qb = list.filter(r => r.r[1] >= 10).sort((a, b) => b.r[1] - a.r[1])[0];
  if (!qb || qb.season < 2021 || qb.week < 4 || qb.g.type !== 'REG') continue;
  const ypc = ypcAllowed(qb.season, qb.opp, qb.week);
  if (ypc == null) continue;
  const w1 = wr1(qb.season, qb.team, qb.week);
  if (!w1) continue;
  const wrRow = list.find(r => r.pid === w1); // WR1 must have played (else the parlay is voided/reduced)
  if (!wrRow) continue;
  const prQ = P.project(qb, 'passYds', { ...prm.stats.passYds.params, prior: prm.prior });
  const prW = P.project(wrRow, 'recYds', { ...prm.stats.recYds.params, prior: prm.prior });
  for (const ql of QB_LINES) for (const wl of WR_LINES) {
    const hq = histRate(qb.pid, qb.season, qb.week, x => x.r[1] >= 10, 2, ql), hw = histRate(w1, qb.season, qb.week, x => x.r[11] >= 1, 9, wl);
    if (hq == null || hw == null) continue;
    const mq = prQ ? P.pOverEmp(prm.stats.passYds.emp, prQ.mu, ql - 0.5) : null, mw = prW ? P.pOverEmp(prm.stats.recYds.emp, prW.mu, wl - 0.5) : null;
    bets.push({ season: qb.season, ql, wl, ypc, hq, hw, mq, mw, q: qb.r[2] >= ql, w: wrRow.r[9] >= wl });
  }
}

function report(label, b) {
  if (!b.length) return console.log(`${label}: no bets`);
  const both = sum(b, x => x.q && x.w ? 1 : 0) / b.length, q = sum(b, x => x.q ? 1 : 0) / b.length, w = sum(b, x => x.w ? 1 : 0) / b.length;
  const his = sum(b, x => x.hq * x.hw) / b.length;
  const mb = b.filter(x => x.mq != null && x.mw != null), model = sum(mb, x => x.mq * x.mw) / mb.length;
  console.log(`${label.padEnd(40)} n=${String(b.length).padEnd(5)} QB leg ${pct(q)}  WR leg ${pct(w)}  BOTH ${pct(both)}  (his est ${pct(his)}, our model ${pct(model)}, legs x legs ${pct(q * w)})  fair odds ${fair(both)}`);
}

console.log('===== His exact system: QB 200+ & WR1 40+, defense allows 10.5+ yds/completion =====');
const his = bets.filter(x => x.ql === 200 && x.wl === 40 && x.ypc >= 10.5);
report('All seasons', his);
for (const s of [2021, 2022, 2023, 2024, 2025, 2026]) report(`  ${s}`, his.filter(x => x.season === s));
report('...and both legs 90%+ history (his pick rule)', his.filter(x => x.hq >= 0.9 && x.hw >= 0.9));
report('Same legs, ANY defense (no matchup filter)', bets.filter(x => x.ql === 200 && x.wl === 40));

console.log('\n===== Other line combos, defense 10.5+ yds/completion =====');
for (const ql of QB_LINES) for (const wl of WR_LINES) report(`QB ${ql}+ & WR1 ${wl}+`, bets.filter(x => x.ql === ql && x.wl === wl && x.ypc >= 10.5));

console.log('\n===== Using OUR model instead of past hit rates: both legs 90%+ by the model =====');
for (const ql of QB_LINES) for (const wl of WR_LINES) {
  const b = bets.filter(x => x.ql === ql && x.wl === wl && x.mq != null && x.mw != null && x.mq * x.mw >= 0.8);
  report(`QB ${ql}+ & WR1 ${wl}+, model parlay 80%+`, b);
}
console.log('\nHis video example price: -358 (78.2% break-even). Typical SGP pricing builds in correlation, so real prices vary.');
