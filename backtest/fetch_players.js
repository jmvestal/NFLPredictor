// Builds players.json: per ESPN game id, each player's passing/rushing/receiving line from the ESPN box score.
// Usage: node --use-system-ca fetch_players.js 2020,2021,2022,2023,2024,2025,2026
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SEASONS = (process.argv[2] || '2020,2021,2022,2023,2024,2025,2026').split(',').map(Number);
const OUT = path.join(DIR, 'players.json');
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
  const [h, ...data] = rows;
  return data.filter(r => r.length === h.length).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

// Compact per-player record: [cmp, att, passYds, passTD, int, rushAtt, rushYds, rushTD, rec, recYds, recTD, tgt]
const FIELDS = ['cmp', 'att', 'passYds', 'passTD', 'int', 'rushAtt', 'rushYds', 'rushTD', 'rec', 'recYds', 'recTD', 'tgt'];
function extract(s) {
  const out = { home: {}, away: {}, names: {} };
  const sideOf = {};
  for (const c of s.header?.competitions?.[0]?.competitors || []) sideOf[c.team.id] = c.homeAway;
  for (const t of s.boxscore?.players || []) {
    const side = sideOf[t.team.id];
    if (!side) continue;
    for (const cat of t.statistics) {
      for (const a of cat.athletes || []) {
        const id = a.athlete.id;
        out.names[id] = a.athlete.displayName;
        const r = out[side][id] ??= new Array(FIELDS.length).fill(0);
        const v = Object.fromEntries(cat.keys.map((k, i) => [k, a.stats[i]]));
        const n = x => { const y = parseFloat(x); return isFinite(y) ? y : 0; };
        if (cat.name === 'passing') {
          const [c, at] = (v['completions/passingAttempts'] || '0/0').split('/');
          r[0] = n(c); r[1] = n(at); r[2] = n(v.passingYards); r[3] = n(v.passingTouchdowns); r[4] = n(v.interceptions);
        } else if (cat.name === 'rushing') {
          r[5] = n(v.rushingAttempts); r[6] = n(v.rushingYards); r[7] = n(v.rushingTouchdowns);
        } else if (cat.name === 'receiving') {
          r[8] = n(v.receptions); r[9] = n(v.receivingYards); r[10] = n(v.receivingTouchdowns); r[11] = n(v.receivingTargets);
        }
      }
    }
  }
  return Object.keys(out.home).length && Object.keys(out.away).length ? out : null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

(async () => {
  const games = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'))
    .filter(g => SEASONS.includes(+g.season) && g.home_score !== '' && g.espn);
  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { fields: FIELDS, games: {} };
  const need = games.filter(g => !cache.games[g.espn]);
  console.log(`${games.length} games, ${need.length} to fetch`);
  let done = 0, failed = 0;
  await pool(need, 12, async g => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(SUMMARY(g.espn));
        if (!r.ok) throw new Error(r.status);
        const x = extract(await r.json());
        if (x) cache.games[g.espn] = x; else failed++;
        break;
      } catch (e) { if (attempt === 2) { failed++; console.warn('failed', g.game_id, e.message); } }
    }
    if (++done % 100 === 0) { console.log(`${done}/${need.length}`); fs.writeFileSync(OUT, JSON.stringify(cache)); }
  });
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log(`done. failed ${failed}. total games ${Object.keys(cache.games).length}`);
})();
