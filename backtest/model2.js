// Upgraded PPP model, tested over 2021-2025.
// Options (each can be switched off to recover the original model):
//   offOnly   — rate offenses/defenses on offensive points only; add league-avg non-offensive pts back to projections
//   wy        — weight on yards-per-play (converted to points via league pts/yard); 0 = pure PPP
//   prevGames — pseudo-games of last season's stats blended in (fades as the season goes on)
//   hfa       — points added to the home team
//   qbPen     — points subtracted when a team starts a QB who isn't its season-to-date primary starter
// Usage: node model2.js tune    (tune on 2021-23, test on 2024-25)
//        node model2.js eval '{"wy":0.5,...}'
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  const [h, ...data] = rows;
  return data.filter(r => r.length === h.length).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const num = v => v === '' || v == null ? null : +v;
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const mlToProb = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
const profit = ml => ml > 0 ? ml : 10000 / -ml;

const box = JSON.parse(fs.readFileSync(path.join(DIR, 'boxscores.json'), 'utf8'));
const ALL = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'))
  .filter(g => +g.season >= 2020 && +g.season <= 2026 && g.home_score !== '' && box[g.espn])
  .map(g => ({
    raw: g, season: +g.season, week: +g.week, type: g.game_type, neutral: g.location === 'Neutral',
    home: g.home_team, away: g.away_team, hs: +g.home_score, as: +g.away_score, hqb: g.home_qb_id, aqb: g.away_qb_id,
    hb: box[g.espn].home, ab: box[g.espn].away,
    hml: num(g.home_moneyline), aml: num(g.away_moneyline), spread: num(g.spread_line), tl: num(g.total_line),
    hso: num(g.home_spread_odds) ?? -110, aso: num(g.away_spread_odds) ?? -110, oo: num(g.over_odds) ?? -110, uo: num(g.under_odds) ?? -110
  }));
const SEASONS = [2021, 2022, 2023, 2024, 2025];

function accum(games) {
  const t = {};
  const get = id => t[id] ??= { pts: 0, offPts: 0, ptsAg: 0, offPtsAg: 0, op: 0, dp: 0, yds: 0, ydsAg: 0, gp: 0, qbs: {} };
  for (const g of games) for (const [me, mb, ob, ms, os, qb] of [[g.home, g.hb, g.ab, g.hs, g.as, g.hqb], [g.away, g.ab, g.hb, g.as, g.hs, g.aqb]]) {
    const r = get(me);
    r.gp++; r.pts += ms; r.ptsAg += os; r.offPts += mb.offPts; r.offPtsAg += ob.offPts;
    r.op += mb.plays; r.dp += ob.plays; r.yds += mb.yards; r.ydsAg += ob.yards;
    if (qb) r.qbs[qb] = (r.qbs[qb] || 0) + 1;
  }
  return t;
}
const prevSeason = {};
for (const s of [...SEASONS, 2026]) prevSeason[s] = accum(ALL.filter(g => g.season === s - 1 && g.type === 'REG'));
const curCache = {};
const curStats = (s, w) => curCache[s + ':' + w] ??= accum(ALL.filter(g => g.season === s && g.week < w));

function ratings(s, w, cfg) {
  const cur = curStats(s, w), prev = prevSeason[s];
  let L = { pts: 0, offPts: 0, op: 0, yds: 0, gp: 0 };
  for (const r of Object.values(cur)) { L.pts += r.pts; L.offPts += r.offPts; L.op += r.op; L.yds += r.yds; L.gp += r.gp; }
  if (!L.gp) for (const r of Object.values(prev)) { L.pts += r.pts; L.offPts += r.offPts; L.op += r.op; L.yds += r.yds; L.gp += r.gp; }
  const ptsKey = cfg.offOnly ? 'offPts' : 'pts', agKey = cfg.offOnly ? 'offPtsAg' : 'ptsAg';
  const lgPPP = L[ptsKey] / L.op, ptsPerYard = L[ptsKey] / L.yds;
  const nonOffPG = cfg.offOnly ? (L.pts - L.offPts) / L.gp : 0;
  const R = { _nonOffPG: nonOffPG };
  for (const id of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
    const c = cur[id], p = prev[id];
    const G = p ? cfg.prevGames : 0;
    const sum = k => (c ? c[k] : 0) + (p ? G * p[k] / p.gp : 0);
    const gp = (c ? c.gp : 0) + G;
    if (!gp) continue;
    const op = sum('op'), dp = sum('dp');
    const offPPP = sum(ptsKey) / op, defPPP = sum(agKey) / dp;
    const offY = sum('yds') / op * ptsPerYard, defY = sum('ydsAg') / dp * ptsPerYard;
    let primaryQb = null, n = 0;
    if (c) for (const [q, k] of Object.entries(c.qbs)) if (k > n) { n = k; primaryQb = q; }
    R[id] = { off: (1 - cfg.wy) * offPPP + cfg.wy * offY, def: (1 - cfg.wy) * defPPP + cfg.wy * defY, ppg: op / gp, primaryQb, lgPPP };
  }
  return R;
}

function predict(R, g, cfg) {
  const H = R[g.home], A = R[g.away];
  if (!H || !A) return null;
  const backup = (T, qb) => cfg.qbPen && T.primaryQb && qb && qb !== T.primaryQb ? cfg.qbPen : 0;
  const hPts = (H.off + A.def) / 2 * H.ppg + R._nonOffPG + (g.neutral ? 0 : cfg.hfa) - backup(H, g.hqb);
  const aPts = (A.off + H.def) / 2 * A.ppg + R._nonOffPG - backup(A, g.aqb);
  return { hPts, aPts, margin: hPts - aPts, total: hPts + aPts, pHome: normCdf((hPts - aPts) / cfg.sd) };
}

function evaluate(cfg, seasons, minWeek = 2, maxWeek = 99) {
  const m = { n: 0, su: 0, dec: 0, brier: 0, vBrier: 0, vSU: 0, mae: 0, vMae: 0, tmae: 0, vTmae: 0,
    ml: [0, 0, 0], mlEdge: [0, 0, 0], ats: [0, 0, 0], ou: [0, 0, 0] };
  const bet = (b, won, odds) => { if (won) { b[0]++; b[2] += profit(odds); } else { b[1]++; b[2] -= 100; } };
  const cache = {};
  for (const g of ALL) {
    if (!seasons.includes(g.season) || g.week < minWeek || g.week > maxWeek) continue;
    const R = cache[g.season + ':' + g.week] ??= ratings(g.season, g.week, cfg);
    const p = predict(R, g, cfg);
    if (!p) continue;
    const act = g.hs - g.as, tot = g.hs + g.as, hw = act > 0 ? 1 : act < 0 ? 0 : 0.5;
    m.n++; m.mae += Math.abs(p.margin - act); m.tmae += Math.abs(p.total - tot); m.brier += (p.pHome - hw) ** 2;
    if (g.spread != null) m.vMae += Math.abs(g.spread - act);
    if (g.tl != null) m.vTmae += Math.abs(g.tl - tot);
    if (hw !== 0.5) { m.dec++; if ((p.margin > 0) === (hw === 1)) m.su++; }
    if (g.hml != null && g.aml != null) {
      const ih = mlToProb(g.hml), ia = mlToProb(g.aml), mk = ih / (ih + ia);
      m.vBrier += (mk - hw) ** 2;
      if (hw !== 0.5) {
        if ((mk > 0.5) === (hw === 1)) m.vSU++;
        const fh = p.pHome >= 0.5; bet(m.ml, fh ? hw : 1 - hw, fh ? g.hml : g.aml);
        const eh = p.pHome > mk; bet(m.mlEdge, eh ? hw : 1 - hw, eh ? g.hml : g.aml);
      }
    }
    if (g.spread != null && act !== g.spread) { const ph = p.margin > g.spread; bet(m.ats, (act > g.spread) === ph, ph ? g.hso : g.aso); }
    if (g.tl != null && tot !== g.tl) { const ov = p.total > g.tl; bet(m.ou, (tot > g.tl) === ov, ov ? g.oo : g.uo); }
  }
  for (const k of ['brier', 'vBrier', 'mae', 'vMae', 'tmae', 'vTmae']) m[k] /= m.n;
  m.su /= m.dec; m.vSU /= m.dec;
  return m;
}

const ORIGINAL = { offOnly: 0, wy: 0, prevGames: 0, hfa: 0, qbPen: 0, sd: 13.5 };
const rec = b => `${b[0]}-${b[1]} ${(b[0] / (b[0] + b[1]) * 100).toFixed(1)}% ${b[2] >= 0 ? '+' : ''}$${b[2].toFixed(0)}`;
const line = (name, m) => `${name.padEnd(30)} n=${m.n} | Winners ${(m.su * 100).toFixed(1)}% (Vegas ${(m.vSU * 100).toFixed(1)}%) | Brier ${m.brier.toFixed(4)} (Vegas ${m.vBrier.toFixed(4)}) | ` +
  `Margin err ${m.mae.toFixed(2)} (V ${m.vMae.toFixed(2)}) | Total err ${m.tmae.toFixed(2)} (V ${m.vTmae.toFixed(2)})\n${''.padEnd(30)} ML fav ${rec(m.ml)} | ML edge ${rec(m.mlEdge)} | ATS ${rec(m.ats)} | O/U ${rec(m.ou)}`;

const mode = require.main === module ? (process.argv[2] || 'tune') : 'lib';
if (mode === 'tune') {
  const TRAIN = [2021, 2022, 2023], TEST = [2024, 2025];
  const res = [];
  for (const offOnly of [0, 1]) for (const wy of [0, 0.25, 0.5, 0.75, 1]) for (const prevGames of [0, 2, 4])
    for (const hfa of [0, 0.5, 1, 1.5, 2]) for (const qbPen of [0, 2, 3, 4, 6]) {
      const cfg = { ...ORIGINAL, offOnly, wy, prevGames, hfa, qbPen };
      res.push({ cfg, m: evaluate(cfg, TRAIN) });
    }
  res.sort((a, b) => a.m.brier - b.m.brier);
  console.log('Top 8 on TRAIN 2021-23 (by Brier):');
  for (const r of res.slice(0, 8)) console.log(JSON.stringify(r.cfg), 'Brier', r.m.brier.toFixed(4), 'Winners', (r.m.su * 100).toFixed(1) + '%', 'MarginErr', r.m.mae.toFixed(2));
  const best = res[0].cfg;
  // one-at-a-time ablations from the original, to show what each change contributes
  const variants = {
    'Original model': ORIGINAL,
    '+ offense-only points': { ...ORIGINAL, offOnly: best.offOnly || 1 },
    '+ yards per play': { ...ORIGINAL, wy: best.wy || 0.5 },
    '+ last-season blend': { ...ORIGINAL, prevGames: best.prevGames || 2 },
    '+ home field': { ...ORIGINAL, hfa: best.hfa || 1 },
    '+ backup QB penalty': { ...ORIGINAL, qbPen: best.qbPen || 3 },
    'Best combined (tuned 21-23)': best
  };
  fs.writeFileSync(path.join(DIR, 'best_config.json'), JSON.stringify(best, null, 1));
  for (const [label, seasons] of [['TRAIN 2021-23', TRAIN], ['TEST 2024-25 (unseen)', TEST], ['ALL 5 YEARS', SEASONS]]) {
    console.log(`\n===== ${label} =====`);
    for (const [name, c] of Object.entries(variants)) console.log(line(name, evaluate(c, seasons)));
  }
  console.log('\n===== Best combined, by season =====');
  for (const s of SEASONS) { console.log(line(`${s} original`, evaluate(ORIGINAL, [s]))); console.log(line(`${s} upgraded`, evaluate(best, [s]))); }
  console.log('\n===== Best combined, by part of season (all 5 years) =====');
  for (const [nm, lo, hi] of [['Weeks 2-5', 2, 5], ['Weeks 6-10', 6, 10], ['Weeks 11+', 11, 99]]) {
    const ev = c => evaluate(c, SEASONS, lo, hi);
    console.log(line(`${nm} original`, ev(ORIGINAL))); console.log(line(`${nm} upgraded`, ev(best)));
  }
} else if (mode === 'eval') {
  const cfg = { ...ORIGINAL, ...JSON.parse(process.argv[3] || '{}') };
  for (const s of SEASONS) console.log(line(String(s), evaluate(cfg, [s])));
  console.log(line('ALL', evaluate(cfg, SEASONS)));
}


module.exports = { ALL, ratings, predict, ORIGINAL, profit, mlToProb };
