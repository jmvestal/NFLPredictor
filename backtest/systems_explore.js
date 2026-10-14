// Searches for "high-probability" QB and WR/TE prop systems in the style of the LINEMAKER RB system:
// an easy threshold + filters (player history, our model's estimate, volume, opponent). Rules are chosen on
// 2021-23 only, then checked season by season on 2024, 2025, 2026 (unseen).
// Usage: node systems_explore.js
const P = require('./props.js');
const prm = require('./props_params.json');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const pct = x => (x * 100).toFixed(1) + '%';
const fairOdds = p => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);

// candidate markets: stat, thresholds, who qualifies, volume measure
const MARKETS = [
  { name: 'QB 1+ passing TD', sk: 'passTD', idx: 3, ts: [1], role: r => r.r[1] >= 10, vol: r => r.r[1] },
  { name: 'QB passing yards', sk: 'passYds', idx: 2, ts: [150, 175, 200], role: r => r.r[1] >= 10, vol: r => r.r[1] },
  { name: 'QB completions', sk: 'cmp', idx: 0, ts: [12, 15, 18], role: r => r.r[1] >= 10, vol: r => r.r[1] },
  { name: 'WR/TE receptions', sk: 'rec', idx: 8, ts: [2, 3, 4], role: r => r.r[11] >= 1 && r.r[5] < 3 && r.r[1] < 10, vol: r => r.r[11] },
  { name: 'WR/TE receiving yards', sk: 'recYds', idx: 9, ts: [20, 30, 40], role: r => r.r[11] >= 1 && r.r[5] < 3 && r.r[1] < 10, vol: r => r.r[11] },
  { name: 'RB rushing yards (his System 1)', sk: 'rushYds', idx: 6, ts: [30, 40], role: r => r.r[5] >= 3 && r.r[1] < 10, vol: r => r.r[5] },
];

// build candidate bets: one per (player-game, threshold)
const cands = [];
for (const m of MARKETS) {
  const ps = prm.stats[m.sk];
  for (const row of P.rows) {
    if (row.season < 2021 || row.week < 4 || row.g.type !== 'REG' || !m.role(row)) continue;
    const hist = P.byPlayer[row.pid].filter(h => (h.season === row.season && h.week < row.week || h.season === row.season - 1) && m.role(h));
    const cur = hist.filter(h => h.season === row.season);
    if (cur.length < 3 || hist.length < 6) continue;
    const vol = sum(cur, m.vol) / cur.length;
    const opp = P.oppFactor(row.season, row.week, row.opp, m.idx);
    const pr = P.project(row, m.sk, { ...ps.params, prior: prm.prior });
    if (!pr) continue;
    for (const t of m.ts) {
      cands.push({ m, t, season: row.season, vol, opp,
        hist: sum(hist, h => h.r[m.idx] >= t ? 1 : 0) / hist.length,
        model: P.pOverEmp(ps.emp, pr.mu, t - 0.5),
        win: row.r[m.idx] >= t });
    }
  }
}

const TRAIN = [2021, 2022, 2023];
const report = (label, bets) => {
  const by = s => bets.filter(b => b.season === s);
  const cell = s => { const b = by(s); return b.length ? `${pct(sum(b, x => x.win) / b.length)} (${b.length})`.padEnd(15) : '—'.padEnd(15); };
  const test = bets.filter(b => !TRAIN.includes(b.season));
  const testRate = test.length ? sum(test, x => x.win) / test.length : 0;
  console.log(`  ${label.padEnd(58)} train ${pct(sum(bets.filter(b => TRAIN.includes(b.season)), x => x.win) / Math.max(1, bets.filter(b => TRAIN.includes(b.season)).length)).padEnd(7)} | 2024 ${cell(2024)} 2025 ${cell(2025)} 2026 ${cell(2026)} | test ${pct(testRate)} → fair odds ${fairOdds(testRate)}`);
};

for (const m of MARKETS) {
  console.log(`\n===== ${m.name} =====`);
  for (const t of m.ts) {
    const pool = cands.filter(c => c.m === m && c.t === t);
    // grid of filters, chosen on TRAIN: maximize hit rate with at least ~25 bets per training season
    let best = null;
    for (const h of [0, 0.85, 0.9, 0.95]) for (const md of [0, 0.8, 0.85, 0.9, 0.93]) for (const op of [0, 1.0, 1.05, 1.1])
      for (const vq of [0, 0.5, 0.75]) {
        const vols = pool.map(c => c.vol).sort((a, b) => a - b);
        const vmin = vols[Math.floor(vols.length * vq)] || 0;
        const f = c => c.hist >= h && c.model >= md && c.opp >= op && c.vol >= vmin;
        const tr = pool.filter(c => TRAIN.includes(c.season) && f(c));
        if (tr.length < 75) continue;
        const rate = sum(tr, x => x.win) / tr.length;
        if (!best || rate > best.rate) best = { rate, f, desc: `hist≥${h} model≥${md} opp≥${op} vol≥${vmin.toFixed(1)}` };
      }
    report(`${t}+ (no filters)`, pool);
    if (best) report(`${t}+ best rule [${best.desc}]`, pool.filter(best.f));
  }
}
