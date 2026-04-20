#!/usr/bin/env node
/**
 * NKCA Baseball Schedule Builder
 * Fetches all four team schedules, diffs against last known state,
 * rebuilds the HTML if anything changed, and exits with code 1 if
 * changes were detected (so CI knows to redeploy).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Team definitions ────────────────────────────────────────────────────────
const TEAMS = [
  { kid: 'dawson',  id: '85056', label: 'Dawson',  team: 'Diamond Dawgs',        age: '7U'  },
  { kid: 'cameron', id: '86968', label: 'Cameron', team: 'KC Sharks 11U',         age: '11U' },
  { kid: 'preston', id: '87630', label: 'Preston', team: 'KC Diamond Crushers',   age: '6U'  },
  { kid: 'parker',  id: '87764', label: 'Parker',  team: 'BPC Tower Buzzers',     age: '10U' },
];

const BASE_URL = 'https://www.nkcabaseball.com/schedule/filter';
const SNAPSHOT_FILE = path.join(__dirname, '..', 'schedule-snapshot.json');
const OUTPUT_FILE   = path.join(__dirname, '..', 'public', 'index.html');
const CHANGE_LOG    = path.join(__dirname, '..', 'changes.json');

// ── Helpers ─────────────────────────────────────────────────────────────────
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScheduleBot/1.0)' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseGames(html, kid) {
  const games = [];
  // Match table rows with game data
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];

    // Extract date/time
    const dateRe = /(\w{3}),\s+(\w{3}\s+\d+\s+\d{4})\s+([\d:]+\s+[AP]M)\s+to\s+([\d:]+\s+[AP]M)/i;
    const dateMatch = row.match(dateRe);
    if (!dateMatch) continue;

    const dateStr = dateMatch[2]; // e.g. "Apr 19 2026"
    const timeStr = dateMatch[3];
    const endStr  = dateMatch[4];

    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const dateKey = `${yyyy}-${mm}-${dd}`;

    // Home or Away
    const isHome = new RegExp(`\\(Home\\)[\\s\\S]*?team/${TEAMS.find(t=>t.kid===kid)?.id}`, 'i').test(row)
                || (row.includes('(Home)') && !row.match(new RegExp(`team/${TEAMS.find(t=>t.kid===kid)?.id}[\\s\\S]*?\\(Away\\)`)));
    // More reliable: check if our team is listed as Home
    const ourTeamSection = row.match(/\(Home\)([\s\S]*?)\(Away\)|\(Away\)([\s\S]*?)\(Home\)/);

    // Opponent name
    const oppRe = /team\/(\d+)[^>]*>([\w\s\-&;]+?)<\/a>/g;
    const opponents = [];
    let oppMatch;
    while ((oppMatch = oppRe.exec(row)) !== null) {
      const tid = oppMatch[1];
      const name = oppMatch[2].replace(/&amp;/g, '&').trim();
      const myId = TEAMS.find(t => t.kid === kid)?.id;
      if (tid !== myId && !opponents.includes(name)) {
        opponents.push(name);
      }
    }
    const opp = opponents[0] || 'TBD';

    // Home/Away — look for which role our team ID is in
    const myId = TEAMS.find(t => t.kid === kid)?.id;
    const homePattern = new RegExp(`\\(Home\\)[\\s\\S]{0,500}?team\\/${myId}`);
    const home = homePattern.test(row);

    // Field / location
    const fieldRe = /maps[^"]+"\s*>([\w\s\-#]+)<\/a>/i;
    const fieldMatch = row.match(fieldRe);
    const field = fieldMatch ? fieldMatch[1].trim() : '';

    // Note (italics content)
    const noteRe = /<td[^>]*>\s*([\w][^<]{10,120})\s*<\/td>/;
    // Look for standalone note cell (short text, no team links)
    let note = '';
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    for (const cell of cells) {
      const stripped = cell.replace(/<[^>]+>/g, '').trim();
      if (stripped.length > 5 && stripped.length < 150 && !stripped.includes('Machine Pitch') && !stripped.includes('Coach Pitch') && !/^\d/.test(stripped) && !stripped.includes('Arrive')) {
        if (!stripped.includes(opp) && !stripped.includes('Vs') && stripped !== field) {
          note = stripped;
        }
      }
    }

    games.push({ kid, date: dateKey, time: timeStr, end: endStr, home, opp, field, note: note || undefined });
  }
  return games;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Fetching schedules from NKCA...');
  const allGames = [];

  for (const t of TEAMS) {
    const url = `${BASE_URL}?team=${t.id}&eventType=1&location=0&complexId=0&gameSeasonId=0&ageGoupDivisionId=0&homeAwayValue=0&dateRange=21&fromDateRange=Apr+17+2026&toDateRange=`;
    console.log(`  Fetching ${t.label} (${t.id})...`);
    try {
      const html = await fetch(url);
      const games = parseGames(html, t.kid);
      console.log(`  → Found ${games.length} games`);
      allGames.push(...games);
    } catch (err) {
      console.error(`  ✗ Error fetching ${t.label}: ${err.message}`);
      process.exit(2); // network error — don't overwrite snapshot
    }
  }

  // Sort by date then time
  allGames.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  // ── Diff against snapshot ──────────────────────────────────────────────────
  const newSnapshot = JSON.stringify(allGames, null, 2);
  let changed = true;
  const changes = { detected_at: new Date().toISOString(), added: [], removed: [], modified: [] };

  if (fs.existsSync(SNAPSHOT_FILE)) {
    const oldSnapshot = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    if (oldSnapshot === newSnapshot) {
      changed = false;
      console.log('✅ No schedule changes detected.');
    } else {
      console.log('⚡ Schedule changes detected!');
      const oldGames = JSON.parse(oldSnapshot);
      const oldMap = Object.fromEntries(oldGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
      const newMap = Object.fromEntries(allGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
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
    console.log('📋 No snapshot found — first run, building initial site.');
  }

  if (!changed && process.env.FORCE_REBUILD !== '1') {
    process.exit(0); // nothing to do
  }

  // ── Write snapshot + change log ────────────────────────────────────────────
  fs.writeFileSync(SNAPSHOT_FILE, newSnapshot);
  fs.writeFileSync(CHANGE_LOG, JSON.stringify(changes, null, 2));
  console.log('💾 Snapshot updated.');

  // ── Build HTML ─────────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const html = buildHTML(allGames);
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`✅ Built ${OUTPUT_FILE} with ${allGames.length} games.`);

  // Exit 1 = changes found → CI will trigger Netlify deploy
  process.exit(1);
}

// ── HTML builder (full self-contained page) ───────────────────────────────────
function buildHTML(events) {
  const lastUpdated = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });

  const eventsJson = JSON.stringify(events);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NKCA Baseball 2026 — Belcher Family Schedule</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --dawson:#2563EB;--cameron:#059669;--preston:#DC2626;--parker:#D97706;
    --bg:#F9F7F4;--surface:#FFFFFF;--border:#E5E2DC;--text:#1A1916;
    --muted:#6B6860;--subtle:#9A9890;--radius:8px;
  }
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .page-header{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 28px 16px}
  .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .page-title{font-size:20px;font-weight:600;letter-spacing:-0.3px;line-height:1.2}
  .page-subtitle{font-size:11px;color:var(--subtle);font-family:'DM Mono',monospace;margin-top:2px}
  .legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
  .leg{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
  .leg-swatch{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .leg-name{font-weight:500;color:var(--text)}
  .summary-bar{display:flex;gap:16px;padding:12px 28px;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
  .sum-card{text-align:center;flex:1;min-width:70px}
  .sum-num{font-size:22px;font-weight:600;letter-spacing:-0.5px}
  .sum-label{font-size:10px;color:var(--subtle);text-transform:uppercase;letter-spacing:.4px;margin-top:1px}
  .cal-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 28px 12px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20}
  .month-label{font-size:18px;font-weight:600;letter-spacing:-0.3px}
  .nav-btns{display:flex;gap:6px}
  .nav-btn{background:transparent;border:1px solid var(--border);border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:16px;color:var(--muted);display:flex;align-items:center;justify-content:center;transition:background .1s}
  .nav-btn:hover{background:var(--bg)}
  .game-count{font-size:12px;color:var(--subtle);font-family:'DM Mono',monospace}
  .cal-wrap{padding:0 28px 28px}
  .week-header{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-left:1px solid var(--border);border-top:1px solid var(--border);margin-top:16px}
  .wh-cell{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px 0;text-align:center;font-size:11px;font-weight:500;color:var(--subtle);text-transform:uppercase;letter-spacing:.5px;background:var(--surface)}
  .cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-left:1px solid var(--border);border-top:1px solid var(--border)}
  .day-cell{border-right:1px solid var(--border);border-bottom:1px solid var(--border);min-height:100px;padding:6px 5px 5px;background:var(--surface)}
  .day-cell.other-month{background:#F4F2EE}
  .day-cell.today{background:#EFF6FF}
  .day-num{font-size:11px;font-weight:500;color:var(--subtle);margin-bottom:4px;display:block}
  .day-cell.today .day-num{color:#2563EB;font-weight:600}
  .day-cell.other-month .day-num{color:#C4C0B8}
  .pill{display:block;font-size:10px;font-weight:500;border-radius:4px;padding:2px 5px;margin-bottom:2px;cursor:pointer;line-height:1.4;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;transition:opacity .1s,transform .1s;border:none;text-align:left;width:100%}
  .pill:hover{opacity:.75;transform:scale(.98)}
  .pill-dawson{background:#DBEAFE;color:#1D4ED8}
  .pill-cameron{background:#D1FAE5;color:#047857}
  .pill-preston{background:#FEE2E2;color:#B91C1C}
  .pill-parker{background:#FEF3C7;color:#B45309}
  .busy-badge{display:inline-block;font-size:9px;font-family:'DM Mono',monospace;background:#F3F0EA;color:var(--subtle);border-radius:3px;padding:1px 4px;margin-bottom:3px}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center;padding:20px}
  .modal-overlay.open{display:flex}
  .modal{background:var(--surface);border-radius:12px;border:1px solid var(--border);width:100%;max-width:420px;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)}
  .modal-header{padding:16px 20px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--surface);border-radius:12px 12px 0 0}
  .modal-date{font-size:15px;font-weight:600}
  .modal-close{background:transparent;border:none;cursor:pointer;font-size:20px;color:var(--subtle);line-height:1;padding:0 2px}
  .modal-close:hover{color:var(--text)}
  .modal-body{padding:4px 0 8px}
  .modal-event{padding:12px 20px;border-bottom:1px solid var(--border)}
  .modal-event:last-child{border-bottom:none}
  .modal-kid-label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .modal-opp{font-size:14px;font-weight:500;color:var(--text);margin-bottom:3px}
  .modal-meta{font-size:12px;color:var(--muted);line-height:1.6;font-family:'DM Mono',monospace}
  .modal-note{display:inline-block;margin-top:4px;font-size:11px;font-style:italic;color:var(--subtle);font-family:'DM Sans',sans-serif}
  .ha-badge{display:inline-block;font-size:9px;font-weight:600;border-radius:3px;padding:1px 5px;margin-left:4px;text-transform:uppercase;letter-spacing:.3px}
  .ha-home{background:#D1FAE5;color:#047857}
  .ha-away{background:#FEE2E2;color:#B91C1C}
  .updated-bar{background:var(--bg);border-bottom:1px solid var(--border);padding:6px 28px;font-size:11px;color:var(--subtle);font-family:'DM Mono',monospace;display:flex;justify-content:space-between;align-items:center}
  @media(max-width:640px){
    .page-header,.cal-nav,.cal-wrap,.summary-bar,.updated-bar{padding-left:12px;padding-right:12px}
    .day-cell{min-height:70px}
    .page-title{font-size:16px}
  }
</style>
</head>
<body>
<div class="page-header">
  <div class="header-top">
    <div>
      <div class="page-title">Belcher Family Baseball Schedule</div>
      <div class="page-subtitle">NKCA 2026 Spring Season</div>
    </div>
    <div style="font-size:11px;color:#9A9890;font-family:'DM Mono',monospace;text-align:right;line-height:1.8" id="totals"></div>
  </div>
  <div class="legend">
    <div class="leg"><div class="leg-swatch" style="background:#2563EB"></div><span class="leg-name">Dawson</span> · Diamond Dawgs · 7U</div>
    <div class="leg"><div class="leg-swatch" style="background:#059669"></div><span class="leg-name">Cameron</span> · KC Sharks 11U · 11U</div>
    <div class="leg"><div class="leg-swatch" style="background:#DC2626"></div><span class="leg-name">Preston</span> · KC Diamond Crushers · 6U</div>
    <div class="leg"><div class="leg-swatch" style="background:#D97706"></div><span class="leg-name">Parker</span> · BPC Tower Buzzers · 10U</div>
  </div>
</div>
<div class="updated-bar">
  <span>Last synced: ${lastUpdated}</span>
  <span id="conflict-label" style="color:#B91C1C"></span>
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
const TEAMS={
  dawson: {label:'Dawson', team:'Diamond Dawgs',       age:'7U',  cls:'pill-dawson',  color:'#2563EB'},
  cameron:{label:'Cameron',team:'KC Sharks 11U',        age:'11U', cls:'pill-cameron', color:'#059669'},
  preston:{label:'Preston',team:'KC Diamond Crushers',  age:'6U',  cls:'pill-preston', color:'#DC2626'},
  parker: {label:'Parker', team:'BPC Tower Buzzers',    age:'10U', cls:'pill-parker',  color:'#D97706'},
};
const EVENTS=${eventsJson};
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TODAY='${new Date().toISOString().slice(0,10)}';
let curYear=2026,curMonth=3;

// Summary bar
const bar=document.getElementById('summary-bar');
['dawson','cameron','preston','parker'].forEach(k=>{
  const t=TEAMS[k];
  const n=EVENTS.filter(e=>e.kid===k).length;
  bar.innerHTML+=\`<div class="sum-card"><div class="sum-num" style="color:\${t.color}">\${n}</div><div class="sum-label">\${t.label}</div></div>\`;
});
document.getElementById('totals').textContent=EVENTS.length+' total games';

// Conflict detection
const byDate={};
EVENTS.forEach(e=>{byDate[e.date]=(byDate[e.date]||[]).concat(e)});
let conflicts=0;
for(const [date,evs] of Object.entries(byDate)){
  const kids=[...new Set(evs.map(e=>e.kid))];
  if(kids.length>=3) conflicts++;
}
if(conflicts) document.getElementById('conflict-label').textContent='⚠ '+conflicts+' busy day'+(conflicts>1?'s':'')+' (3+ kids)';

function pad(n){return String(n).padStart(2,'0')}
function dateKey(y,m,d){return \`\${y}-\${pad(m+1)}-\${pad(d)}\`}
function daysInMonth(y,m){return new Date(y,m+1,0).getDate()}
function firstDow(y,m){return new Date(y,m,1).getDay()}
function eventsOn(dk){return EVENTS.filter(e=>e.date===dk)}
function timeSort(a,b){
  const p=t=>{const[hm,ap]=t.split(' ');let[h,min]=hm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+min};
  return p(a.time)-p(b.time);
}

function render(){
  document.getElementById('month-label').textContent=MONTHS[curMonth]+' '+curYear;
  const grid=document.getElementById('cal-grid');
  const wh=document.getElementById('week-header');
  grid.innerHTML='';wh.innerHTML='';
  DAYS.forEach(d=>{const c=document.createElement('div');c.className='wh-cell';c.textContent=d;wh.appendChild(c)});
  const first=firstDow(curYear,curMonth);
  const days=daysInMonth(curYear,curMonth);
  const prevDays=daysInMonth(curYear,curMonth===0?11:curMonth-1);
  const total=Math.ceil((first+days)/7)*7;
  let monthGames=0;
  for(let i=0;i<total;i++){
    let y=curYear,m=curMonth,d,other=false;
    if(i<first){m=curMonth===0?11:curMonth-1;y=curMonth===0?curYear-1:curYear;d=prevDays-first+i+1;other=true}
    else if(i>=first+days){m=curMonth===11?0:curMonth+1;y=curMonth===11?curYear+1:curYear;d=i-first-days+1;other=true}
    else d=i-first+1;
    const dk=dateKey(y,m,d);
    const evs=eventsOn(dk).sort(timeSort);
    if(!other)monthGames+=evs.length;
    const cell=document.createElement('div');
    cell.className='day-cell'+(other?' other-month':'')+(dk===TODAY?' today':'');
    const num=document.createElement('span');num.className='day-num';num.textContent=d;cell.appendChild(num);
    if(evs.length>=3&&!other){const b=document.createElement('span');b.className='busy-badge';b.textContent=evs.length+' games';cell.appendChild(b)}
    evs.forEach(ev=>{
      const pill=document.createElement('button');
      pill.className='pill '+TEAMS[ev.kid].cls;
      pill.textContent=TEAMS[ev.kid].label+' '+ev.time;
      pill.title=TEAMS[ev.kid].label+' vs '+ev.opp+' · '+(ev.home?'Home':'Away')+' · '+ev.field;
      pill.onclick=e=>{e.stopPropagation();showModal(dk,eventsOn(dk).sort(timeSort))};
      cell.appendChild(pill);
    });
    grid.appendChild(cell);
  }
  document.getElementById('game-count').textContent=monthGames+' game'+(monthGames!==1?'s':'')+' this month';
}

function showModal(dk,evs){
  const d=new Date(dk+'T12:00:00');
  document.getElementById('modal-date').textContent=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const body=document.getElementById('modal-body');body.innerHTML='';
  evs.forEach(ev=>{
    const t=TEAMS[ev.kid];
    const div=document.createElement('div');div.className='modal-event';
    div.innerHTML=\`<div class="modal-kid-label" style="color:\${t.color}">\${t.label} — \${t.team} (\${t.age})</div>
      <div class="modal-opp">vs \${ev.opp}<span class="ha-badge \${ev.home?'ha-home':'ha-away'}">\${ev.home?'Home':'Away'}</span></div>
      <div class="modal-meta">\${ev.time} – \${ev.end}<br>\${ev.field}</div>
      \${ev.note?\`<div class="modal-note">\${ev.note}</div>\`:''}
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
