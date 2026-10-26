// pull_local.mjs -- the FALLBACK if stats.nba.com blocks Cloudflare's IPs: run the SAME engine from your PC
// (or a GitHub Action) and upload the same JSON to the Worker.
//   node pull_local.mjs                       -> writes live.json next to this file
//   WORKER_URL=https://dsx-live.<you>.workers.dev ADMIN_TOKEN=... node pull_local.mjs --upload
import fs from 'node:fs';
import { buildLive, pullNba } from './live_engine.js';
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { players, teams } = await pullNba(config.season);
if (!players.length) throw new Error('NBA returned no rows');
const live = buildLive(config, players, teams, new Date().toISOString());
fs.writeFileSync(new URL('./live.json', import.meta.url), JSON.stringify(live));
console.log('wrote live.json:', JSON.stringify(live.match), 'leagueGames', live.leagueGames);
if (process.argv.includes('--upload')) {
  const r = await fetch(process.env.WORKER_URL.replace(/\/$/, '') + '/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(live) });
  console.log('upload', r.status, await r.text());
}
