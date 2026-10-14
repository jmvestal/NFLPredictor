// Builds ../data/season-YYYY.json: offensive play counts, player box score lines and closing betting lines for
// finished games, so the app (especially on a phone) doesn't have to download hundreds of full ESPN game summaries,
// and past weeks can still show what the Vegas-based pick was (ESPN drops the odds once a game is final).
// Keyed by ESPN game id and side ('home'/'away'); the app maps sides to team ids from the scoreboard.
// Usage: node build_snapshot.js 2025,2026   (run fetch_boxscores.js / fetch_players.js first, and refresh games.csv)
const fs = require('fs');
const path = require('path');
const DIR = __dirname, OUT = path.join(DIR, '..', 'data');
const seasons = (process.argv[2] || '2025,2026').split(',').map(Number);
const box = JSON.parse(fs.readFileSync(path.join(DIR, 'boxscores.json'), 'utf8'));
const pl = JSON.parse(fs.readFileSync(path.join(DIR, 'players.json'), 'utf8'));

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
const games = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'));

fs.mkdirSync(OUT, { recursive: true });
for (const season of seasons) {
  const snap = { season, built: new Date().toISOString(), plays: {}, players: {}, names: {}, odds: {} };
  for (const g of games) {
    if (+g.season !== season || g.home_score === '' || !g.espn) continue;
    const id = g.espn, b = box[id], p = pl.games[id];
    // closing lines (nflverse spread_line > 0 = home favored; the app's homeSpread is the home team's line, < 0 = favored)
    const hml = num(g.home_moneyline), aml = num(g.away_moneyline), sp = num(g.spread_line), tl = num(g.total_line);
    if (hml != null && aml != null) snap.odds[id] = { homeMl: hml, awayMl: aml, homeSpread: sp == null ? null : -sp, total: tl };
    if (!b || !p) continue;
    snap.plays[id] = { home: b.home.plays, away: b.away.plays };
    const side = s => Object.fromEntries(Object.entries(p[s]).filter(([, r]) => r.some(v => v)));
    snap.players[id] = { home: side('home'), away: side('away') };
    for (const pid of [...Object.keys(snap.players[id].home), ...Object.keys(snap.players[id].away)]) snap.names[pid] = p.names[pid];
  }
  const file = path.join(OUT, `season-${season}.json`);
  fs.writeFileSync(file, JSON.stringify(snap));
  console.log(`${file}: ${Object.keys(snap.plays).length} games, ${Object.keys(snap.odds).length} with closing lines, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
