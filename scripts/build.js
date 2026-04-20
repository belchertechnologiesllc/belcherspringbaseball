#!/usr/bin/env node
/**
 * Belcher Grandkids Sports Schedule Builder
 *
 * Sources:
 *   LIVE (scraped daily):
 *     - NKCA Baseball: Dawson, Cameron, Preston, Parker  → nkcabaseball.com
 *     - TeamSideline:  Nora Softball, Nora Volleyball    → teamsideline.com
 *
 *   STATIC (hardcoded, update manually if changed):
 *     - Preston Flag Football (Eagles / NFL Flag portal — JS-rendered)
 *     - Ryman Baseball (Monarchs 8U / SportsEngine — JS-rendered)
 *
 * Exit codes:
 *   0 = no changes detected, skip deploy
 *   1 = changes detected, deploy needed
 *   2 = network/parse error, abort
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── NKCA team definitions ────────────────────────────────────────────────────
const NKCA_TEAMS = [
  { kid: 'dawson',           id: '85056', label: 'Dawson',  team: 'Diamond Dawgs',      age: '7U'  },
  { kid: 'cameron',          id: '86968', label: 'Cameron', team: 'KC Sharks 11U',       age: '11U' },
  { kid: 'preston-baseball', id: '87630', label: 'Preston', team: 'KC Diamond Crushers', age: '6U'  },
  { kid: 'parker',           id: '87764', label: 'Parker',  team: 'BPC Tower Buzzers',   age: '10U' },
];

// ── TeamSideline sources ─────────────────────────────────────────────────────
const TEAMSIDELINE_SOURCES = [
  {
    kid:    'nora-softball',
    label:  'Nora',
    team:   'Dolphins',
    age:    '11/12U',
    myTeam: 'Dolphins',
    url:    'https://teamsideline.com/sites/liberty/schedule/709215/1112U',
  },
  {
    kid:    'nora-volleyball',
    label:  'Nora',
    team:   'Smith',
    age:    '3rd/4th',
    myTeam: 'Smith',
    url:    'https://teamsideline.com/sites/liberty/schedule/705824/3rd4th-Grade',
  },
];

// ── Static events (JS-rendered sources, manually maintained) ─────────────────
const STATIC_EVENTS = [
  // PRESTON — Eagles Flag Football (NFL Flag portal — JS-rendered, no scrape possible)
  { kid:'preston-football', date:'2026-04-18', time:'10:00 AM', end:'11:00 AM', home:true,  opp:'Lombardi - Silva - Wright - FALCONS', field:'Field 1 · Heritage Middle School', note:'Week 1 · Won 33-0' },
  { kid:'preston-football', date:'2026-04-25', time:'9:00 AM',  end:'10:00 AM', home:false, opp:'Lombardi - Silva - Wright - FALCONS', field:'Field 1 · Heritage Middle School' },
  { kid:'preston-football', date:'2026-04-25', time:'10:00 AM', end:'11:00 AM', home:false, opp:'Lombardi - Collins - PANTHERS',       field:'Field 1 · Heritage Middle School', note:'Double header' },
  { kid:'preston-football', date:'2026-05-02', time:'9:00 AM',  end:'10:00 AM', home:true,  opp:'Lombardi - Silva - Wright - FALCONS', field:'Field 1 · Heritage Middle School', note:'Double header' },
  { kid:'preston-football', date:'2026-05-09', time:'9:00 AM',  end:'10:00 AM', home:true,  opp:'Lombardi - Collins - PANTHERS',       field:'Field 1 · Heritage Middle School' },
  { kid:'preston-football', date:'2026-05-16', time:'9:00 AM',  end:'10:00 AM', home:false, opp:'Lombardi - Collins - PANTHERS',       field:'Field 1 · Heritage Middle School' },

  // RYMAN — Monarchs 8U Baseball (SportsEngine — JS-rendered, no scrape possible)
  { kid:'ryman', date:'2026-04-21', time:'5:45 PM',  end:'7:00 PM',  home:true,  opp:'St Joe Storm',           field:'Eagles Field E1 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-04-21', time:'7:15 PM',  end:'8:30 PM',  home:true,  opp:'Midwest Longhorns 8U',   field:'Eagles Field E1 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-04-28', time:'5:45 PM',  end:'7:00 PM',  home:true,  opp:'St Joe Storm',           field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-04-28', time:'7:15 PM',  end:'8:30 PM',  home:true,  opp:'Midwest Longhorns 8U',   field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-05', time:'5:45 PM',  end:'7:00 PM',  home:true,  opp:'Midwest Longhorns 8U',   field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-06', time:'5:45 PM',  end:'7:00 PM',  home:false, opp:'Marek Baseball Academy', field:'Eagles Field E1 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-06', time:'7:15 PM',  end:'8:30 PM',  home:false, opp:'Marek Baseball Academy', field:'Eagles Field E1 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-08', time:'5:30 PM',  end:'6:45 PM',  home:true,  opp:'Chillicothe Bombers 8U', field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-12', time:'5:45 PM',  end:'7:00 PM',  home:true,  opp:'Chillicothe Bombers 7U', field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-12', time:'7:15 PM',  end:'8:30 PM',  home:true,  opp:'Chillicothe Bombers 8U', field:'Eagles Field E2 · 2302 Marion St, Saint Joseph MO' },
  { kid:'ryman', date:'2026-05-18', time:'7:15 PM',  end:'8:30 PM',  home:true,  opp:'Atchison Mudcats 8U',    field:'Eagles Field E1 · 2302 Marion St, Saint Joseph MO' },
];

const NKCA_BASE     = 'https://www.nkcabaseball.com/schedule/filter';
const SNAPSHOT_FILE = path.join(__dirname, '..', 'schedule-snapshot.json');
const OUTPUT_FILE   = path.join(__dirname, '..', 'public', 'index.html');
const CHANGE_LOG    = path.join(__dirname, '..', 'changes.json');

// ── HTTP fetch with redirect support ─────────────────────────────────────────
function fetchUrl(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ScheduleBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── Parse NKCA schedule HTML ─────────────────────────────────────────────────
function parseNKCA(html, kid) {
  const games = [];
  const myId  = NKCA_TEAMS.find(t => t.kid === kid)?.id;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const dateRe = /(\w{3}),\s+(\w{3}\s+\d+\s+\d{4})\s+([\d:]+\s+[AP]M)\s+to\s+([\d:]+\s+[AP]M)/i;
    const dateMatch = row.match(dateRe);
    if (!dateMatch) continue;

    const d = new Date(dateMatch[2]);
    if (isNaN(d.getTime())) continue;
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const timeStr = dateMatch[3];
    const endStr  = dateMatch[4];

    // Opponent
    const oppRe = /team\/(\d+)[^>]*>([\w\s\-&;]+?)<\/a>/g;
    const opponents = [];
    let oppMatch;
    while ((oppMatch = oppRe.exec(row)) !== null) {
      if (oppMatch[1] !== myId) {
        const name = oppMatch[2].replace(/&amp;/g, '&').trim();
        if (!opponents.includes(name)) opponents.push(name);
      }
    }
    if (!opponents.length) continue;

    // Home/Away
    const home = new RegExp(`\\(Home\\)[\\s\\S]{0,600}?team\\/${myId}`).test(row);

    // Field
    const fieldMatch = row.match(/maps[^"]+"\s*>([\w\s\-#]+)<\/a>/i);
    const field = fieldMatch ? fieldMatch[1].trim() : '';

    // Note
    let note = '';
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    for (const cell of cells) {
      const stripped = cell.replace(/<[^>]+>/g, '').trim();
      if (stripped.length > 5 && stripped.length < 150
          && !stripped.includes('Machine Pitch') && !stripped.includes('Coach Pitch')
          && !/^\d/.test(stripped) && !stripped.includes('Arrive')
          && !stripped.includes(opponents[0]) && !stripped.includes('Vs') && stripped !== field) {
        note = stripped;
      }
    }

    games.push({ kid, date: dateKey, time: timeStr, end: endStr, home, opp: opponents[0], field, note: note || undefined });
  }
  return games;
}

// ── Parse TeamSideline schedule HTML ─────────────────────────────────────────
// TeamSideline renders schedule as an HTML table in the initial response.
// The full-width table has columns: Date | Time | Home | Score | Away | Score | Location
// We find rows where our team appears and determine home/away by column position.
function parseTeamSideline(html, source) {
  const games  = [];
  const myTeam = source.myTeam;
  const kid    = source.kid;

  // Find all schedule table rows (the full-width version has 7 cells per game row)
  // Date rows look like: <td ...>Tue 4/28</td>
  // Game rows look like: <td>time</td><td>Home Team</td>...<td>Away Team</td>...<td>Location</td>

  // Split the HTML into week sections by looking for date patterns
  const datePattern = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\/\d{1,2}/g;

  // Extract all table rows with their cell content
  const allRows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellM;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(cellM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());
    }
    if (cells.length >= 2) allRows.push(cells);
  }

  let currentDate = '';

  for (const cells of allRows) {
    // Date row: first cell matches "Tue 4/28" pattern
    const dateM = cells[0].match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\/(\d{1,2})$/i);
    if (dateM) {
      const month = parseInt(dateM[2]);
      const day   = parseInt(dateM[3]);
      currentDate = `2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      continue;
    }

    if (!currentDate) continue;

    // Skip week headers, bye rows, standings, non-game rows
    const rowText = cells.join(' ');
    if (!rowText.includes(myTeam)) continue;
    if (rowText.toLowerCase().includes('bye')) continue;
    if (!rowText.match(/\d{1,2}:\d{2}\s*[AP]M/i)) continue;

    // Full-width table: Date | Time | Home | Score | Away | Score | Location (7 cols)
    // Mobile table:     Date | Time | Game (3 cols, game cell has both teams)
    // We handle both layouts

    if (cells.length >= 5) {
      // Full-width layout — cells[1]=time, cells[2]=home, cells[4]=away, cells[6]=location
      const timeStr = cells[1].match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || cells[0].match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0];
      if (!timeStr) continue;

      const homeTeam = cells[2] || '';
      const awayTeam = cells[4] || '';
      const location = cells[6] || cells[cells.length - 1] || '';

      const isHome = homeTeam.includes(myTeam);
      const isAway = awayTeam.includes(myTeam);
      if (!isHome && !isAway) continue;

      const opp = isHome ? awayTeam : homeTeam;
      games.push({ kid, date: currentDate, time: timeStr, end: '', home: isHome, opp: opp.trim(), field: location.trim() });

    } else if (cells.length >= 2) {
      // Mobile/merged layout — find time cell, then game cell
      const timeStr = cells.find(c => /^\d{1,2}:\d{2}\s*[AP]M$/i.test(c));
      if (!timeStr) continue;

      const gameCell = cells.find(c => c.includes(myTeam) && c !== timeStr) || '';
      if (!gameCell) continue;

      // Text order in merged cell: "Home Team  Away Team  Location"
      const parts = gameCell.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
      const myIdx  = parts.findIndex(p => p.includes(myTeam));
      if (myIdx === -1) continue;

      const home   = myIdx === 0;
      const oppIdx = home ? 1 : 0;
      const opp    = parts[oppIdx] || 'TBD';
      const field  = parts[parts.length - 1] || '';

      games.push({ kid, date: currentDate, time: timeStr, end: '', home, opp, field });
    }
  }

  return games;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const liveGames = [];

  // 1. Scrape NKCA Baseball
  console.log('\n🔍 Fetching NKCA Baseball schedules...');
  for (const t of NKCA_TEAMS) {
    const url = `${NKCA_BASE}?team=${t.id}&eventType=1&location=0&complexId=0&gameSeasonId=0&ageGoupDivisionId=0&homeAwayValue=0&dateRange=21&fromDateRange=Apr+17+2026&toDateRange=`;
    console.log(`  ${t.label} (${t.id})...`);
    try {
      const html  = await fetchUrl(url);
      const games = parseNKCA(html, t.kid);
      console.log(`  → ${games.length} games`);
      liveGames.push(...games);
    } catch (err) {
      console.error(`  ✗ Error fetching ${t.label}: ${err.message}`);
      process.exit(2);
    }
  }

  // 2. Scrape TeamSideline
  console.log('\n🔍 Fetching TeamSideline schedules...');
  for (const src of TEAMSIDELINE_SOURCES) {
    console.log(`  ${src.kid} (${src.myTeam})...`);
    try {
      const html  = await fetchUrl(src.url);
      const games = parseTeamSideline(html, src);
      console.log(`  → ${games.length} games`);
      liveGames.push(...games);
    } catch (err) {
      console.error(`  ✗ Error fetching ${src.kid}: ${err.message}`);
      process.exit(2);
    }
  }

  // 3. Merge live + static, sort
  const allEvents = [...liveGames, ...STATIC_EVENTS];
  allEvents.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  liveGames.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  // Snapshot covers only live-scraped games
  const newSnapshot = JSON.stringify(liveGames, null, 2);

  // ── Diff against last snapshot ─────────────────────────────────────────────
  let changed = true;
  const changes = { detected_at: new Date().toISOString(), added: [], removed: [], modified: [] };

  if (fs.existsSync(SNAPSHOT_FILE)) {
    const oldSnapshot = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    if (oldSnapshot === newSnapshot) {
      changed = false;
      console.log('\n✅ No schedule changes detected.');
    } else {
      console.log('\n⚡ Schedule changes detected!');
      const oldGames = JSON.parse(oldSnapshot);
      const oldMap   = Object.fromEntries(oldGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
      const newMap   = Object.fromEntries(liveGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
      for (const [k, g] of Object.entries(newMap)) {
        if (!oldMap[k]) changes.added.push(g);
        else if (JSON.stringify(g) !== JSON.stringify(oldMap[k])) changes.modified.push({ old: oldMap[k], new: g });
      }
      for (const [k, g] of Object.entries(oldMap)) {
        if (!newMap[k]) changes.removed.push(g);
      }
      console.log(`  Added: ${changes.added.length}, Removed: ${changes.removed.length}, Modified: ${changes.modified.length}`);
    }
  } else {
    console.log('\n📋 No snapshot — first run.');
  }

  if (!changed && process.env.FORCE_REBUILD !== '1') {
    process.exit(0);
  }

  fs.writeFileSync(SNAPSHOT_FILE, newSnapshot);
  fs.writeFileSync(CHANGE_LOG, JSON.stringify(changes, null, 2));
  console.log('💾 Snapshot updated.');

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, buildHTML(allEvents));
  console.log(`✅ Built ${OUTPUT_FILE} with ${allEvents.length} events.`);

  process.exit(1); // signal CI: rebuild happened, deploy
}

// ── HTML builder ─────────────────────────────────────────────────────────────
function buildHTML(events) {
  const lastUpdated = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const eventsJson = JSON.stringify(events);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Belcher Grandkids Sports Schedule 2026</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --dawson:#2563EB;--cameron:#059669;--preston-baseball:#DC2626;--parker:#D97706;
    --nora-softball:#DB2777;--nora-volleyball:#7C3AED;--preston-football:#EA580C;--ryman:#0891B2;
    --bg:#F9F7F4;--surface:#FFFFFF;--border:#E5E2DC;--text:#1A1916;--muted:#6B6860;--subtle:#9A9890;
  }
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .page-header{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 28px 16px}
  .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .page-title{font-size:20px;font-weight:600;letter-spacing:-0.3px;line-height:1.2}
  .page-subtitle{font-size:11px;color:var(--subtle);font-family:'DM Mono',monospace;margin-top:2px}
  .legend{display:flex;flex-wrap:wrap;gap:10px 20px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
  .leg{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
  .leg-swatch{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .leg-name{font-weight:500;color:var(--text)}
  .filter-bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 28px;background:var(--surface);border-bottom:1px solid var(--border)}
  .filter-btn{font-size:11px;font-weight:500;border-radius:20px;padding:4px 12px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--muted);transition:all .15s}
  .filter-btn:hover{border-color:var(--muted)}
  .filter-btn.active{color:#fff;border-color:transparent}
  .filter-btn[data-kid="all"].active{background:var(--text)}
  .filter-btn[data-kid="dawson"].active{background:var(--dawson)}
  .filter-btn[data-kid="cameron"].active{background:var(--cameron)}
  .filter-btn[data-kid="preston"].active{background:var(--preston-baseball)}
  .filter-btn[data-kid="parker"].active{background:var(--parker)}
  .filter-btn[data-kid="nora"].active{background:var(--nora-softball)}
  .filter-btn[data-kid="ryman"].active{background:var(--ryman)}
  .summary-bar{display:flex;gap:12px;padding:12px 28px;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
  .sum-card{text-align:center;flex:1;min-width:55px}
  .sum-num{font-size:20px;font-weight:600;letter-spacing:-0.5px}
  .sum-label{font-size:9px;color:var(--subtle);text-transform:uppercase;letter-spacing:.4px;margin-top:1px;line-height:1.3}
  .cal-nav{display:flex;align-items:center;justify-content:space-between;padding:14px 28px 10px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20}
  .month-label{font-size:18px;font-weight:600;letter-spacing:-0.3px}
  .nav-btns{display:flex;gap:6px}
  .nav-btn{background:transparent;border:1px solid var(--border);border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:16px;color:var(--muted);display:flex;align-items:center;justify-content:center;transition:background .1s}
  .nav-btn:hover{background:var(--bg)}
  .game-count{font-size:12px;color:var(--subtle);font-family:'DM Mono',monospace}
  .cal-wrap{padding:0 28px 28px}
  .week-header{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-left:1px solid var(--border);border-top:1px solid var(--border);margin-top:14px}
  .wh-cell{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px 0;text-align:center;font-size:11px;font-weight:500;color:var(--subtle);text-transform:uppercase;letter-spacing:.5px;background:var(--surface)}
  .cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-left:1px solid var(--border);border-top:1px solid var(--border)}
  .day-cell{border-right:1px solid var(--border);border-bottom:1px solid var(--border);min-height:100px;padding:6px 5px 5px;background:var(--surface)}
  .day-cell.other-month{background:#F4F2EE}
  .day-cell.today{background:#EFF6FF}
  .day-num{font-size:11px;font-weight:500;color:var(--subtle);margin-bottom:3px;display:block}
  .day-cell.today .day-num{color:#2563EB;font-weight:600}
  .day-cell.other-month .day-num{color:#C4C0B8}
  .pill{display:block;font-size:10px;font-weight:500;border-radius:4px;padding:2px 5px;margin-bottom:2px;cursor:pointer;line-height:1.4;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;transition:opacity .1s,transform .1s;border:none;text-align:left;width:100%}
  .pill:hover{opacity:.75;transform:scale(.98)}
  .pill-dawson{background:#DBEAFE;color:#1D4ED8}
  .pill-cameron{background:#D1FAE5;color:#047857}
  .pill-preston-baseball{background:#FEE2E2;color:#B91C1C}
  .pill-parker{background:#FEF3C7;color:#B45309}
  .pill-nora-softball{background:#FCE7F3;color:#BE185D}
  .pill-nora-volleyball{background:#EDE9FE;color:#6D28D9}
  .pill-preston-football{background:#FFEDD5;color:#C2410C}
  .pill-ryman{background:#CFFAFE;color:#0E7490}
  .busy-badge{display:inline-block;font-size:9px;font-family:'DM Mono',monospace;background:#F3F0EA;color:var(--subtle);border-radius:3px;padding:1px 4px;margin-bottom:3px}
  .updated-bar{background:var(--bg);border-bottom:1px solid var(--border);padding:5px 28px;font-size:11px;color:var(--subtle);font-family:'DM Mono',monospace;display:flex;justify-content:space-between;align-items:center}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center;padding:20px}
  .modal-overlay.open{display:flex}
  .modal{background:var(--surface);border-radius:12px;border:1px solid var(--border);width:100%;max-width:440px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)}
  .modal-header{padding:16px 20px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--surface);border-radius:12px 12px 0 0}
  .modal-date{font-size:15px;font-weight:600}
  .modal-close{background:transparent;border:none;cursor:pointer;font-size:20px;color:var(--subtle);line-height:1;padding:0 2px}
  .modal-close:hover{color:var(--text)}
  .modal-body{padding:4px 0 8px}
  .modal-event{padding:12px 20px;border-bottom:1px solid var(--border)}
  .modal-event:last-child{border-bottom:none}
  .modal-sport-badge{display:inline-block;font-size:9px;font-weight:600;border-radius:3px;padding:1px 6px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px}
  .modal-kid-label{font-size:13px;font-weight:600;margin-bottom:2px}
  .modal-opp{font-size:13px;font-weight:500;color:var(--text);margin-bottom:3px}
  .modal-meta{font-size:12px;color:var(--muted);line-height:1.6;font-family:'DM Mono',monospace}
  .modal-note{display:block;margin-top:4px;font-size:11px;font-style:italic;color:var(--subtle);font-family:'DM Sans',sans-serif}
  .ha-badge{display:inline-block;font-size:9px;font-weight:600;border-radius:3px;padding:1px 5px;margin-left:4px;text-transform:uppercase;letter-spacing:.3px}
  .ha-home{background:#D1FAE5;color:#047857}
  .ha-away{background:#FEE2E2;color:#B91C1C}
  @media(max-width:640px){
    .page-header,.cal-nav,.cal-wrap,.summary-bar,.updated-bar,.filter-bar{padding-left:12px;padding-right:12px}
    .day-cell{min-height:72px}.page-title{font-size:16px}.summary-bar{gap:8px}
  }
</style>
</head>
<body>
<div class="page-header">
  <div class="header-top">
    <div>
      <div class="page-title">Belcher Grandkids Sports Schedule</div>
      <div class="page-subtitle">Spring 2026 · NKCA Baseball · Liberty Parks &amp; Rec · NFL Flag Football · Pony Express Baseball</div>
    </div>
    <div style="font-size:11px;color:#9A9890;font-family:'DM Mono',monospace;text-align:right;line-height:1.9" id="hdr-totals"></div>
  </div>
  <div class="legend">
    <div class="leg"><div class="leg-swatch" style="background:#2563EB"></div><span class="leg-name">Dawson</span> · Diamond Dawgs · Baseball 7U</div>
    <div class="leg"><div class="leg-swatch" style="background:#059669"></div><span class="leg-name">Cameron</span> · KC Sharks 11U · Baseball 11U</div>
    <div class="leg"><div class="leg-swatch" style="background:#DC2626"></div><span class="leg-name">Preston</span> · KC Diamond Crushers · Baseball 6U</div>
    <div class="leg"><div class="leg-swatch" style="background:#D97706"></div><span class="leg-name">Parker</span> · BPC Tower Buzzers · Baseball 10U</div>
    <div class="leg"><div class="leg-swatch" style="background:#DB2777"></div><span class="leg-name">Nora</span> · Dolphins · Softball 11/12U</div>
    <div class="leg"><div class="leg-swatch" style="background:#7C3AED"></div><span class="leg-name">Nora</span> · Smith · Volleyball 3rd/4th</div>
    <div class="leg"><div class="leg-swatch" style="background:#EA580C"></div><span class="leg-name">Preston</span> · Eagles · Flag Football</div>
    <div class="leg"><div class="leg-swatch" style="background:#0891B2"></div><span class="leg-name">Ryman</span> · Monarchs 8U · Baseball</div>
  </div>
</div>
<div class="updated-bar">
  <span>Last synced: ${lastUpdated}</span>
  <span id="conflict-label" style="color:#B91C1C"></span>
</div>
<div class="filter-bar">
  <span style="font-size:11px;color:var(--subtle);align-self:center;margin-right:4px">Filter:</span>
  <button class="filter-btn active" data-kid="all">All kids</button>
  <button class="filter-btn" data-kid="dawson">Dawson</button>
  <button class="filter-btn" data-kid="cameron">Cameron</button>
  <button class="filter-btn" data-kid="preston">Preston</button>
  <button class="filter-btn" data-kid="parker">Parker</button>
  <button class="filter-btn" data-kid="nora">Nora</button>
  <button class="filter-btn" data-kid="ryman">Ryman</button>
</div>
<div class="summary-bar" id="summary-bar"></div>
<div class="cal-nav">
  <div style="display:flex;align-items:center;gap:12px">
    <div class="nav-btns"><button class="nav-btn" id="prev">&#8249;</button><button class="nav-btn" id="next">&#8250;</button></div>
    <span class="month-label" id="month-label"></span>
  </div>
  <span class="game-count" id="game-count"></span>
</div>
<div class="cal-wrap">
  <div class="week-header" id="week-header"></div>
  <div class="cal-grid" id="cal-grid"></div>
</div>
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-date" id="modal-date"></span>
      <button class="modal-close" id="modal-close">&times;</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>
<script>
const KIDS={
  'dawson':           {label:'Dawson',  sport:'Baseball',     team:'Diamond Dawgs',      age:'7U',      cls:'pill-dawson',          color:'#2563EB',group:'dawson'},
  'cameron':          {label:'Cameron', sport:'Baseball',     team:'KC Sharks 11U',       age:'11U',     cls:'pill-cameron',         color:'#059669',group:'cameron'},
  'preston-baseball': {label:'Preston', sport:'Baseball',     team:'KC Diamond Crushers', age:'6U',      cls:'pill-preston-baseball',color:'#DC2626',group:'preston'},
  'parker':           {label:'Parker',  sport:'Baseball',     team:'BPC Tower Buzzers',   age:'10U',     cls:'pill-parker',          color:'#D97706',group:'parker'},
  'nora-softball':    {label:'Nora',    sport:'Softball',     team:'Dolphins',            age:'11/12U',  cls:'pill-nora-softball',   color:'#DB2777',group:'nora'},
  'nora-volleyball':  {label:'Nora',    sport:'Volleyball',   team:'Smith',               age:'3rd/4th', cls:'pill-nora-volleyball', color:'#7C3AED',group:'nora'},
  'preston-football': {label:'Preston', sport:'Flag Football',team:'Eagles (Lombardi)',   age:'',        cls:'pill-preston-football',color:'#EA580C',group:'preston'},
  'ryman':            {label:'Ryman',   sport:'Baseball',     team:'Monarchs 8U',         age:'8U',      cls:'pill-ryman',           color:'#0891B2',group:'ryman'},
};
const EVENTS=${eventsJson};
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TODAY='${new Date().toISOString().slice(0,10)}';
let curYear=2026,curMonth=3,activeFilter='all';

const bar=document.getElementById('summary-bar');
[['dawson'],['cameron'],['preston-baseball','preston-football'],['parker'],['nora-softball','nora-volleyball'],['ryman']].forEach(keys=>{
  const n=EVENTS.filter(e=>keys.includes(e.kid)).length;
  const t=KIDS[keys[0]];
  bar.innerHTML+=\`<div class="sum-card"><div class="sum-num" style="color:\${t.color}">\${n}</div><div class="sum-label">\${t.label}</div></div>\`;
});
document.getElementById('hdr-totals').textContent=EVENTS.length+' total events';

const byDate={};
EVENTS.forEach(e=>{byDate[e.date]=(byDate[e.date]||[]).concat(e)});
let conflicts=0;
for(const evs of Object.values(byDate)){
  if([...new Set(evs.map(e=>KIDS[e.kid].group))].length>=3)conflicts++;
}
if(conflicts)document.getElementById('conflict-label').textContent='⚠ '+conflicts+' busy day'+(conflicts>1?'s':'')+' (3+ kids)';

document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter=btn.dataset.kid;
    render();
  });
});

function pad(n){return String(n).padStart(2,'0')}
function dateKey(y,m,d){return \`\${y}-\${pad(m+1)}-\${pad(d)}\`}
function daysInMonth(y,m){return new Date(y,m+1,0).getDate()}
function firstDow(y,m){return new Date(y,m,1).getDay()}
function eventsOn(dk){return EVENTS.filter(e=>e.date===dk)}
function visibleOn(dk){return eventsOn(dk).filter(e=>activeFilter==='all'||KIDS[e.kid].group===activeFilter)}
function timeSort(a,b){
  const p=t=>{const[hm,ap]=t.split(' ');let[h,mn]=hm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+mn};
  return p(a.time)-p(b.time);
}
function render(){
  document.getElementById('month-label').textContent=MONTHS[curMonth]+' '+curYear;
  const grid=document.getElementById('cal-grid'),wh=document.getElementById('week-header');
  grid.innerHTML='';wh.innerHTML='';
  DAYS.forEach(d=>{const c=document.createElement('div');c.className='wh-cell';c.textContent=d;wh.appendChild(c)});
  const first=firstDow(curYear,curMonth),days=daysInMonth(curYear,curMonth);
  const prevDays=daysInMonth(curYear,curMonth===0?11:curMonth-1);
  const total=Math.ceil((first+days)/7)*7;
  let monthGames=0;
  for(let i=0;i<total;i++){
    let y=curYear,m=curMonth,d,other=false;
    if(i<first){m=curMonth===0?11:curMonth-1;y=curMonth===0?curYear-1:curYear;d=prevDays-first+i+1;other=true}
    else if(i>=first+days){m=curMonth===11?0:curMonth+1;y=curMonth===11?curYear+1:curYear;d=i-first-days+1;other=true}
    else d=i-first+1;
    const dk=dateKey(y,m,d);
    const evs=visibleOn(dk).sort(timeSort);
    if(!other)monthGames+=evs.length;
    const cell=document.createElement('div');
    cell.className='day-cell'+(other?' other-month':'')+(dk===TODAY?' today':'');
    const num=document.createElement('span');num.className='day-num';num.textContent=d;cell.appendChild(num);
    if(evs.length>=3&&!other){const b=document.createElement('span');b.className='busy-badge';b.textContent=evs.length+' events';cell.appendChild(b)}
    evs.forEach(ev=>{
      const t=KIDS[ev.kid];
      const pill=document.createElement('button');
      pill.className='pill '+t.cls;
      pill.textContent=t.label+' '+ev.time;
      pill.title=t.label+' '+t.sport+' vs '+ev.opp+' · '+(ev.home?'Home':'Away')+' · '+ev.field;
      pill.onclick=e=>{e.stopPropagation();showModal(dk,eventsOn(dk).sort(timeSort))};
      cell.appendChild(pill);
    });
    grid.appendChild(cell);
  }
  document.getElementById('game-count').textContent=monthGames+' event'+(monthGames!==1?'s':'')+' this month'+(activeFilter!=='all'?' (filtered)':'');
}
function showModal(dk,evs){
  const d=new Date(dk+'T12:00:00');
  document.getElementById('modal-date').textContent=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const body=document.getElementById('modal-body');body.innerHTML='';
  evs.forEach(ev=>{
    const t=KIDS[ev.kid];
    const div=document.createElement('div');div.className='modal-event';
    div.innerHTML=\`<div class="modal-sport-badge" style="background:\${t.color}22;color:\${t.color}">\${t.sport}</div>
      <div class="modal-kid-label" style="color:\${t.color}">\${t.label} — \${t.team}\${t.age?' ('+t.age+')':''}</div>
      <div class="modal-opp">vs \${ev.opp}<span class="ha-badge \${ev.home?'ha-home':'ha-away'}">\${ev.home?'Home':'Away'}</span></div>
      <div class="modal-meta">\${ev.time}\${ev.end?' – '+ev.end:''}<br>\${ev.field}</div>
      \${ev.note?\`<span class="modal-note">\${ev.note}</span>\`:''}
    \`;
    body.appendChild(div);
  });
  document.getElementById('modal-overlay').classList.add('open');
}
document.getElementById('prev').onclick=()=>{curMonth--;if(curMonth<0){curMonth=11;curYear--}render()};
document.getElementById('next').onclick=()=>{curMonth++;if(curMonth>11){curMonth=0;curYear++}render()};
document.getElementById('modal-close').onclick=()=>document.getElementById('modal-overlay').classList.remove('open');
document.getElementById('modal-overlay').onclick=e=>{if(e.target===document.getElementById('modal-overlay'))document.getElementById('modal-overlay').classList.remove('open')};
render();
</script>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(2); });
