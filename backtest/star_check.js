// Compare league vs player-specific baselines on "prop-worthy" players (top 40% of projections)
const P = require('./props.js');
const prior = P.priors([2021, 2022, 2023]);
for (const sk of ['recYds', 'rec', 'rushYds', 'passYds']) {
  for (const priorMode of ['league', 'player']) {
    let best = null;
    for (const decay of [0.8, 0.9, 1]) for (const lastSeason of [0, 0.25, 0.5, 1]) for (const shrink of [0, 1, 3, 6]) for (const alpha of [0, 0.5]) {
      const o = { priorMode, decay, lastSeason, shrink, alpha, beta: 0, prior };
      const s = P.collect(sk, o, [2021, 2022, 2023]);
      // naive (unshrunk) average decides who is "prop-worthy", so the population is the same for every config
      const cut = s.map(c => c.naive).sort((a, b) => b - a)[Math.floor(s.length * 0.4)];
      const top = s.filter(c => c.naive >= cut);
      const mse = top.reduce((a, c) => a + (c.mu - c.x) ** 2, 0) / top.length;
      if (!best || mse < best.mse) best = { o, mse };
    }
    const test = P.collect(sk, best.o, [2024, 2025, 2026]);
    const cut = test.map(c => c.naive).sort((a, b) => b - a)[Math.floor(test.length * 0.4)];
    const top = test.filter(c => c.naive >= cut);
    const mae = top.reduce((a, c) => a + Math.abs(c.mu - c.x), 0) / top.length;
    const bias = top.reduce((a, c) => a + c.mu - c.x, 0) / top.length;
    const stars = test.filter(c => c.naive >= test.map(c => c.naive).sort((a, b) => b - a)[Math.floor(test.length * 0.1)]);
    const sb = stars.reduce((a, c) => a + c.mu - c.x, 0) / stars.length;
    console.log(`${sk.padEnd(8)} ${priorMode.padEnd(7)} ${JSON.stringify({ d: best.o.decay, l: best.o.lastSeason, s: best.o.shrink, a: best.o.alpha })}  test top-40%: MAE ${mae.toFixed(2)} bias ${bias.toFixed(2)} | top-10% bias ${sb.toFixed(2)}`);
  }
}
