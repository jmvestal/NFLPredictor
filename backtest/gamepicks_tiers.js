// Does our model add information on top of the Vegas favorite? Win rate of the Vegas favorite,
// by how strong the favorite is (no-vig moneyline %) and whether our model agrees. 2021-2026, weeks 2+.
const { ALL, mlToProb } = require('./model2.js');
const { predict } = require('./gamepicks.js');
const MODEL = { decay: 1, adj: 0, w: 1, tw: 1, sd: 13.5 }; // the app's model
const rows = [];
for (const g of ALL) {
  if (g.season < 2021 || g.week < 2 || g.hml == null || g.aml == null || g.hs === g.as) continue;
  const p = predict(g, MODEL); if (!p) continue;
  const ih = mlToProb(g.hml), ia = mlToProb(g.aml), vH = ih / (ih + ia), favHome = vH >= 0.5, vFav = Math.max(vH, 1 - vH);
  const mFav = favHome ? p.pHome : 1 - p.pHome; // model's chance for the Vegas favorite
  rows.push({ season: g.season, vFav, mFav, won: (g.hs > g.as) === favHome });
}
const pct = x => (x * 100).toFixed(1) + '%';
const bands = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 1.01]];
console.log('Vegas favorite strength | fav wins | ...model agrees (60%+ on fav) | ...model lukewarm (50-60%) | ...model disagrees');
for (const [lo, hi] of bands) {
  const b = rows.filter(r => r.vFav >= lo && r.vFav < hi);
  const f = (x) => x.length ? `${pct(x.filter(r => r.won).length / x.length)} (${x.length})` : '—';
  console.log(`${(lo * 100).toFixed(0)}-${Math.min(100, hi * 100).toFixed(0)}%`.padEnd(24) + '| ' + f(b).padEnd(13) + '| ' + f(b.filter(r => r.mFav >= 0.6)).padEnd(29) + '| ' + f(b.filter(r => r.mFav >= 0.5 && r.mFav < 0.6)).padEnd(27) + '| ' + f(b.filter(r => r.mFav < 0.5)));
}
// same split, separately for 2021-23 and 2024-26, to see if it holds
for (const [nm, ss] of [['2021-23', [2021, 2022, 2023]], ['2024-26', [2024, 2025, 2026]]]) {
  const r = rows.filter(x => ss.includes(x.season));
  const f = x => `${pct(x.filter(q => q.won).length / x.length)} (${x.length})`;
  console.log(`${nm}: Vegas fav overall ${f(r)} | model agrees 60%+ ${f(r.filter(q => q.mFav >= 0.6))} | lukewarm ${f(r.filter(q => q.mFav >= 0.5 && q.mFav < 0.6))} | disagrees ${f(r.filter(q => q.mFav < 0.5))}`);
}
