// Calibration of Over/Under chances for star players only (top 10% by recent average), 2024-26
const P = require('./props.js');
const prm = require('./props_params.json');
for (const sk of Object.keys(P.STATS)) {
  const st = P.STATS[sk], ps = prm.stats[sk];
  const s = P.collect(sk, { ...ps.params, prior: prm.prior }, [2024, 2025, 2026]);
  const cut = s.map(c => c.naive).sort((a, b) => b - a)[Math.floor(s.length * 0.1)];
  const stars = s.filter(c => c.naive >= cut);
  const cal = Array.from({ length: 5 }, () => ({ p: 0, hit: 0, n: 0 }));
  let meanAdj = 0;
  for (const c of stars) {
    const step = st.kind === 'count' ? 1 : (sk === 'passYds' ? 25 : 10);
    const base = Math.floor(c.naive) + 0.5;
    for (const line of [base - 2 * step, base - step, base, base + step, base + 2 * step]) {
      if (line <= 0) continue;
      const p = P.pOverEmp(ps.emp, c.mu, line), hit = c.x > line ? 1 : 0;
      const b = cal[Math.min(4, Math.floor(p * 5))]; b.p += p; b.hit += hit; b.n++;
    }
    const bin = ps.emp.find(b => c.mu <= (b.maxMu ?? Infinity)) || ps.emp[ps.emp.length - 1];
    meanAdj += c.mu * bin.q.reduce((a, b) => a + b, 0) / bin.q.length - c.x;
  }
  console.log(`${st.label.padEnd(16)} stars n=${String(stars.length).padEnd(5)} proj bias ${(stars.reduce((a, c) => a + c.mu - c.x, 0) / stars.length).toFixed(1).padStart(6)}  dist-mean bias ${(meanAdj / stars.length).toFixed(1).padStart(6)}   ` +
    cal.filter(b => b.n >= 20).map(b => `${(b.p / b.n * 100).toFixed(0)}%→${(b.hit / b.n * 100).toFixed(0)}%`).join('  '));
}
