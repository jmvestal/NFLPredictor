// How the upgraded model does in special situations (backup QBs, international games, fired coaches, etc.)
// Usage: node caveats.js
const { ALL, ratings, predict, ORIGINAL, profit, mlToProb } = require('./model2.js');

const CFG = { ...ORIGINAL, prevGames: 4, qbPen: 3 };
const NO_QB = { ...CFG, qbPen: 0 };

// Week-1 head coach per team-season, to spot mid-season firings (interim/new coach)
const week1Coach = {};
for (const g of ALL) {
  if (g.type !== 'REG') continue;
  for (const [t, c] of [[g.home, g.raw.home_coach], [g.away, g.raw.away_coach]]) {
    const k = g.season + t, w = week1Coach[k];
    if (!w || g.week < w.week) week1Coach[k] = { week: g.week, coach: c };
  }
}
// nflverse never switched the coach name to the interim for these, so they're added by hand:
// season+team -> first week under the interim coach
const MANUAL_FIRINGS = { '2024NO': 10, '2024CHI': 13, '2025TEN': 7 };
// Primary QB so far this season (most starts before this week)
function primaryQb(season, week, team) {
  const n = {};
  for (const g of ALL) if (g.season === season && g.week < week) {
    if (g.home === team && g.hqb) n[g.hqb] = (n[g.hqb] || 0) + 1;
    if (g.away === team && g.aqb) n[g.aqb] = (n[g.aqb] || 0) + 1;
  }
  let best = null, k = 0;
  for (const [q, c] of Object.entries(n)) if (c > k) { k = c; best = q; }
  return best;
}

const rows = [];
for (const g of ALL) {
  if (g.season < 2021 || g.week < 2) continue;
  const R = ratings(g.season, g.week, CFG);
  const p = predict(R, g, CFG), p0 = predict(R, g, NO_QB);
  if (!p) continue;
  const r = g.raw;
  const hBackup = primaryQb(g.season, g.week, g.home), aBackup = primaryQb(g.season, g.week, g.away);
  const backup = (hBackup && g.hqb && g.hqb !== hBackup) || (aBackup && g.aqb && g.aqb !== aBackup);
  const fired = t => { const mf = MANUAL_FIRINGS[g.season + t]; if (mf && g.type === 'REG' && g.week >= mf) return true;
    const w = week1Coach[g.season + t]; return w && w.coach !== (t === g.home ? r.home_coach : r.away_coach); };
  const wind = +r.wind, temp = +r.temp, outdoors = r.roof === 'outdoors' || r.roof === 'open';
  rows.push({ g, p, p0, flags: {
    backup,
    international: g.neutral && g.type === 'REG',
    firedCoach: fired(g.home) || fired(g.away),
    divisional: r.div_game === '1',
    shortRest: +r.home_rest <= 4 || +r.away_rest <= 4,
    offBye: +r.home_rest >= 13 || +r.away_rest >= 13,
    badWeather: outdoors && ((r.wind !== '' && wind >= 15) || (r.temp !== '' && temp <= 25)),
    playoffs: g.type !== 'REG',
    early: g.type === 'REG' && g.week <= 5
  } });
}

function score(rs, which = 'p') {
  const m = { n: rs.length, su: 0, dec: 0, vsu: 0, err: 0, verr: 0, ml: [0, 0, 0], ats: [0, 0, 0], ou: [0, 0, 0] };
  const bet = (b, won, odds) => { if (won) { b[0]++; b[2] += profit(odds); } else { b[1]++; b[2] -= 100; } };
  for (const row of rs) {
    const { g } = row, p = row[which];
    const act = g.hs - g.as, tot = g.hs + g.as;
    m.err += Math.abs(p.margin - act); if (g.spread != null) m.verr += Math.abs(g.spread - act);
    if (act) {
      m.dec++; if ((p.margin > 0) === (act > 0)) m.su++;
      if (g.hml != null && g.aml != null) {
        const mk = mlToProb(g.hml) / (mlToProb(g.hml) + mlToProb(g.aml));
        if ((mk > 0.5) === (act > 0)) m.vsu++;
        const fh = p.pHome >= 0.5; bet(m.ml, (act > 0) === fh, fh ? g.hml : g.aml);
      }
    }
    if (g.spread != null && act !== g.spread) { const ph = p.margin > g.spread; bet(m.ats, (act > g.spread) === ph, ph ? g.hso : g.aso); }
    if (g.tl != null && tot !== g.tl) { const ov = p.total > g.tl; bet(m.ou, (tot > g.tl) === ov, ov ? g.oo : g.uo); }
  }
  return m;
}
const pc = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
const rec = b => `${b[0]}-${b[1]} (${pc(b[0], b[0] + b[1])}) ${b[2] >= 0 ? '+' : ''}$${b[2].toFixed(0)}`;
const show = (name, m) => console.log(`${name.padEnd(34)} n=${String(m.n).padEnd(5)} Winners ${pc(m.su, m.dec).padEnd(6)} (Vegas ${pc(m.vsu, m.dec).padEnd(6)}) ` +
  `MarginErr ${(m.err / m.n).toFixed(1)} (V ${(m.verr / m.n).toFixed(1)}) | ML ${rec(m.ml)} | ATS ${rec(m.ats)} | O/U ${rec(m.ou)}`);

const past = rows.filter(r => r.g.season <= 2025), now = rows.filter(r => r.g.season === 2026);
console.log('==== 2021-2025 (upgraded model) ====');
show('All games', score(past));
const labels = { backup: 'Backup QB starting (either team)', international: 'International games', firedCoach: 'Team with fired coach (interim/new)',
  divisional: 'Division rivals', shortRest: 'Short week (Thursday)', offBye: 'Team coming off bye', badWeather: 'Cold (<=25F) or windy (15+ mph)',
  playoffs: 'Playoffs', early: 'Weeks 2-5' };
for (const [k, l] of Object.entries(labels)) {
  show(l, score(past.filter(r => r.flags[k])));
  if (k === 'backup') show('  ...same games WITHOUT QB penalty', score(past.filter(r => r.flags[k]), 'p0'));
}
show('None of the above', score(past.filter(r => !Object.values(r.flags).some(Boolean))));

console.log('\n==== 2026 weeks 2-5 (this season so far) ====');
show('All games', score(now));
for (const [k, l] of Object.entries(labels)) { const s = now.filter(r => r.flags[k]); if (s.length) show(l, score(s)); }
for (const w of [2, 3, 4, 5]) show(`  Week ${w}`, score(now.filter(r => r.g.week === w)));

// detail lists for the rare situations this season
console.log('\n2026 special-situation games:');
for (const r of now) {
  const f = Object.entries(r.flags).filter(([k, v]) => v && k !== 'early' && k !== 'divisional').map(([k]) => k);
  if (!f.length) continue;
  const g = r.g, right = (r.p.margin > 0) === (g.hs > g.as);
  console.log(`  Wk${g.week} ${g.away} ${g.as} @ ${g.home} ${g.hs}  [${f.join(', ')}]  model: ${r.p.margin > 0 ? g.home : g.away} by ${Math.abs(r.p.margin).toFixed(1)} ${right ? '✓' : '✗'}`);
}
const firings = Object.entries(week1Coach).length;
const changes = new Set([...rows.filter(r => r.flags.firedCoach && !MANUAL_FIRINGS[r.g.season + r.g.home] && !MANUAL_FIRINGS[r.g.season + r.g.away]).map(r => r.g.season + ' ' + (week1Coach[r.g.season + r.g.home].coach !== r.g.raw.home_coach ? r.g.home : r.g.away)), ...Object.keys(MANUAL_FIRINGS).map(k => k.slice(0, 4) + ' ' + k.slice(4))]);
console.log('\nMid-season coach changes found:', [...changes].sort().join(', '));
