// live_engine.js -- pure functions, no I/O. Used by worker.js, pull_local.mjs and test_engine.mjs.
//
// LIVE price = the board's MARK formula run on the CURRENT season's stats, ranked inside each
// draft class on the class's own price ladder. It never touches IPO or MARK.
//
//   rate  = PTS + 0.7 REB + 1.5 AST + 1.8 STL + 1.8 BLK - TO          (per game)
//   score = rate x min(1, GP / teamGames) ^ 0.25 x (GP < 10 ? GP/10 : 1)
//
// The GP<10 damping is checked against build-reweight/lib/ranking.py (score(): `f *= gp / SMALL_SAMPLE`
// with SMALL_SAMPLE = 10) and the min(1, ..) cap on availability is the same cap ranking.py uses.
// MARK uses a fixed 82 as the games denominator; LIVE uses the player's own team's games so far.

export const WEIGHTS = { reb: 0.7, ast: 1.5, stl: 1.8, blk: 1.8 };
export const DAMP_BELOW = 10;      // below this many games: extra linear factor GP / DAMP_BELOW
export const SMALL_SAMPLE = 15;    // below this many games: "small sample" tag (display only)
export const STALE_DAYS = 3;

export function rate(l) {
  return l.pts + WEIGHTS.reb * l.reb + WEIGHTS.ast * l.ast + WEIGHTS.stl * l.stl + WEIGHTS.blk * l.blk - l.tov;
}

export function score(gp, line, teamGames) {
  if (!gp || gp <= 0 || !line) return null;
  const full = teamGames && teamGames > 0 ? teamGames : gp;
  let f = Math.pow(Math.min(1, gp / full), 0.25);
  if (gp < DAMP_BELOW) f *= gp / DAMP_BELOW;
  return rate(line) * f;
}

// ---- name matching (fallback for players that have no NBA person id, i.e. the OTC names) ----------
export function nameKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// ---- NBA stats.nba.com response helpers ------------------------------------------------------------
export function rowsOf(resp) {
  const rs = (resp.resultSets && resp.resultSets[0]) || (resp.resultSet) || null;
  if (!rs || !rs.headers || !rs.rowSet) throw new Error('unexpected stats.nba.com shape');
  return rs.rowSet.map(r => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]])));
}

export function normalizePlayers(resp) {
  return rowsOf(resp).map(r => ({
    id: r.PLAYER_ID, name: r.PLAYER_NAME, teamId: r.TEAM_ID, team: r.TEAM_ABBREVIATION,
    gp: +r.GP || 0,
    line: { pts: +r.PTS || 0, reb: +r.REB || 0, ast: +r.AST || 0, stl: +r.STL || 0, blk: +r.BLK || 0, tov: +r.TOV || 0 },
  }));
}

export function normalizeTeams(resp) {
  const m = {};
  for (const r of rowsOf(resp)) m[r.TEAM_ID] = +r.GP || 0;
  return m;
}

// ---- the build -------------------------------------------------------------------------------------
// config  : { season, ladder:[...], classes:{ '2026':[{k,n,nba,id}], ... } }   (make_config.js)
// players : normalizePlayers(...)         teams : normalizeTeams(...)
export function buildLive(config, players, teams, nowIso, opts = {}) {
  const teamVals = Object.values(teams);
  const leagueGames = teamVals.length ? Math.max(...teamVals) : 0;
  const byId = new Map();
  const byName = new Map();
  for (const p of players) {
    // a traded player can appear once per team in some feeds; keep the row with the most games
    const prev = byId.get(p.id);
    if (!prev || p.gp > prev.gp) byId.set(p.id, p);
  }
  for (const p of byId.values()) {
    const k = nameKey(p.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  const stats = { matchedById: 0, matchedByName: 0, ambiguous: [], unmatched: 0, noGames: 0 };
  const out = {};
  const claimed = new Set();     // a NBA person can fill only one slot (guards a name-match grabbing a mapped player)
  for (const c of Object.values(config.classes)) for (const e of c) if (e.id) claimed.add(e.id);

  for (const [year, list] of Object.entries(config.classes)) {
    const rows = [];
    for (const e of list) {
      let p = e.id ? byId.get(e.id) : null;
      if (p) stats.matchedById++;
      else if (e.id == null) {   // id 0 = verified not in the NBA index: never name-matched
        const cands = (byName.get(nameKey(e.n)) || []).filter(x => !claimed.has(x.id));
        let pick = null;
        if (cands.length === 1) pick = cands[0];
        else if (cands.length > 1) {
          const same = cands.filter(x => e.nba && x.team === e.nba);
          if (same.length === 1) pick = same[0]; else stats.ambiguous.push(year + ':' + e.k);
        }
        if (pick) { p = pick; stats.matchedByName++; }
      }
      if (!p || !p.gp) { rows.push({ k: e.k, gp: 0, sc: null }); if (p) stats.noGames++; else stats.unmatched++; continue; }
      const tg = teams[p.teamId] || leagueGames;
      rows.push({ k: e.k, gp: p.gp, rate: rate(p.line), sc: score(p.gp, p.line, tg), tg });
    }
    const played = rows.filter(r => r.sc != null)
      .sort((a, b) => (b.sc - a.sc) || (b.gp - a.gp) || (a.k < b.k ? -1 : 1));
    played.forEach((r, i) => {
      r.rank = i + 1;
      const px = config.ladder[i];
      r.price = px == null ? 0 : Math.round(px * 100) / 100;
    });
    const players_ = {};
    for (const r of rows) {
      players_[r.k] = r.sc == null ? { gp: 0 }
        : { gp: r.gp, rank: r.rank, price: r.price, rate: Math.round(r.rate * 100) / 100, sm: r.gp < SMALL_SAMPLE ? 1 : 0 };
    }
    out[year] = { active: played.length > 0, ranked: played.length, players: players_ };
  }
  return {
    schema: 1,
    season: config.season,
    updatedAt: nowIso,
    dataAsOf: opts.dataAsOf || nowIso,
    leagueGames,
    staleDays: STALE_DAYS,
    match: { byId: stats.matchedById, byName: stats.matchedByName, ambiguous: stats.ambiguous, unmatched: stats.unmatched, noGames: stats.noGames },
    classes: out,
  };
}

// ---- NBA request (shared by the Worker and pull_local.mjs) -------------------------------------------
const BASE = 'https://stats.nba.com/stats/';
const COMMON = {
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '', DraftPick: '', DraftYear: '',
  GameScope: '', GameSegment: '', Height: '', ISTRound: '', LastNGames: '0', LeagueID: '00', Location: '',
  MeasureType: 'Base', Month: '0', OpponentTeamID: '0', Outcome: '', PORound: '0', PaceAdjust: 'N',
  PerMode: 'PerGame', Period: '0', PlayerExperience: '', PlayerPosition: '', PlusMinus: 'N', Rank: 'N',
  SeasonSegment: '', SeasonType: 'Regular Season', ShotClockRange: '', StarterBench: '', TeamID: '0',
  VsConference: '', VsDivision: '', Weight: '',
};
export const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};
export function nbaUrl(endpoint, season) {
  const q = new URLSearchParams({ ...COMMON, Season: season });
  return BASE + endpoint + '?' + q.toString();
}
export async function pullNba(season, fetchFn = fetch, { timeoutMs = 20000 } = {}) {
  const get = async (endpoint) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchFn(nbaUrl(endpoint, season), { headers: NBA_HEADERS, signal: ctl.signal });
      if (!r.ok) throw new Error(endpoint + ' HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const [pj, tj] = await Promise.all([get('leaguedashplayerstats'), get('leaguedashteamstats')]);
  return { players: normalizePlayers(pj), teams: normalizeTeams(tj) };
}
