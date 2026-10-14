// Player prop model: projection + probability distribution for passing/rushing/receiving stats.
// Tune on 2021-23, test on 2024-25 and 2026.  Usage: node props.js [tune|eval]
const fs = require('fs');
const path = require('path');
const { ALL, ratings, predict, ORIGINAL } = require('./model2.js');
const DIR = __dirname;

// ---------- stats ----------
// idx = column in players.json records: [cmp, att, passYds, passTD, int, rushAtt, rushYds, rushTD, rec, recYds, recTD, tgt]
const STATS = {
  rec:     { idx: 8, kind: 'count', role: 'rec', minMu: 2, label: 'Receptions', script: +1 },
  recYds:  { idx: 9, kind: 'yards', role: 'rec', minMu: 20, label: 'Receiving yards', script: +1 },
  rushAtt: { idx: 5, kind: 'count', role: 'rush', minMu: 3, label: 'Rush attempts', script: -1 },
  rushYds: { idx: 6, kind: 'yards', role: 'rush', minMu: 12, label: 'Rushing yards', script: -1 },
  cmp:     { idx: 0, kind: 'count', role: 'pass', minMu: 12, label: 'Completions', script: +1 },
  passYds: { idx: 2, kind: 'yards', role: 'pass', minMu: 150, label: 'Passing yards', script: +1 },
  passTD:  { idx: 3, kind: 'count', role: 'pass', minMu: 0.5, label: 'Passing TDs', script: +1 },
};
// a player "has the role" in a game if: pass = 10+ attempts, rush = 3+ carries OR he played QB (so a QB's
// 0-2 scramble games still count), rec = 1+ target
const hasRole = (r, role) => role === 'pass' ? r[1] >= 10 : role === 'rush' ? r[5] >= 3 || r[1] >= 10 : r[11] >= 1 || r[8] >= 1;

// ---------- data ----------
const P = JSON.parse(fs.readFileSync(path.join(DIR, 'players.json'), 'utf8'));
const gameByEspn = {};
for (const g of ALL) if (g.raw.espn) gameByEspn[g.raw.espn] = g;

// player-game rows, chronological
const rows = [];
const names = {};
for (const [eid, x] of Object.entries(P.games)) {
  const g = gameByEspn[eid];
  if (!g || g.type !== 'REG' && g.type !== 'WC' && g.type !== 'DIV' && g.type !== 'CON' && g.type !== 'SB') continue;
  Object.assign(names, x.names);
  for (const side of ['home', 'away']) {
    const team = side === 'home' ? g.home : g.away, opp = side === 'home' ? g.away : g.home;
    for (const [pid, r] of Object.entries(x[side])) {
      if (!r.some(v => v)) continue;
      rows.push({ pid, eid, g, season: g.season, week: g.week, team, opp, home: side === 'home', r });
    }
  }
}
rows.sort((a, b) => a.season - b.season || a.week - b.week);
const byPlayer = {};
for (const row of rows) (byPlayer[row.pid] ??= []).push(row);

// team-game totals allowed (sum of opponents' player stats) for opponent adjustment
const allowed = {}; // key season:team -> [{week, totals[]}]
for (const [eid, x] of Object.entries(P.games)) {
  const g = gameByEspn[eid]; if (!g) continue;
  for (const side of ['home', 'away']) {
    const defTeam = side === 'home' ? g.away : g.home; // stats by `side` players were allowed by the other team
    const tot = new Array(12).fill(0);
    for (const r of Object.values(x[side])) r.forEach((v, i) => tot[i] += v);
    (allowed[g.season + ':' + defTeam] ??= []).push({ week: g.week, tot });
  }
}
const leagueAllowed = {}; // season -> per-team-game average totals
for (const s of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
  const all = Object.entries(allowed).filter(([k]) => k.startsWith(s + ':')).flatMap(([, v]) => v);
  if (!all.length) continue;
  leagueAllowed[s] = new Array(12).fill(0).map((_, i) => all.reduce((a, b) => a + b.tot[i], 0) / all.length);
}

// ---------- model ----------
const oppCache = {};
function oppFactor(season, week, opp, idx, k = 4) {
  const key = season + ':' + week + ':' + opp + ':' + idx;
  return oppCache[key] ??= oppFactorRaw(season, week, opp, idx, k);
}
function oppFactorRaw(season, week, opp, idx, k) {
  // opponent's allowed per game this season (before week), shrunk toward league with k pseudo-games
  const lg = leagueAllowed[season - 1] && week <= 3 ? leagueAllowed[season - 1][idx] : (leagueAllowed[season]?.[idx] ?? leagueAllowed[season - 1][idx]);
  const games = (allowed[season + ':' + opp] || []).filter(x => x.week < week);
  const prev = (allowed[(season - 1) + ':' + opp] || []);
  const prevAvg = prev.length ? prev.reduce((a, b) => a + b.tot[idx], 0) / prev.length : lg;
  const sum = games.reduce((a, b) => a + b.tot[idx], 0) + k * (0.5 * prevAvg + 0.5 * lg);
  return (sum / (games.length + k)) / lg;
}

const gameModelCache = {};
function projMargin(row) {
  if (row._margin != null) return row._margin;
  const g = row.g, cfg = { ...ORIGINAL, prevGames: 4, qbPen: 3 };
  const R = gameModelCache[g.season + ':' + g.week] ??= ratings(g.season, g.week, cfg);
  const p = predict(R, g, cfg);
  return row._margin = !p ? 0 : row.home ? p.margin : -p.margin;
}

// each team's regular-season points per game, by season
const TEAM_AVG_PTS = (() => {
  const t = {};
  for (const g of ALL) {
    if (g.type !== 'REG') continue;
    for (const [team, pts] of [[g.home, g.hs], [g.away, g.as]]) { const k = g.season + ':' + team; (t[k] ??= [0, 0]); t[k][0] += pts; t[k][1]++; }
  }
  return Object.fromEntries(Object.entries(t).map(([k, [a, n]]) => [k, a / n]));
})();

// points Vegas expects this player's team to score (closing total and spread; spread > 0 = home favored)
function impliedPts(row) {
  const g = row.g;
  if (g.tl == null || g.spread == null) return null;
  return row.home ? g.tl / 2 + g.spread / 2 : g.tl / 2 - g.spread / 2;
}

// mean projection for player row (uses only games before it)
function project(row, statKey, o) {
  const st = STATS[statKey];
  const hk = '_hist_' + st.role;
  const hist = row[hk] ??= byPlayer[row.pid].filter(h => (h.season < row.season || (h.season === row.season && h.week < row.week))
    && h.season >= row.season - 1 && hasRole(h.r, st.role)).reverse();
  const cur = hist.filter(h => h.season === row.season);
  if (!cur.length || hist.length < 3) return null;
  let sw = 0, sx = 0;
  hist.forEach((h, i) => {
    const w = Math.pow(o.decay, i) * (h.season < row.season ? o.lastSeason : 1);
    sw += w; sx += w * h.r[st.idx];
  });
  // quarterbacks get their own baseline for rushing stats (otherwise they're pulled toward running-back numbers)
  const isQB = st.role === 'rush' && byPlayer[row.pid].some(h => h.season >= row.season - 1 && (h.season < row.season || h.week < row.week) && hasRole(h.r, 'pass'));
  let prior = o.prior[isQB ? statKey + ':qb' : statKey];
  // player-specific baseline: his own per-game average from last season (4+ games in the role), when available
  if (o.priorMode === 'player') {
    const last = byPlayer[row.pid].filter(h => h.season === row.season - 1 && hasRole(h.r, st.role));
    if (last.length >= 4) prior = last.reduce((a, h) => a + h.r[st.idx], 0) / last.length;
  }
  const raw = (sx + o.shrink * prior) / (sw + o.shrink);
  const opp = Math.pow(oppFactor(row.season, row.week, row.opp, st.idx), o.alpha);
  const script = Math.exp(st.script * o.beta * projMargin(row) * -1); // trailing (negative margin) → more passing
  // Vegas: this game's implied team points vs the player's typical game environment, raised to gamma
  let vegas = 1;
  if (o.gamma) {
    // baseline = the team's scoring in the player's history games: actual points this season,
    // last season's per-game average for last-season games (what the app can compute from ESPN data)
    const now = impliedPts(row);
    const past = hist.map(h => h.season === row.season ? (h.home ? h.g.hs : h.g.as) : TEAM_AVG_PTS[h.season + ':' + h.team]).filter(x => x != null);
    if (now != null && past.length) vegas = Math.pow(now / (past.reduce((a, b) => a + b, 0) / past.length), o.gamma);
  }
  return { mu: raw * opp * script * vegas, raw, games: hist.length };
}

// ---------- distributions ----------
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015; for (const ci of c) s += ci / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
function gammaP(a, x) { // regularized lower incomplete gamma
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
// P(X > line) for line ending in .5 (or any real)
function pOver(kind, mu, v, line) {
  if (kind === 'count') {
    const k = Math.floor(line); // P(X <= k)
    let cdf = 0;
    if (v <= mu * 1.0001) { // Poisson
      let p = Math.exp(-mu); for (let i = 0; i <= k; i++) { cdf += p; p *= mu / (i + 1); }
    } else { // negative binomial with mean mu, variance v
      const r = mu * mu / (v - mu), q = mu / v; // q = success prob
      let p = Math.pow(q, r);
      for (let i = 0; i <= k; i++) { cdf += p; p *= (i + r) / (i + 1) * (1 - q); }
    }
    return Math.min(1, Math.max(0, 1 - cdf));
  }
  const shape = mu * mu / v, scale = v / mu;
  return 1 - gammaP(shape, Math.max(0, line) / scale);
}

// Empirical distribution: actual/projected ratios from training games, in 5 bins by projection size
function fitEmpirical(samples) {
  const s = samples.slice().sort((a, b) => a.mu - b.mu), nb = +(process.env.EMP_BINS || 5), size = Math.ceil(s.length / nb), bins = [];
  for (let i = 0; i < s.length; i += size) {
    const b = s.slice(i, i + size);
    // store 201 quantiles of the ratio x/mu
    const r = b.map(c => c.x / c.mu).sort((x, y) => x - y);
    bins.push({ maxMu: b[b.length - 1].mu, q: Array.from({ length: 201 }, (_, k) => r[Math.min(r.length - 1, Math.round(k / 200 * (r.length - 1)))]) });
  }
  bins[bins.length - 1].maxMu = Infinity;
  return bins;
}
function pOverEmp(bins, mu, line) {
  const b = bins.find(x => mu <= x.maxMu) || bins[bins.length - 1];
  const t = line / mu; // P(ratio > t), linear interpolation across quantiles
  const q = b.q;
  if (t < q[0]) return 1; if (t >= q[200]) return 0;
  let lo = 0, hi = 200;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (q[m] <= t) lo = m; else hi = m; }
  // last index with q <= t is lo (handle ties: move to the last tie)
  let k = lo; while (k < 200 && q[k + 1] <= t) k++;
  const frac = q[k + 1] > q[k] ? (t - q[k]) / (q[k + 1] - q[k]) : 0;
  return 1 - (k + frac) / 200;
}

// ---------- fitting ----------
function collect(statKey, o, seasons) {
  const st = STATS[statKey], out = [];
  for (const row of rows) {
    if (!seasons.includes(row.season) || row.week < 2 || !hasRole(row.r, st.role)) continue;
    const pr = project(row, statKey, o);
    if (!pr || pr.mu < st.minMu) continue;
    out.push({ row, mu: pr.mu, x: row.r[st.idx], naive: pr.raw });
  }
  return out;
}

// variance function v = a * mu^b, fitted on binned residuals (log-log regression)
function fitVariance(samples) {
  const s = samples.slice().sort((a, b) => a.mu - b.mu), bins = [];
  const n = 20, size = Math.ceil(s.length / n);
  for (let i = 0; i < s.length; i += size) {
    const b = s.slice(i, i + size); if (b.length < 30) continue;
    const m = b.reduce((a, c) => a + c.mu, 0) / b.length;
    const v = b.reduce((a, c) => a + (c.x - c.mu) ** 2, 0) / b.length;
    bins.push([Math.log(m), Math.log(v)]);
  }
  const mx = bins.reduce((a, b) => a + b[0], 0) / bins.length, my = bins.reduce((a, b) => a + b[1], 0) / bins.length;
  const bslope = bins.reduce((a, b) => a + (b[0] - mx) * (b[1] - my), 0) / bins.reduce((a, b) => a + (b[0] - mx) ** 2, 0);
  return { a: Math.exp(my - bslope * mx), b: bslope };
}

// test lines: a "book-like" line near the player's average, plus lines above and below
function testLines(statKey, s) {
  const step = STATS[statKey].kind === 'count' ? 1 : (statKey === 'passYds' ? 25 : 10);
  const base = Math.floor(s.naive) + 0.5;
  return [base - 2 * step, base - step, base, base + step, base + 2 * step].filter(l => l > 0);
}

function score(statKey, samples, varFn, mode = 'model') {
  const st = STATS[statKey];
  let brier = 0, logl = 0, n = 0, overAtAvg = 0, nAvg = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, hit: 0, n: 0 }));
  for (const s of samples) {
    const mu = mode === 'model' ? s.mu : s.naive;
    const v = mode === 'model' ? varFn.a * Math.pow(mu, varFn.b) : (st.kind === 'count' ? mu : varFn.naiveV(mu));
    for (const line of testLines(statKey, s)) {
      const dud = mode === 'model' ? (varFn.dud || 0) : 0; // chance of a near-zero "dud" game (injury, benching)
      const raw = mode === 'model' && varFn.emp ? pOverEmp(varFn.emp, mu, line) : (1 - dud) * pOver(st.kind, mu, Math.max(v, mu * 1.0001), line);
      const p = Math.min(0.999, Math.max(0.001, raw));
      const hit = s.x > line ? 1 : 0;
      brier += (p - hit) ** 2; logl -= hit ? Math.log(p) : Math.log(1 - p); n++;
      const b = cal[Math.min(9, Math.floor(p * 10))]; b.p += p; b.hit += hit; b.n++;
    }
    const avgLine = Math.floor(s.naive) + 0.5; // line at the player's (rounded) average
    nAvg++; if (s.x > avgLine) overAtAvg++;
  }
  return { n, brier: brier / n, logl: logl / n, cal, overAtAvg: overAtAvg / nAvg,
    mae: samples.reduce((a, s) => a + Math.abs((mode === 'model' ? s.mu : s.naive) - s.x), 0) / samples.length };
}

const TRAIN = [2021, 2022, 2023], TEST = [2024, 2025], NOW = [2026];
function priors(seasons) { // league mean of each stat among role players, for shrinkage
  const pr = {};
  for (const [k, st] of Object.entries(STATS)) {
    const xs = rows.filter(r => seasons.includes(r.season) && hasRole(r.r, st.role)).map(r => r.r[st.idx]);
    pr[k] = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (st.role === 'rush') {
      const q = rows.filter(r => seasons.includes(r.season) && hasRole(r.r, 'rush') && hasRole(r.r, 'pass')).map(r => r.r[st.idx]);
      const nq = rows.filter(r => seasons.includes(r.season) && hasRole(r.r, 'rush') && !hasRole(r.r, 'pass')).map(r => r.r[st.idx]);
      pr[k + ':qb'] = q.reduce((a, b) => a + b, 0) / q.length;
      pr[k] = nq.reduce((a, b) => a + b, 0) / nq.length;
    }
  }
  return pr;
}

module.exports = { impliedPts, pOverEmp, fitEmpirical, STATS, rows, byPlayer, names, project, pOver, fitVariance, collect, score, priors, oppFactor, hasRole, leagueAllowed, allowed };

if (require.main === module) {
  const mode = process.argv[2] || 'tune';
  const prior = priors(TRAIN);
  const results = {};
  for (const statKey of Object.keys(STATS)) {
    // tune projection params on TRAIN by squared error of the mean
    let best = null;
    for (const priorMode of ['league']) for (const gamma of [0, 0.5, 1, 1.5]) for (const decay of [0.8, 0.9, 1]) for (const lastSeason of [0, 0.25, 0.5, 1]) for (const shrink of [0, 1, 3, 6])
      for (const alpha of [0, 0.5, 1]) for (const beta of [0]) {
        const o = { priorMode, gamma, decay, lastSeason, shrink, alpha, beta, prior };
        const s = collect(statKey, o, TRAIN);
        const mse = s.reduce((a, c) => a + (c.mu - c.x) ** 2, 0) / s.length;
        if (!best || mse < best.mse) best = { o, mse };
      }
    const o = best.o;
    const train = collect(statKey, o, TRAIN), test = collect(statKey, o, TEST), now = collect(statKey, o, NOW);
    const varFn = fitVariance(train);
    let bestDud = 0, bestLL = Infinity;
    for (let d = 0; d <= 0.2001; d += 0.01) { varFn.dud = d; const ll = score(statKey, train, varFn).logl; if (ll < bestLL) { bestLL = ll; bestDud = d; } }
    varFn.dud = bestDud;
    // compare with the empirical distribution (fit and judged on TRAIN only)
    const emp = fitEmpirical(train);
    const llEmp = score(statKey, train, { ...varFn, emp }).logl;
    const useEmp = llEmp < bestLL;
    if (useEmp) varFn.emp = emp;
    // naive baseline: plain average (no opp/script/shrink), Poisson for counts, constant-CV gamma for yards
    const naiveO = { decay: 1, lastSeason: 1, shrink: 0, alpha: 0, beta: 0, prior };
    const nTrain = collect(statKey, naiveO, TRAIN);
    const cv2 = nTrain.reduce((a, c) => a + ((c.x - c.mu) / c.mu) ** 2, 0) / nTrain.length;
    varFn.naiveV = mu => cv2 * mu * mu;
    const nTest = collect(statKey, naiveO, TEST);
    results[statKey] = { params: { priorMode: o.priorMode, gamma: o.gamma, decay: o.decay, lastSeason: o.lastSeason, shrink: o.shrink, alpha: o.alpha, beta: o.beta }, var: { a: varFn.a, b: varFn.b, dud: varFn.dud }, dist: useEmp ? 'empirical' : (STATS[statKey].kind === 'count' ? 'negbin' : 'gamma'), emp: useEmp ? emp : undefined };
    const fmt = (nm, m) => `  ${nm.padEnd(22)} n=${String(m.n).padEnd(6)} MAE ${m.mae.toFixed(2).padStart(6)}  Brier ${m.brier.toFixed(4)}  LogLoss ${m.logl.toFixed(4)}  over-at-avg ${(m.overAtAvg * 100).toFixed(1)}%`;
    console.log(`\n=== ${STATS[statKey].label} ===  params ${JSON.stringify(results[statKey].params)}  var=${varFn.a.toFixed(3)}*mu^${varFn.b.toFixed(2)} dud=${(varFn.dud * 100).toFixed(0)}%  dist=${results[statKey].dist} (train logloss formula ${bestLL.toFixed(4)} vs empirical ${llEmp.toFixed(4)})`);
    console.log(fmt('Train 21-23 model', score(statKey, train, varFn)));
    const tm = score(statKey, test, varFn);
    console.log(fmt('TEST 24-25 model', tm));
    console.log(fmt('TEST 24-25 naive avg', score(statKey, nTest, varFn, 'naive')));
    const nm = score(statKey, now, varFn);
    console.log(fmt('2026 model', nm));
    const top = test.slice().sort((a, b) => b.mu - a.mu).slice(0, Math.ceil(test.length / 10));
    console.log(`  top-10% projections (test): avg projected ${(top.reduce((a, c) => a + c.mu, 0) / top.length).toFixed(1)} vs actual ${(top.reduce((a, c) => a + c.x, 0) / top.length).toFixed(1)}`);
    console.log('  calibration (test 24-25 + 2026): predicted -> actual');
    const cal = tm.cal.map((b, i) => ({ p: b.p + nm.cal[i].p, hit: b.hit + nm.cal[i].hit, n: b.n + nm.cal[i].n }));
    console.log('   ' + cal.filter(b => b.n >= 30).map(b => `${(b.p / b.n * 100).toFixed(0)}%→${(b.hit / b.n * 100).toFixed(0)}% (${b.n})`).join('  '));
  }
  fs.writeFileSync(path.join(DIR, 'props_params.json'), JSON.stringify({ prior, stats: results }, null, 1));
}
