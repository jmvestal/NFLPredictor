// Walk-forward backtest of the NFL Predictor PPP model on past seasons.
// Usage: node --use-system-ca backtest.js [seasons=2024,2025] [hfa=0] [sd=13.5]
// Odds/scores: nflverse games.csv (closing lines). Play counts: ESPN game summaries (cached in plays.json).
const fs = require('fs');
const path = require('path');

const SEASONS = (process.argv[2] || '2024,2025').split(',').map(Number);
const HFA = parseFloat(process.argv[3] || '0');
const SD = parseFloat(process.argv[4] || '13.5');
const DIR = __dirname;
const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const SUMMARY = id => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`;

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
  if (f || row.length) { row.push(f); rows.push(row); }
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
const profit = ml => ml > 0 ? ml : 10000 / -ml; // on a $100 stake

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function loadPlays(games) {
  const file = path.join(DIR, 'plays.json');
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const need = games.filter(g => !cache[g.espn]);
  let done = 0;
  await pool(need, 10, async g => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(SUMMARY(g.espn));
        if (!r.ok) throw new Error(r.status);
        const s = await r.json();
        const rec = {};
        for (const t of s.boxscore?.teams || []) {
          const st = t.statistics.find(x => x.name === 'totalOffensivePlays');
          if (st) rec[t.homeAway] = +st.displayValue;
        }
        if (rec.home && rec.away) cache[g.espn] = rec;
        break;
      } catch (e) { if (attempt === 2) console.warn('failed', g.game_id, e.message); }
    }
    if (++done % 50 === 0) { console.log(`  plays ${done}/${need.length}`); fs.writeFileSync(file, JSON.stringify(cache)); }
  });
  fs.writeFileSync(file, JSON.stringify(cache));
  return cache;
}

// Model exactly as in the app: season-to-date PPP from games before this week.
function teamStats(prior) {
  const t = {};
  const get = id => t[id] ??= { pf: 0, pa: 0, op: 0, dp: 0, gp: 0 };
  for (const g of prior) {
    for (const [me, op] of [['home', 'away'], ['away', 'home']]) {
      const r = get(g[me + '_team']);
      r.gp++; r.pf += g[me + '_score']; r.pa += g[op + '_score']; r.op += g[me + '_plays']; r.dp += g[op + '_plays'];
    }
  }
  for (const r of Object.values(t)) { r.off = r.pf / r.op; r.def = r.pa / r.dp; r.ppg = r.op / r.gp; }
  return t;
}

function predict(T, g) {
  const H = T[g.home_team], A = T[g.away_team];
  if (!H || !A) return null;
  // home team gets HFA extra points added to its projected score (none at neutral sites)
  const hPts = (H.off * H.ppg + A.def * H.ppg) / 2 + (g.location === 'Neutral' ? 0 : HFA);
  const aPts = (A.off * A.ppg + H.def * A.ppg) / 2;
  const margin = hPts - aPts;
  return { hPts, aPts, margin, total: hPts + aPts, pHome: normCdf(margin / SD) };
}

(async () => {
  const csvFile = path.join(DIR, 'games.csv');
  if (!fs.existsSync(csvFile)) {
    console.log('Downloading nflverse games.csv…');
    fs.writeFileSync(csvFile, await (await fetch(GAMES_URL)).text());
  }
  let games = parseCsv(fs.readFileSync(csvFile, 'utf8'))
    .filter(g => SEASONS.includes(+g.season) && g.home_score !== '' && g.espn);
  console.log(`${games.length} completed games in ${SEASONS.join(', ')}. Loading play counts…`);
  const plays = await loadPlays(games);
  games = games.map(g => ({
    ...g, season: +g.season, week: +g.week, home_score: +g.home_score, away_score: +g.away_score,
    home_plays: plays[g.espn]?.home, away_plays: plays[g.espn]?.away,
    home_ml: num(g.home_moneyline), away_ml: num(g.away_moneyline), spread: num(g.spread_line), total_line: num(g.total_line),
    home_spread_odds: num(g.home_spread_odds) ?? -110, away_spread_odds: num(g.away_spread_odds) ?? -110,
    over_odds: num(g.over_odds) ?? -110, under_odds: num(g.under_odds) ?? -110
  })).filter(g => g.home_plays && g.away_plays);

  const out = [];
  for (const g of games) {
    if (g.week < 2) continue;
    const prior = games.filter(x => x.season === g.season && x.week < g.week);
    const p = predict(teamStats(prior), g);
    if (!p) continue;
    out.push({ g, p });
  }
  fs.writeFileSync(path.join(DIR, `predictions_hfa${HFA}.json`), JSON.stringify(out.map(({ g, p }) => ({
    game_id: g.game_id, season: g.season, week: g.week, away: g.away_team, home: g.home_team,
    away_score: g.away_score, home_score: g.home_score, proj_away: +p.aPts.toFixed(2), proj_home: +p.hPts.toFixed(2),
    p_home: +p.pHome.toFixed(4), home_ml: g.home_ml, away_ml: g.away_ml, spread: g.spread, total_line: g.total_line
  })), null, 1));

  const report = {};
  const groups = {
    'All games': out,
    ...Object.fromEntries(SEASONS.map(s => [`${s} season`, out.filter(r => r.g.season === s)])),
    'Weeks 2-5': out.filter(r => r.g.game_type === 'REG' && r.g.week <= 5),
    'Weeks 6-10': out.filter(r => r.g.game_type === 'REG' && r.g.week >= 6 && r.g.week <= 10),
    'Weeks 11-18': out.filter(r => r.g.game_type === 'REG' && r.g.week >= 11),
    'Playoffs': out.filter(r => r.g.game_type !== 'REG')
  };
  for (const [name, rs] of Object.entries(groups)) report[name] = evaluate(rs);
  report.thresholds = thresholds(out);
  report.calibration = calibration(out);
  fs.writeFileSync(path.join(DIR, `results_hfa${HFA}.json`), JSON.stringify(report, null, 1));
  print(report);
})();

function rec() { return { w: 0, l: 0, p: 0, staked: 0, net: 0 }; }
function settle(r, outcome, odds) { // outcome 1 win, 0 loss, 0.5 push
  if (outcome === 0.5) { r.p++; return; }
  r.staked += 100;
  if (outcome) { r.w++; r.net += profit(odds); } else { r.l++; r.net -= 100; }
}
const roi = r => r.staked ? r.net / r.staked : 0;

function evaluate(rs) {
  const n = rs.length;
  const m = { n, scoreMAE: 0, marginMAE: 0, totalMAE: 0, vegasMarginMAE: 0, vegasTotalMAE: 0, su: 0, vegasSU: 0, decided: 0,
    brier: 0, vegasBrier: 0, mlN: 0, ml: rec(), mlFav: rec(), ats: rec(), ou: rec(), overs: 0, ouN: 0, modelBias: 0, totalBias: 0 };
  for (const { g, p } of rs) {
    const act = g.home_score - g.away_score, actTot = g.home_score + g.away_score;
    m.scoreMAE += (Math.abs(p.hPts - g.home_score) + Math.abs(p.aPts - g.away_score)) / 2;
    m.marginMAE += Math.abs(p.margin - act); m.totalMAE += Math.abs(p.total - actTot);
    m.modelBias += p.margin - act; m.totalBias += p.total - actTot;
    if (g.spread != null) m.vegasMarginMAE += Math.abs(g.spread - act);
    if (g.total_line != null) m.vegasTotalMAE += Math.abs(g.total_line - actTot);
    const homeWin = act > 0 ? 1 : act < 0 ? 0 : 0.5;
    if (homeWin !== 0.5) { m.decided++; if ((p.margin > 0) === (homeWin === 1)) m.su++; }

    if (g.home_ml != null && g.away_ml != null) {
      const ih = mlToProb(g.home_ml), ia = mlToProb(g.away_ml), mkH = ih / (ih + ia);
      m.mlN++; m.brier += (p.pHome - homeWin) ** 2; m.vegasBrier += (mkH - homeWin) ** 2;
      if (homeWin !== 0.5 && (mkH > 0.5) === (homeWin === 1)) m.vegasSU++;
      // bet the side with positive edge vs. no-vig market
      const edgeH = p.pHome - mkH;
      const betHome = edgeH > 0;
      settle(m.ml, homeWin === 0.5 ? 0.5 : (betHome ? homeWin : 1 - homeWin), betHome ? g.home_ml : g.away_ml);
      // bet the model's favorite on the ML
      const favHome = p.pHome >= 0.5;
      settle(m.mlFav, homeWin === 0.5 ? 0.5 : (favHome ? homeWin : 1 - homeWin), favHome ? g.home_ml : g.away_ml);
    }
    if (g.spread != null) {
      const pickHome = p.margin > g.spread, cover = act - g.spread;
      settle(m.ats, cover === 0 ? 0.5 : ((cover > 0) === pickHome ? 1 : 0), pickHome ? g.home_spread_odds : g.away_spread_odds);
    }
    if (g.total_line != null) {
      const over = p.total > g.total_line, d = actTot - g.total_line;
      m.ouN++; if (over) m.overs++;
      settle(m.ou, d === 0 ? 0.5 : ((d > 0) === over ? 1 : 0), over ? g.over_odds : g.under_odds);
    }
  }
  for (const k of ['scoreMAE', 'marginMAE', 'totalMAE', 'vegasMarginMAE', 'vegasTotalMAE', 'modelBias', 'totalBias']) m[k] /= n;
  m.su /= m.decided; m.vegasSU /= m.decided; m.brier /= m.mlN; m.vegasBrier /= m.mlN;
  return m;
}

function thresholds(rs) {
  const t = { ml: {}, ats: {}, ou: {} };
  for (const e of [0, 0.03, 0.05, 0.1, 0.15]) {
    const r = rec();
    for (const { g, p } of rs) {
      if (g.home_ml == null || g.away_ml == null) continue;
      const act = g.home_score - g.away_score, hw = act > 0 ? 1 : act < 0 ? 0 : 0.5;
      const ih = mlToProb(g.home_ml), ia = mlToProb(g.away_ml), mkH = ih / (ih + ia);
      const edgeH = p.pHome - mkH;
      if (Math.abs(edgeH) < e || edgeH === 0) continue;
      const bh = edgeH > 0;
      settle(r, hw === 0.5 ? 0.5 : (bh ? hw : 1 - hw), bh ? g.home_ml : g.away_ml);
    }
    t.ml[`edge >= ${e * 100}%`] = r;
  }
  for (const d of [0, 1, 2, 3, 5, 7]) {
    const a = rec(), o = rec();
    for (const { g, p } of rs) {
      const act = g.home_score - g.away_score, tot = g.home_score + g.away_score;
      if (g.spread != null && Math.abs(p.margin - g.spread) >= d) {
        const ph = p.margin > g.spread, c = act - g.spread;
        settle(a, c === 0 ? 0.5 : ((c > 0) === ph ? 1 : 0), ph ? g.home_spread_odds : g.away_spread_odds);
      }
      if (g.total_line != null && Math.abs(p.total - g.total_line) >= d) {
        const ov = p.total > g.total_line, x = tot - g.total_line;
        settle(o, x === 0 ? 0.5 : ((x > 0) === ov ? 1 : 0), ov ? g.over_odds : g.under_odds);
      }
    }
    t.ats[`diff >= ${d} pts`] = a; t.ou[`diff >= ${d} pts`] = o;
  }
  return t;
}

function calibration(rs) {
  const b = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
  return b.map(([lo, hi]) => {
    const x = rs.map(({ g, p }) => {
      const act = g.home_score - g.away_score; if (!act) return null;
      const fp = Math.max(p.pHome, 1 - p.pHome);
      return { fp, won: (p.pHome >= 0.5) === (act > 0) ? 1 : 0 };
    }).filter(v => v && v.fp >= lo && v.fp < hi);
    return { bucket: `${lo * 100}-${Math.min(100, hi * 100)}%`, n: x.length,
      predicted: x.reduce((s, v) => s + v.fp, 0) / (x.length || 1), actual: x.reduce((s, v) => s + v.won, 0) / (x.length || 1) };
  });
}

function print(R) {
  const pc = x => (x * 100).toFixed(1) + '%';
  const rr = r => `${r.w}-${r.l}${r.p ? '-' + r.p : ''}  ${pc(r.w / (r.w + r.l || 1))}  ROI ${(roi(r) * 100).toFixed(1)}%  ($${r.net.toFixed(0)} on $${r.staked})`;
  console.log(`\n==== PPP model backtest  (HFA ${HFA}, SD ${SD}) ====`);
  for (const [k, m] of Object.entries(R)) {
    if (k === 'thresholds' || k === 'calibration') continue;
    console.log(`\n-- ${k}: ${m.n} games`);
    console.log(`  Score MAE ${m.scoreMAE.toFixed(2)} | Margin MAE ${m.marginMAE.toFixed(2)} (Vegas ${m.vegasMarginMAE.toFixed(2)}) | Total MAE ${m.totalMAE.toFixed(2)} (Vegas ${m.vegasTotalMAE.toFixed(2)})`);
    console.log(`  Bias: margin ${m.modelBias.toFixed(2)} (home), total ${m.totalBias.toFixed(2)}`);
    console.log(`  Straight-up ${pc(m.su)} (Vegas fav ${pc(m.vegasSU)}) | Brier ${m.brier.toFixed(4)} (Vegas ${m.vegasBrier.toFixed(4)})`);
    console.log(`  ML value side:   ${rr(m.ml)}`);
    console.log(`  ML model fav:    ${rr(m.mlFav)}`);
    console.log(`  ATS:             ${rr(m.ats)}`);
    console.log(`  O/U:             ${rr(m.ou)}  (picked Over ${pc(m.overs / m.ouN)})`);
  }
  console.log('\n-- Moneyline by edge'); for (const [k, r] of Object.entries(R.thresholds.ml)) console.log(`  ${k.padEnd(14)} ${rr(r)}`);
  console.log('-- ATS by model-vs-spread gap'); for (const [k, r] of Object.entries(R.thresholds.ats)) console.log(`  ${k.padEnd(14)} ${rr(r)}`);
  console.log('-- O/U by model-vs-total gap'); for (const [k, r] of Object.entries(R.thresholds.ou)) console.log(`  ${k.padEnd(14)} ${rr(r)}`);
  console.log('-- Calibration'); for (const c of R.calibration) console.log(`  ${c.bucket.padEnd(10)} n=${String(c.n).padEnd(4)} predicted ${pc(c.predicted)}  actual ${pc(c.actual)}`);
}
