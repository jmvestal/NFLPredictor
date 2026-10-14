// Builds proplines.json: DraftKings player prop lines (via ESPN's core API) for finished games.
// ESPN only keeps these for the current season. Usage: node --use-system-ca fetch_proplines.js 2026
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SEASONS = (process.argv[2] || '2026').split(',').map(Number);
const OUT = path.join(DIR, 'proplines.json');
const URL = id => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds/100/propBets?limit=1000`;

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

(async () => {
  const games = parseCsv(fs.readFileSync(path.join(DIR, 'games.csv'), 'utf8'))
    .filter(g => SEASONS.includes(+g.season) && g.home_score !== '' && g.espn);
  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const types = {};
  for (const g of games) {
    if (cache[g.espn]) continue;
    try {
      const r = await fetch(URL(g.espn));
      if (!r.ok) { console.warn(g.game_id, r.status); continue; }
      const d = await r.json();
      const seen = new Set(), list = [];
      for (const it of d.items || []) {
        const aid = /athletes\/(\d+)/.exec(it.athlete?.$ref || '')?.[1];
        const line = it.current?.target?.value;
        if (!aid || line == null) continue;
        const key = aid + '|' + it.type?.name + '|' + line;
        if (seen.has(key)) continue; // over/under come as two identical entries
        seen.add(key);
        list.push({ aid, type: it.type?.name, line, open: it.open?.target?.value ?? null });
      }
      cache[g.espn] = list;
    } catch (e) { console.warn(g.game_id, e.message); }
  }
  for (const list of Object.values(cache)) for (const p of list) types[p.type] = (types[p.type] || 0) + 1;
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log(`games with prop lines: ${Object.keys(cache).length}`);
  console.log(Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${n}  ${t}`).join('\n'));
})();
