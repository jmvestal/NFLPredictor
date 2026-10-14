// Builds boxscores.json: per ESPN game id, each side's offensive plays, yards, and points split into
// offensive (rush/pass TDs, FGs, conversions) vs. non-offensive (return TDs, defensive scores, safeties).
// Usage: node --use-system-ca fetch_boxscores.js 2020,2021,2022,2023,2024,2025
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SEASONS = (process.argv[2] || '2020,2021,2022,2023,2024,2025').split(',').map(Number);
const OUT = path.join(DIR, 'boxscores.json');
const SUMMARY = id => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`;

// Scores credited to the offense; everything else (returns, defensive TDs, safeties) is non-offensive
const OFFENSIVE = /^(Rushing Touchdown|Passing Touchdown|Receiving Touchdown|Field Goal Good|Two-Point|Two Point|Extra Point)/i;

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

function extract(s) {
  const out = {}, idSide = {};
  for (const t of s.boxscore?.teams || []) {
    const stat = n => +(t.statistics.find(x => x.name === n)?.displayValue ?? NaN);
    out[t.homeAway] = { plays: stat('totalOffensivePlays'), yards: stat('totalYards'), turnovers: stat('turnovers'), offPts: 0, nonOffPts: 0 };
    idSide[t.team.id] = t.homeAway;
  }
  if (!out.home || !out.away) return null;
  let prevH = 0, prevA = 0;
  for (const sp of s.scoringPlays || []) {
    const dH = sp.homeScore - prevH, dA = sp.awayScore - prevA;
    prevH = sp.homeScore; prevA = sp.awayScore;
    const type = sp.type?.text || '';
    for (const [side, d] of [['home', dH], ['away', dA]]) {
      if (d <= 0) continue;
      // a defensive 2-pt return or safety credited to the other side shows up as that side's score change
      const scorer = idSide[sp.team?.id];
      const offensive = OFFENSIVE.test(type) && scorer === side;
      out[side][offensive ? 'offPts' : 'nonOffPts'] += d;
    }
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

(async () => {
  const games = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'))
    .filter(g => SEASONS.includes(+g.season) && g.home_score !== '' && g.espn);
  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const need = games.filter(g => !cache[g.espn]);
  console.log(`${games.length} games, ${need.length} to fetch`);
  let done = 0, failed = 0;
  await pool(need, 12, async g => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(SUMMARY(g.espn));
        if (!r.ok) throw new Error(r.status);
        const x = extract(await r.json());
        if (x) cache[g.espn] = x; else failed++;
        break;
      } catch (e) { if (attempt === 2) { failed++; console.warn('failed', g.game_id, e.message); } }
    }
    if (++done % 100 === 0) { console.log(`${done}/${need.length}`); fs.writeFileSync(OUT, JSON.stringify(cache)); }
  });
  fs.writeFileSync(OUT, JSON.stringify(cache));
  // sanity check: offensive + non-offensive points should equal the final score
  let bad = 0;
  for (const g of games) {
    const b = cache[g.espn]; if (!b) continue;
    if (b.home.offPts + b.home.nonOffPts !== +g.home_score || b.away.offPts + b.away.nonOffPts !== +g.away_score) bad++;
  }
  console.log(`done. failed ${failed}. score mismatches ${bad}/${games.length}`);
})();
