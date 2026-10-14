// Tests improvements to the PPP model. Tune on 2024, validate on 2025 (out-of-sample).
// Requires games.csv + plays.json from backtest.js (run it for 2023, 2024, 2025 first).
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

const plays = JSON.parse(fs.readFileSync(path.join(DIR, 'plays.json'), 'utf8'));
const ALL = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'))
  .filter(g => [2023, 2024, 2025].includes(+g.season) && g.home_score !== '' && plays[g.espn])
  .map(g => ({
    id: g.game_id, season: +g.season, week: +g.week, type: g.game_type, neutral: g.location === 'Neutral',
    home: g.home_team, away: g.away_team, hs: +g.home_score, as: +g.away_score,
    hp: plays[g.espn].home, ap: plays[g.espn].away,
    hml: num(g.home_moneyline), aml: num(g.away_moneyline), spread: num(g.spread_line), tl: num(g.total_line),
    hso: num(g.home_spread_odds) ?? -110, aso: num(g.away_spread_odds) ?? -110, oo: num(g.over_odds) ?? -110, uo: num(g.under_odds) ?? -110
  }));

function accum(games) {
  const t = {};
  const get = id => t[id] ??= { pf: 0, pa: 0, op: 0, dp: 0, gp: 0, opps: [] };
  for (const g of games) for (const [me, op, mp, opp, ms, os] of [[g.home, g.away, g.hp, g.ap, g.hs, g.as], [g.away, g.home, g.ap, g.hp, g.as, g.hs]]) {
    const r = get(me); r.gp++; r.pf += ms; r.pa += os; r.op += mp; r.dp += opp; r.opps.push({ opp: op, op: mp, dp: opp });
  }
  return t;
}
const prevSeason = {};
for (const s of [2023, 2024, 2025]) prevSeason[s + 1] = accum(ALL.filter(g => g.season === s && g.type === 'REG'));
const curCache = {};
const curStats = (s, w) => curCache[s + ':' + w] ??= accum(ALL.filter(g => g.season === s && g.week < w));

// cfg: hfa, prevGames (pseudo-games of last season blended in), shrink (pseudo-plays at league avg),
//      adj (opponent-adjust PPP), pace ('own' | 'mix'), sd
function ratings(s, w, cfg) {
  const cur = curStats(s, w), prev = prevSeason[s] || {};
  const teams = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  let lp = 0, lplays = 0;
  for (const r of Object.values(cur)) { lp += r.pf; lplays += r.op; }
  const lg = lplays ? lp / lplays : 0.37;
  const R = {};
  for (const id of teams) {
    const c = cur[id] || { pf: 0, pa: 0, op: 0, dp: 0, gp: 0, opps: [] }, p = prev[id];
    const G = p ? cfg.prevGames : 0;
    const pg = k => p ? G * p[k] / p.gp : 0;
    const pf = c.pf + pg('pf'), pa = c.pa + pg('pa'), op = c.op + pg('op'), dp = c.dp + pg('dp'), gp = c.gp + G;
    if (!gp) continue;
    R[id] = {
      off: (pf + cfg.shrink * lg) / (op + cfg.shrink), def: (pa + cfg.shrink * lg) / (dp + cfg.shrink),
      ppg: op / gp, dppg: dp / gp, curFrac: op ? c.op / op : 0, opps: c.opps
    };
  }
  if (cfg.adj) {
    // Opponent adjustment: credit offenses that faced good defenses (and vice versa) — current-season games only
    const base = Object.fromEntries(Object.entries(R).map(([k, r]) => [k, { off: r.off, def: r.def }]));
    for (let it = 0; it < 6; it++) {
      const next = {};
      for (const [id, r] of Object.entries(R)) {
        let od = 0, wo = 0, oo = 0, wd = 0;
        for (const g of r.opps) { if (!R[g.opp]) continue; od += R[g.opp].def * g.op; wo += g.op; oo += R[g.opp].off * g.dp; wd += g.dp; }
        const offAdj = wo ? (lg - od / wo) * r.curFrac * cfg.adj : 0, defAdj = wd ? (lg - oo / wd) * r.curFrac * cfg.adj : 0;
        next[id] = { off: base[id].off + offAdj, def: base[id].def + defAdj };
      }
      for (const id in next) { R[id].off = next[id].off; R[id].def = next[id].def; }
    }
  }
  return R;
}

function predict(R, g, cfg) {
  const H = R[g.home], A = R[g.away];
  if (!H || !A) return null;
  const hPlays = cfg.pace === 'mix' ? (H.ppg + A.dppg) / 2 : H.ppg;
  const aPlays = cfg.pace === 'mix' ? (A.ppg + H.dppg) / 2 : A.ppg;
  const hPts = (H.off + A.def) / 2 * hPlays + (g.neutral ? 0 : cfg.hfa);
  const aPts = (A.off + H.def) / 2 * aPlays;
  return { hPts, aPts, margin: hPts - aPts, total: hPts + aPts, pHome: normCdf((hPts - aPts) / cfg.sd) };
}

function run(cfg, season, minWeek = 2) {
  const m = { n: 0, su: 0, dec: 0, brier: 0, mae: 0, tmae: 0, mlw: 0, mll: 0, mlnet: 0, aw: 0, al: 0, anet: 0, ow: 0, ol: 0, onet: 0 };
  for (const g of ALL) {
    if (g.season !== season || g.week < minWeek) continue;
    const R = ratings(g.season, g.week, cfg);
    const p = predict(R, g, cfg);
    if (!p) continue;
    const act = g.hs - g.as, tot = g.hs + g.as, hw = act > 0 ? 1 : act < 0 ? 0 : 0.5;
    m.n++; m.mae += Math.abs(p.margin - act); m.tmae += Math.abs(p.total - tot); m.brier += (p.pHome - hw) ** 2;
    if (hw !== 0.5) { m.dec++; if ((p.margin > 0) === (hw === 1)) m.su++; }
    if (g.hml != null && g.aml != null && hw !== 0.5) {
      const fh = p.pHome >= 0.5, won = fh ? hw : 1 - hw;
      if (won) { m.mlw++; m.mlnet += profit(fh ? g.hml : g.aml); } else { m.mll++; m.mlnet -= 100; }
    }
    if (g.spread != null && act !== g.spread) {
      const ph = p.margin > g.spread, win = (act > g.spread) === ph;
      if (win) { m.aw++; m.anet += profit(ph ? g.hso : g.aso); } else { m.al++; m.anet -= 100; }
    }
    if (g.tl != null && tot !== g.tl) {
      const ov = p.total > g.tl, win = (tot > g.tl) === ov;
      if (win) { m.ow++; m.onet += profit(ov ? g.oo : g.uo); } else { m.ol++; m.onet -= 100; }
    }
  }
  m.su /= m.dec; m.brier /= m.n; m.mae /= m.n; m.tmae /= m.n;
  return m;
}

const BASE = { hfa: 0, prevGames: 0, shrink: 0, adj: 0, pace: 'own', sd: 13.5 };
const fmt = (name, m) => `${name.padEnd(46)} SU ${(m.su * 100).toFixed(1)}%  Brier ${m.brier.toFixed(4)}  MarginErr ${m.mae.toFixed(2)}  TotErr ${m.tmae.toFixed(2)}  ` +
  `ML ${m.mlw}-${m.mll} $${m.mlnet.toFixed(0)}  ATS ${m.aw}-${m.al} $${m.anet.toFixed(0)}  O/U ${m.ow}-${m.ol} $${m.onet.toFixed(0)}`;

const mode = process.argv[2] || 'grid';
if (mode === 'grid') {
  const results = [];
  for (const prevGames of [0, 2, 4, 6, 8, 12])
    for (const shrink of [0, 100, 200, 400])
      for (const adj of [0, 1])
        for (const pace of ['own', 'mix'])
          for (const hfa of [0, 0.5, 1, 1.5]) {
            const cfg = { ...BASE, prevGames, shrink, adj, pace, hfa };
            results.push({ cfg, m: run(cfg, 2024) });
          }
  results.sort((a, b) => a.m.brier - b.m.brier);
  console.log('Top 12 configs on 2024 (by Brier — accuracy of win probabilities):');
  for (const r of results.slice(0, 12)) console.log(fmt(JSON.stringify({ g: r.cfg.prevGames, k: r.cfg.shrink, a: r.cfg.adj, p: r.cfg.pace, h: r.cfg.hfa }), r.m));
  fs.writeFileSync(path.join(DIR, 'grid2024.json'), JSON.stringify(results.slice(0, 30).map(r => r.cfg)));
} else {
  // ablation: compare named configs on each season
  const cfgs = JSON.parse(process.argv[3]);
  for (const s of [2024, 2025]) {
    console.log(`\n== ${s} ==`);
    for (const [name, c] of Object.entries(cfgs)) console.log(fmt(name, run({ ...BASE, ...c }, s)));
  }
}
