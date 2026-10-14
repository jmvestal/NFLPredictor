// Which games should we pick / skip? Groups the upgraded model's picks by confidence and by
// distance from the betting line, and checks each group in 3 separate periods.
// Usage: node picks.js
const { ALL, ratings, predict, ORIGINAL, profit, mlToProb } = require('./model2.js');

const CFG = { ...ORIGINAL, prevGames: 4, qbPen: 3 };
const PERIODS = [['2021-23', [2021, 2022, 2023]], ['2024-25', [2024, 2025]], ['2026', [2026]], ['ALL', [2021, 2022, 2023, 2024, 2025, 2026]]];

// QB penalty uses the actual starter (as the user would tick the box before kickoff)
const rows = [];
const cache = {};
for (const g of ALL) {
  if (g.season < 2021 || g.week < 2) continue;
  const R = cache[g.season + ':' + g.week] ??= ratings(g.season, g.week, CFG);
  const p = predict(R, g, CFG);
  if (!p) continue;
  const act = g.hs - g.as, tot = g.hs + g.as;
  const row = { g, p, act, tot };
  if (g.hml != null && g.aml != null) {
    const ih = mlToProb(g.hml), ia = mlToProb(g.aml);
    row.mk = ih / (ih + ia);
  }
  rows.push(row);
}

function newRec() { return { w: 0, l: 0, net: 0 }; }
function add(r, won, odds) { if (won) { r.w++; r.net += profit(odds); } else { r.l++; r.net -= 100; } }
const fmt = r => r.w + r.l === 0 ? '—'.padEnd(26) :
  `${(r.w + '-' + r.l).padEnd(8)} ${(r.w / (r.w + r.l) * 100).toFixed(1).padStart(5)}% ${((r.net >= 0 ? '+' : '') + (r.net / ((r.w + r.l) * 100) * 100).toFixed(1) + '%').padStart(7)}`;

function table(title, buckets, test) {
  console.log(`\n### ${title}`);
  console.log(''.padEnd(28) + PERIODS.map(([n]) => n.padEnd(28)).join(''));
  for (const [label, fn] of buckets) {
    const cells = PERIODS.map(([, seasons]) => {
      const r = newRec();
      for (const row of rows) if (seasons.includes(row.g.season) && fn(row)) test(row, r);
      return fmt(r).padEnd(28);
    });
    console.log(label.padEnd(28) + cells.join(''));
  }
}

// ---- 1. Picking winners (moneyline on model's pick) by model confidence ----
const conf = row => Math.max(row.p.pHome, 1 - row.p.pHome);
const mlPick = (row, r) => {
  if (row.mk == null || row.act === 0) return;
  const h = row.p.pHome >= 0.5;
  add(r, (row.act > 0) === h, h ? row.g.hml : row.g.aml);
};
table('WINNERS: moneyline on the model\'s pick, by how confident the model is  [record, win%, ROI]', [
  ['All games', () => true],
  ['Model 50-55% (toss-up)', r => conf(r) < 0.55],
  ['Model 55-60%', r => conf(r) >= 0.55 && conf(r) < 0.6],
  ['Model 60-65%', r => conf(r) >= 0.6 && conf(r) < 0.65],
  ['Model 65-70%', r => conf(r) >= 0.65 && conf(r) < 0.7],
  ['Model 70%+', r => conf(r) >= 0.7],
], mlPick);

// ---- 2. Agree vs disagree with Vegas on the winner ----
const agree = r => r.mk != null && (r.p.pHome >= 0.5) === (r.mk >= 0.5);
table('WINNERS: does the model agree with Vegas on who wins?', [
  ['Agrees with Vegas fav', r => agree(r)],
  ['  ...and model 60%+', r => agree(r) && conf(r) >= 0.6],
  ['  ...and model under 60%', r => agree(r) && conf(r) < 0.6],
  ['Disagrees (picks the dog)', r => r.mk != null && !agree(r)],
], mlPick);

// ---- 3. Moneyline "edge" vs the book ----
const edge = r => r.mk == null ? null : Math.abs(r.p.pHome - r.mk);
const edgeBet = (row, r) => {
  if (row.mk == null || row.act === 0) return;
  const h = row.p.pHome > row.mk;
  add(r, (row.act > 0) === h, h ? row.g.hml : row.g.aml);
};
table('MONEYLINE VALUE: bet the side the model rates higher than the book, by size of edge', [
  ['Edge 0-3%', r => edge(r) != null && edge(r) < 0.03],
  ['Edge 3-6%', r => edge(r) >= 0.03 && edge(r) < 0.06],
  ['Edge 6-10%', r => edge(r) >= 0.06 && edge(r) < 0.1],
  ['Edge 10%+', r => edge(r) >= 0.1],
  ['  edge on favorite only', r => edge(r) != null && (r.p.pHome > r.mk) === (r.mk >= 0.5)],
  ['  edge on underdog only', r => edge(r) != null && (r.p.pHome > r.mk) !== (r.mk >= 0.5)],
], edgeBet);

// ---- 4. Spread: distance between model margin and the line ----
const sgap = r => r.g.spread == null ? null : Math.abs(r.p.margin - r.g.spread);
const atsBet = (row, r) => {
  const g = row.g; if (g.spread == null || row.act === g.spread) return;
  const h = row.p.margin > g.spread;
  add(r, (row.act > g.spread) === h, h ? g.hso : g.aso);
};
table('SPREAD: model margin vs the line  (52.4% = break-even)', [
  ['Gap under 1 pt', r => sgap(r) != null && sgap(r) < 1],
  ['Gap 1-2 pts', r => sgap(r) >= 1 && sgap(r) < 2],
  ['Gap 2-3 pts', r => sgap(r) >= 2 && sgap(r) < 3],
  ['Gap 3-5 pts', r => sgap(r) >= 3 && sgap(r) < 5],
  ['Gap 5-7 pts', r => sgap(r) >= 5 && sgap(r) < 7],
  ['Gap 7+ pts', r => sgap(r) >= 7],
  ['Model on favorite side', r => sgap(r) != null && (r.p.margin > r.g.spread) === (r.g.spread > 0)],
  ['Model on underdog side', r => sgap(r) != null && (r.p.margin > r.g.spread) !== (r.g.spread > 0)],
  ['Underdog side, gap 2-5', r => sgap(r) >= 2 && sgap(r) < 5 && (r.p.margin > r.g.spread) !== (r.g.spread > 0)],
  ['Home dog / road fav cover?', r => sgap(r) != null && r.g.spread < 0 && r.p.margin > r.g.spread],
], atsBet);

// ---- 5. Totals ----
const tgap = r => r.g.tl == null ? null : Math.abs(r.p.total - r.g.tl);
const ouBet = (row, r) => {
  const g = row.g; if (g.tl == null || row.tot === g.tl) return;
  const over = row.p.total > g.tl;
  add(r, (row.tot > g.tl) === over, over ? g.oo : g.uo);
};
table('OVER/UNDER: model total vs the line', [
  ['Gap under 2 pts', r => tgap(r) != null && tgap(r) < 2],
  ['Gap 2-4 pts', r => tgap(r) >= 2 && tgap(r) < 4],
  ['Gap 4-7 pts', r => tgap(r) >= 4 && tgap(r) < 7],
  ['Gap 7+ pts', r => tgap(r) >= 7],
  ['Model says Over', r => tgap(r) != null && r.p.total > r.g.tl],
  ['Model says Under', r => tgap(r) != null && r.p.total < r.g.tl],
  ['Under, gap 3+', r => tgap(r) >= 3 && r.p.total < r.g.tl],
  ['Over, gap 3+', r => tgap(r) >= 3 && r.p.total > r.g.tl],
], ouBet);

// ---- 6. Timing: week of season, for the model's winner picks ----
table('WINNERS by part of season', [
  ['Weeks 2-5', r => r.g.type === 'REG' && r.g.week <= 5],
  ['Weeks 6-10', r => r.g.type === 'REG' && r.g.week >= 6 && r.g.week <= 10],
  ['Weeks 11-18', r => r.g.type === 'REG' && r.g.week >= 11],
  ['Weeks 6+ & agrees & 60%+', r => r.g.week >= 6 && agree(r) && conf(r) >= 0.6],
  ['Thursday games', r => r.g.raw.weekday === 'Thursday'],
], mlPick);
