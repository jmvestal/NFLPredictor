// Builds ../data/season-YYYY.json: offensive play counts and player box score lines for finished games,
// so the app (especially on a phone) doesn't have to download hundreds of full ESPN game summaries.
// Keyed by ESPN game id and side ('home'/'away'); the app maps sides to team ids from the scoreboard.
// Usage: node build_snapshot.js 2025,2026   (run fetch_boxscores.js / fetch_players.js first)
const fs = require('fs');
const path = require('path');
const DIR = __dirname, OUT = path.join(DIR, '..', 'data');
const seasons = (process.argv[2] || '2025,2026').split(',').map(Number);
const box = JSON.parse(fs.readFileSync(path.join(DIR, 'boxscores.json'), 'utf8'));
const pl = JSON.parse(fs.readFileSync(path.join(DIR, 'players.json'), 'utf8'));
const csv = fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8').split('\n');
const head = csv[0].split(','), iSeason = head.indexOf('season'), iEspn = head.indexOf('espn'), iScore = head.indexOf('home_score');
fs.mkdirSync(OUT, { recursive: true });
for (const season of seasons) {
  const snap = { season, built: new Date().toISOString(), plays: {}, players: {}, names: {} };
  for (const line of csv.slice(1)) {
    const f = line.split(',');
    // games.csv has quoted fields only after these columns, so a plain split is safe for season/score/espn
    if (+f[iSeason] !== season || f[iScore] === '' || !f[iEspn]) continue;
    const id = f[iEspn], b = box[id], p = pl.games[id];
    if (!b || !p) continue;
    snap.plays[id] = { home: b.home.plays, away: b.away.plays };
    const side = s => Object.fromEntries(Object.entries(p[s]).filter(([, r]) => r.some(v => v)));
    snap.players[id] = { home: side('home'), away: side('away') };
    for (const pid of [...Object.keys(snap.players[id].home), ...Object.keys(snap.players[id].away)]) snap.names[pid] = p.names[pid];
  }
  const file = path.join(OUT, `season-${season}.json`);
  fs.writeFileSync(file, JSON.stringify(snap));
  console.log(`${file}: ${Object.keys(snap.plays).length} games, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
