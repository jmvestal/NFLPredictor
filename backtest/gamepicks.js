// Accuracy work on the GAME model (the user's PPP model + last-season blend + backup-QB penalty).
// Tests, each switchable:
//   decay - recent games count more (weight multiplier per game back, 1 = all games equal)
//   adj   - strength of schedule: credit offenses that faced good defenses (and vice versa), 0 = off
//   w     - weight on our model vs the Vegas spread for the margin (1 = model only, 0 = Vegas only)
//   tw    - same for the game total
//   sd    - spread of outcomes used to turn a margin into a win %
// Tuned on 2021-23, checked on 2024, 2025, 2026 (unseen).  Usage: node gamepicks.js
const { ALL } = require('./model2.js');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// team-game records
const TG = {}; // season:team -> [{week, opp, pts, ptsAg, op, dp, qb}]
for (const g of ALL) {
  if (g.type !== 'REG' && g.season === g.season) { /* playoffs still count as games played */ }
  for (const [me, op, ms, os, mp, opp, qb] of [[g.home, g.away, g.hs, g.as, g.hb.plays, g.ab.plays, g.hqb], [g.away, g.home, g.as, g.hs, g.ab.plays, g.hb.plays, g.aqb]])
    (TG[g.season + ':' + me] ??= []).push({ week: g.week, type: g.type, opp: op, pts: ms, ptsAg: os, op: mp, dp: opp, qb });
}
for (const l of Object.values(TG)) l.sort((a, b) => a.week - b.week);
const prevTot = {}; // season:team -> per-game averages over the regular season
for (const [k, l] of Object.entries(TG)) {
  const reg = l.filter(x => x.type === 'REG');
  if (!reg.length) continue;
  prevTot[k] = { pts: sum(reg, x => x.pts) / reg.length, ptsAg: sum(reg, x => x.ptsAg) / reg.length, op: sum(reg, x => x.op) / reg.length, dp: sum(reg, x => x.dp) / reg.length };
}

const rcache = {};
function ratings(s, week, o) {
  const key = `${s}:${week}:${o.decay}:${o.adj}`;
  if (rcache[key]) return rcache[key];
  const teams = [...new Set(Object.keys(TG).filter(k => k.startsWith(s + ':')).map(k => k.split(':')[1]))];
  const R = {};
  let lgPts = 0, lgOp = 0;
  for (const t of teams) {
    const cur = (TG[s + ':' + t] || []).filter(x => x.week < week);
    const p = prevTot[(s - 1) + ':' + t], G = p ? 4 : 0;
    let w = 1, sw = 0, pts = 0, ptsAg = 0, op = 0, dp = 0;
    const games = [];
    for (let i = cur.length - 1; i >= 0; i--) { // most recent first
      const x = cur[i];
      sw += w; pts += w * x.pts; ptsAg += w * x.ptsAg; op += w * x.op; dp += w * x.dp;
      games.push({ opp: x.opp, w, op: x.op, dp: x.dp });
      w *= o.decay;
    }
    const curOp = op, curDp = dp;
    if (G) { pts += G * p.pts; ptsAg += G * p.ptsAg; op += G * p.op; dp += G * p.dp; sw += G; }
    if (!sw) continue;
    // primary QB: most starts this season before this week
    const qbs = {}; for (const x of cur) if (x.qb) qbs[x.qb] = (qbs[x.qb] || 0) + 1;
    const primaryQb = Object.entries(qbs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    R[t] = { off: pts / op, def: ptsAg / dp, ppg: op / sw, primaryQb, games, offShare: op ? curOp / op : 0, defShare: dp ? curDp / dp : 0 };
    for (const x of cur) { lgPts += x.pts; lgOp += x.op; }
  }
  const lg = lgOp ? lgPts / lgOp : 0.37;
  if (o.adj) { // strength of schedule, iterated so opponents' ratings are themselves adjusted
    const base = Object.fromEntries(Object.entries(R).map(([t, r]) => [t, { off: r.off, def: r.def }]));
    for (let it = 0; it < 6; it++) {
      const next = {};
      for (const [t, r] of Object.entries(R)) {
        let od = 0, wo = 0, oo = 0, wd = 0;
        for (const g of r.games) { const q = R[g.opp]; if (!q) continue; od += q.def * g.w * g.op; wo += g.w * g.op; oo += q.off * g.w * g.dp; wd += g.w * g.dp; }
        next[t] = { off: base[t].off + (wo ? (lg - od / wo) * r.offShare * o.adj : 0), def: base[t].def + (wd ? (lg - oo / wd) * r.defShare * o.adj : 0) };
      }
      for (const t in next) { R[t].off = next[t].off; R[t].def = next[t].def; }
    }
  }
  return rcache[key] = R;
}

function predict(g, o) {
  const R = ratings(g.season, g.week, o), H = R[g.home], A = R[g.away];
  if (!H || !A) return null;
  const pen = (T, qb) => T.primaryQb && qb && qb !== T.primaryQb ? 3 : 0;
  const hPts = (H.off + A.def) / 2 * H.ppg - pen(H, g.hqb), aPts = (A.off + H.def) / 2 * A.ppg - pen(A, g.aqb);
  let margin = hPts - aPts, total = hPts + aPts;
  if (g.spread != null) margin = o.w * margin + (1 - o.w) * g.spread;
  if (g.tl != null) total = o.tw * total + (1 - o.tw) * g.tl;
  return { margin, total, pHome: normCdf(margin / o.sd) };
}

function evaluate(o, seasons) {
  const m = { n: 0, dec: 0, su: 0, brier: 0, mae: 0, tmae: 0, cal: Array.from({ length: 5 }, () => [0, 0, 0]) };
  for (const g of ALL) {
    if (!seasons.includes(g.season) || g.week < 2) continue;
    const p = predict(g, o); if (!p) continue;
    const act = g.hs - g.as, hw = act > 0 ? 1 : act < 0 ? 0 : 0.5;
    m.n++; m.brier += (p.pHome - hw) ** 2; m.mae += Math.abs(p.margin - act); m.tmae += Math.abs(p.total - (g.hs + g.as));
    if (hw !== 0.5) {
      m.dec++; if ((p.margin > 0) === (hw === 1)) m.su++;
      const c = Math.max(p.pHome, 1 - p.pHome), b = m.cal[Math.min(4, Math.floor((c - 0.5) * 10))];
      b[0] += c; b[1] += (p.pHome >= 0.5) === (hw === 1) ? 1 : 0; b[2]++;
    }
  }
  m.su /= m.dec; m.brier /= m.n; m.mae /= m.n; m.tmae /= m.n;
  return m;
}

module.exports = { predict, evaluate };
if (require.main !== module) return;
const TRAIN = [2021, 2022, 2023], TEST = [2024, 2025, 2026];
const BASE = { decay: 1, adj: 0, w: 1, tw: 1, sd: 13.5 }; // the current app model
const line = (name, o) => {
  const cells = [2021, 2022, 2023, 2024, 2025, 2026].map(s => (evaluate(o, [s]).su * 100).toFixed(1).padStart(5)).join(' ');
  const tr = evaluate(o, TRAIN), te = evaluate(o, TEST);
  return `${name.padEnd(44)} winners by season: ${cells} | TEST winners ${(te.su * 100).toFixed(1)}% Brier ${te.brier.toFixed(4)} margin err ${te.mae.toFixed(2)} total err ${te.tmae.toFixed(2)} | train Brier ${tr.brier.toFixed(4)}`;
};

// 1) each idea on its own, tuned on TRAIN
const best = (grid, fixed) => {
  let b = null;
  for (const o of grid) { const tr = evaluate({ ...fixed, ...o }, TRAIN); if (!b || tr.brier < b.brier) b = { o: { ...fixed, ...o }, brier: tr.brier }; }
  return b.o;
};
const decays = [1, 0.95, 0.9, 0.85, 0.8], adjs = [0, 0.25, 0.5, 0.75, 1], ws = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1], sds = [12, 12.5, 13, 13.5, 14, 14.5, 15];
const bDecay = best(decays.map(decay => ({ decay })), BASE);
const bAdj = best(adjs.map(adj => ({ adj })), BASE);
const bW = best(ws.flatMap(w => ws.map(tw => ({ w, tw }))), BASE);
const bSd = best(sds.map(sd => ({ sd })), BASE);
console.log('Season columns: 2021 2022 2023 | 2024 2025 2026 (last three never used for tuning)\n');
console.log(line('Current app model', BASE));
console.log(line('Vegas spread only', { ...BASE, w: 0, tw: 0 }));
console.log(line(`+ recent form (decay ${bDecay.decay})`, bDecay));
console.log(line(`+ strength of schedule (adj ${bAdj.adj})`, bAdj));
console.log(line(`+ Vegas blend (model ${bW.w}, total ${bW.tw})`, bW));
console.log(line(`+ win% spread (sd ${bSd.sd})`, bSd));

// 2) everything together, tuned jointly on TRAIN
let all = null;
for (const decay of [1, 0.9, 0.8]) for (const adj of [0, 0.5, 1]) for (const w of [0.2, 0.3, 0.4, 0.5, 0.6]) for (const tw of [0, 0.2, 0.4]) for (const sd of [12.5, 13, 13.5, 14]) {
  const o = { decay, adj, w, tw, sd }, tr = evaluate(o, TRAIN);
  if (!all || tr.brier < all.brier) all = { o, brier: tr.brier };
}
console.log(line(`ALL combined ${JSON.stringify(all.o)}`, all.o));

// 3) model-only improvements combined (no Vegas), to see what the model itself gains
let mo = null;
for (const decay of [1, 0.95, 0.9, 0.85]) for (const adj of [0, 0.25, 0.5, 0.75, 1]) for (const sd of [13, 13.5, 14, 14.5]) {
  const o = { decay, adj, w: 1, tw: 1, sd }, tr = evaluate(o, TRAIN);
  if (!mo || tr.brier < mo.brier) mo = { o, brier: tr.brier };
}
console.log(line(`Model-only best ${JSON.stringify(mo.o)}`, mo.o));

// calibration of the combined version on TEST
const te = evaluate(all.o, TEST);
console.log('\nCombined, TEST calibration (said → happened): ' + te.cal.filter(b => b[2]).map((b, i) => `${(b[0] / b[2] * 100).toFixed(0)}%→${(b[1] / b[2] * 100).toFixed(0)}% (${b[2]})`).join('  '));
require('fs').writeFileSync(require('path').join(__dirname, 'gamepicks_best.json'), JSON.stringify({ combined: all.o, modelOnly: mo.o }, null, 1));
