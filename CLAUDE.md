# NFL Predictor

Single-file HTML app (`index.html`, vanilla JS, no build) that projects NFL scores and moneylines from **the user's own points-per-play model**, plus Node backtest scripts in `backtest/`. Started 2026-10-12 (2026 season, Week 5/6).

The user is a beginner at betting math and prefers plain-language explanations with worked examples. The model is the user's idea: keep its core formula and test any change against it rather than replacing it.

## The model

For each team, from completed regular-season games **before** the week being predicted:

- **Off PPP** = points scored ÷ own offensive plays
- **Def PPP** = points allowed ÷ opponent offensive plays (lower is better)
- **Plays/G** = own offensive plays per game

```
Team A pts = ( A.OffPPP × A.Plays/G  +  B.DefPPP × A.Plays/G ) ÷ 2   + home pts (if home) − backup-QB penalty
win prob   = NormalCDF(margin / 13.5)
fair ML    = p ≥ .5 ? −100p/(1−p) : 100(1−p)/p
```

Upgrades the user approved after a 2021-25 backtest:
1. **Last-season blend:** add 4 games' worth of last season's per-game averages (points for/against, plays) into each team's totals. Fades naturally as the season goes on.
2. **Backup QB:** −3 pts to a team starting someone other than its primary QB. Manual checkbox in the app (ESPN doesn't publish starters ahead of time).
3. **Home field = 0** by default. Adding 0.5–2 pts made winner-picking worse in testing.

Example (Week 5, BUF @ LAR, upgraded): BUF (0.488 × 61.6 = 30.0) + (LAR Def 0.336 × 61.6 = 20.7) ÷ 2 = 25.4; LAR 25.9. Rams 51%, model lean BUF +3.5 / Under 54.5.

## Running it

- **App:** must be served over http, because the ESPN fetches fail from file://. Use the `nflpredictor` config in `.claude/launch.json` (`python -m http.server 8811`), or `npx serve -p 8811 .`. On the user's Mac, change `python` to `python3` in launch.json (or use npx serve). The first load pulls ~350 ESPN box scores (this season + last season) and caches them in localStorage.
- **Backtests:** `cd backtest`, then:
  - `node model2.js eval '{"prevGames":4,"qbPen":3}'`: per-season results for any config. Keys: `prevGames`, `qbPen`, `hfa`, `wy` (yards-per-play weight), `offOnly` (exclude defensive/special-teams points), `sd`.
  - `node model2.js tune`: grid search tuned on 2021-23, tested on 2024-25.
  - `node caveats.js`: results split by situation (backup QB, international, fired coach, Thursday, weather, and so on).
  - `node --use-system-ca fetch_boxscores.js 2026`: refresh this season's box scores (needs a fresh `games.csv` for new weeks).
  - Re-download odds and scores: `curl -L https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv -o games.csv`
  - On the original work PC, Node's fetch needed `--use-system-ca` (corporate TLS). It may not be needed at home.

## Data sources

- **ESPN site API** (`site.api.espn.com/apis/site/v2/sports/football/nfl/`; CORS open, no key):
  - `scoreboard?dates=YYYY&seasontype=2&week=N` gives schedule, scores, and live DraftKings ML/spread/total for upcoming games only.
  - `summary?event=ID` gives `boxscore.teams[].statistics` (`totalOffensivePlays`, `totalYards`) and `scoringPlays`.
- **nflverse `games.csv`:** historical closing ML/spread/total (`spread_line` > 0 = home favored), starting QB ids, coaches, rest, weather, and the `espn` id used to join to ESPN.
  - Caveat: the coach column didn't switch to the interim for 2024 NO (from wk 10), 2024 CHI (wk 13), or 2025 TEN (wk 7). These are hard-coded in caveats.js.
- **Caches:** `boxscores.json` (2020-2026: plays, yards, offensive vs non-offensive points per side; verified to sum to final scores) and `plays.json` (older, plays only).

## Backtest results (walk-forward, Week 1 skipped, $100 flat bets at closing odds)

| 2021-25, 1,344 games | Original | Upgraded | Vegas fav |
|---|---|---|---|
| Winners picked | 60.3% | **64.1%** | 66.7% |
| ML on model's pick | −$8,198 | −$2,703 | |
| ATS | 48.4% | 50.2% | (52.4% to break even) |
| O/U | 48.6% | 47.4% | |

Upgraded winners by season (original in brackets): 2021 65.3% (58.2), 2022 61.4% (56.6), 2023 63.2% (58.4), 2024 66.5% (65.4), 2025 63.8% (63.1). It beat the original every year.

Other findings:
- **Rejected:** yards per play, excluding defensive/special-teams points, home-field points, and opponent (strength-of-schedule) adjustment. The opponent adjustment helped 2024 but hurt 2025, i.e. overfit.
- **"Value" bets** (model likes an underdog more than the book does) consistently lost money. The bigger the "edge", the worse. Tell the user this honestly.
- **2026 Weeks 2-5:** the upgraded model is 33-28 (54.1%) vs Vegas fav 62.3%. ATS 30-27, O/U 21-41.

## Situations (2021-25, upgraded model; winners vs Vegas fav)

- Backup QB starting: 67.0% vs 69.5%. Without the −3 it would be 64.6%, so the penalty helps.
- International games: 87.0% vs 69.6% (n=23, small sample).
- Team with fired/interim coach: 67.1% vs 65.9% (n=82). No adjustment needed.
- Thursday/short week: **58.6% vs 69.0%** (weakest spot; 0-4 in 2026).
- Cold (≤25°F) or windy (≥15 mph): winners fine, but ATS 42% and O/U 45%, so avoid totals.
- Weeks 2-5: 57.8% vs 62.0%. Playoffs: 61.5% vs 63.1%.

## Pick/skip rules (backtest/picks.js, 2021-25 + 2026)

Only patterns that held in both 2021-23 and 2024-25 count:
- **Pick winners** when the model agrees with the Vegas favorite and is 60%+ (73.5% right).
- **Moneyline:** only the 60-65% confidence bucket made money in both periods (+2-4%).
- **Skip:** toss-ups (<55%, 53% right); games where the model picks the underdog (43%); moneyline edges of 10%+ (−19% / −24% ROI, the worst bets found); spreads 5+ pts off the line; all totals; Thursday games; Weeks 2-5 for betting.
- Weeks 6-10 is the model's best stretch.

## Player props (Player Props tab; backtest/props.js)

Data: per-player box score lines from ESPN summaries (`backtest/players.json`, built by `fetch_players.js`; the app stores the same lines in localStorage).

Model, per stat (receptions, receiving yds, rush att, rushing yds, completions, passing yds, passing TDs):
- **Projection:** weighted average of the player's games in that role (this season + last season, recency-decayed), shrunk toward a league baseline with k pseudo-games. QBs get their own rushing baseline, and every QB game counts for QB rushing history. This is multiplied by an opponent factor (stat allowed per game vs league, shrunk) raised to `alpha`.
- **Over/Under chances:** empirical distribution of actual÷projected from 2021-23 games, in 5 bins by projection size (quantiles embedded in index.html as `PROPS`). It beat negative-binomial/gamma fits on every stat.
- **Shown "Proj"** = projection × the bin's mean ratio (corrects the shrinkage pull on stars). "Median" = projection × the bin's median ratio.
- Game-script (projected margin) adjustment tested and not used: beta = 0 for every stat.

Results (tuned 2021-23, tested 2024-25 + 2026):
- Calibration is good on every stat. Predicted 45% → actual 45-47%, 75% → 74-76%.
- Beats a plain season average on accuracy for every stat.
- **Star players (top 10%):** the Over chance runs ~3-5 pts low on receiving yds, rushing yds and receptions. The shrinkage also pulls backups up a bit, so the model is best for starters.
- A line set at a player's average goes Under ~56-58% for receivers/RBs (median < mean); QBs are ~50/50.
- **No historical prop lines**, so profitability is untested. Props usually cost −115 both ways (53.5% to break even).

To refit: `node props.js tune` writes `props_params.json`. Then re-export to `props_app_params.json` (snippet in the session history) and replace the `const PROPS = …;` line in index.html.

## GitHub: how the computers stay in sync

- Repo: **https://github.com/jmvestal/NFLPredictor** (public). Hosted with GitHub Pages at **https://jmvestal.github.io/NFLPredictor/** (Settings → Pages → Deploy from branch `main`, folder `/`).
- **Start of every session:** `git pull`. **End:** commit and `git push`. That replaces emailing handoff files.
- Not in the repo (see `.gitignore`):
  - Large backtest caches: rebuild with the fetch scripts.
  - `.claude/launch.json`: per machine. Create it with `python -m http.server 8811` on Windows or `python3 -m http.server 8811` on Mac.
- Windows work PC: Git Credential Manager handles login. The Mac uses a classic token (public_repo scope) in its keychain. Never paste tokens into chat.
- After changing `index.html`, bump `CACHE` in `sw.js` (e.g. `nflp-shell-v2`) so installed phone apps pick up the new version.
- Weekly: `cd backtest && node build_snapshot.js 2025,2026` refreshes `data/season-*.json` (needs the fetch caches). Then commit and push.

## Navigation and phone app (latest)

- Header has two swipeable rows. **Week tabs** (Wk 2-18; the upcoming week is selected) set `curWeek` via `setWeek()`. **Section tabs**: Games | QB | RB | WR/TE | Props | Tracker | Model | Teams. The last-used tab is remembered.
- **QB / RB / WR/TE** tabs (`renderPosition`) show that position's system (`systemCardsHtml(week, [sys])`) and DraftKings props rated by realistic %, with a "Show all props" toggle.
  - Position = QB if 10+ attempts in a game; RB if more carries than targets; else WR/TE (`playerPos`).
- Installable PWA: `manifest.json`, `sw.js` (network-first app shell), `icons/`.
- `data/season-YYYY.json` snapshots of finished games are built with `backtest/build_snapshot.js 2025,2026`. Rebuild weekly so phones download less; the first load drops from ~150 MB to ~300 KB.
- Not yet hosted. The user was offered GitHub+Vercel (like DealFinder), Netlify Drop, or same-Wi-Fi only, and dismissed the question; ask again before deploying.

## App tabs (added 2026-10-13)

- **This Week** (default): every game labeled PICK / LEAN / SKIP by `gameCall()` using the pick/skip rules above. It suggests a moneyline bet only for PICKs at 60-65% from Week 6 on, never spreads/totals, and shows the top 3 rated props per game, backup-QB warnings and skill-position injuries.
- **Games**: the detailed view. Backup QB is automatic: the team's primary QB (most pass attempts over the last 3 games) listed Out/Doubtful/IR. The checkbox overrides it (`qbManual` in localStorage).
- **Player Props**: DraftKings lines auto-fill (blue), with prices assumed −115 (editable). Includes a "★ Best props this week" view and a ROLE? flag when a teammate at a related position is Out/Doubtful; those props get no rating.
- **Tracker**: + Track buttons log picks to localStorage; they auto-grade from final scores and box scores (DNP = void), with editable odds and stake, and show record/profit/ROI.
- Week extras (`loadWeekExtras`) fetch per game: injuries from `summary?event=ID` (`injuries[]`) and DK props from `sports.core.api.espn.com/.../events/ID/competitions/ID/odds/100/propBets?limit=1000`. Both are CORS-open.

## Props vs real DraftKings lines (backtest/prop_lines_test.js)

ESPN keeps DK prop lines (line only, no prices) for **current-season** games only; 2023-25 return 404. `fetch_proplines.js` builds `proplines.json`.
2026 weeks 2-5, 2,258 props, assuming −115:
- All model picks: 53.9%.
- Receptions, rushing yds and rush attempts beat the lines (55-58%); receiving yds (50.3%) and passing yds (48.7%) did not.
- The model is **overconfident when it disagrees with DK**: 55-70% picks hit ~54%, 70-80% ~58%, 80%+ ~67%. Big disagreements also usually carry steep real prices.
- So the app shows a **realistic %** = 0.5 + trust × (model% − 0.5), with trust 0.45 for rec/rushYds/rushAtt/cmp, 0.3 for passTD and 0.1 for recYds/passYds (fitted on these same lines, so in-sample). Rating: STRONG if realistic − break-even ≥ 4.5 pts, LEAN if ≥ 1.5. "Bet at or better" = fair odds of (realistic − 1.5%).
  - In-sample: STRONG 58.1% (predicted ~61%), LEAN 56.0%, unrated 52.5%.
- Known weakness: backups are projected high (shrinkage toward the RB average), e.g. low rushing lines for RB2s.
- Re-check this every few weeks with `node fetch_proplines.js 2026 && node prop_lines_test.js`. Refetch box scores/players first, and refit the trust factors as the sample grows.

## LINEMAKER SPORTS (YouTube) systems and our versions

The channel sells "high-probability" alt props: past hit rate = "true probability", plus a matchup filter, bet when it beats the price. Transcripts were read from 3 NFL videos. Tested 2021-26 in `linemaker_test.js`, `linemaker_seasons.js` and `systems_qbwr.js`:
- **His RB 30+ rushing** (RB 14+ carries/g, opponent allows 4.0+ YPC, 30+ in 90%+ of last 2 seasons): **89.8%** over 342 bets (his estimate 95%). Profitable 5 of 6 seasons at −600; break-even at about −800.
- **His QB 1+ pass TD** (90%+ last season, same team; opponent allows 1.5+ TD/g): 86.6% (his estimate 96%). **2025 hit 68.8%.**
- **His RB ladder vs bad run D** alone: 83% at 30+, which loses at his own example price (86%).
- **Ours, QB 1+ TD** (passTD model P ≥ 85%, Vegas-aware): **86.6% over 831 bets**, worst season 81%. Bet at −450 or better.
- **Ours, WR/TE 3+ receptions** (model ≥ 85% and 3+ in ≥ 85% of last 2 seasons): **92.4% over 578 bets**, worst 89%. Bet at −800 or better.
- His "true probability" (past hit rate) ran 5-10 pts high; our model's estimates matched outcomes.
- All three are in the app ("Systems this week" on This Week, `systemBets()` / `SYSTEMS`).

## Vegas team-total factor (props.js `gamma`)

Projection × (Vegas implied team points ÷ the team's points in the player's history games)^gamma. "History games" means actual points this season and last season's per-game average for last-season games, which is what the app can compute. Tuning chose gamma = 0.5 for passing TDs only (vs DK lines: 57.0% → 58.8%). Passing yards, receiving yards and the rest chose 0.
Also tried: targets × efficiency for receiving stats (`kE`). It was worse on unseen seasons, so it was reverted.
Still unbeatable with box-score data: DK main lines for passing yards (~49%) and receiving yards (~50%).

## Ideas not yet tried

- Fix the shrinkage pull on backups/stars: a role-aware prior (target/carry share) instead of one league baseline per stat.
- Get real prop prices (paid odds API) so props can be judged at actual odds instead of an assumed −115.
- Adjust a player's projection when a teammate is out (redistribute targets/carries) instead of just skipping the prop.
- A Backtest tab inside the app showing these results.
- Week 18 "resting starters" warning; weather flag on cards.
- A larger sample (2015+) to firm up the rare-situation numbers.

## Files

- `index.html`: the app (Games, Team PPP and Player Props tabs).
- `backtest/props.js`: player prop model + tuner; `star_check.js` / `star_cal.js` check star-player bias.
- `backtest/fetch_players.js`: builds `players.json` (player box score lines 2020-2026).
- `backtest/picks.js`: pick/skip analysis by confidence, line gap and timing.
- `backtest/fetch_proplines.js` + `prop_lines_test.js`: DraftKings prop lines and the props-vs-DK test.
- `backtest/model2.js`: current model + tuner (exports `ALL`, `ratings`, `predict`).
- `backtest/caveats.js`: situation splits.
- `backtest/fetch_boxscores.js`: builds `boxscores.json` from ESPN.
- `backtest/backtest.js`, `experiments.js`: earlier versions (original model, 2024-25 only; the opponent-adjust experiment). Kept for reference.
- `backtest/predictions_*.json`, `results_*.json`: outputs from backtest.js runs.
