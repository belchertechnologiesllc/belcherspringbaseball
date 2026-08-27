#!/usr/bin/env node
/**
 * Belcher Grandkids Sports Schedule Builder — Fall 2026
 *
 * Sources:
 *   LIVE (scraped daily):
 *     - NKCA Baseball (filter URL)  → Dawson (91945), Cameron (92229)
 *     - GameChanger iCal feeds      → Dawson, Cameron, Nora Softball
 *     - TeamSnap iCal feed          → Preston Eagles (Gold + Navy)
 *
 *   STATIC (hardcoded — update manually when schedules change):
 *     - Preston Eagles Gold/Navy — Flag Football (fallback if TeamSnap feed fails)
 *
 * Exit codes:
 *   0 = no changes, skip deploy
 *   1 = changes detected, rebuild + deploy
 *   2 = network/parse error, abort
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── NKCA team definitions ─────────────────────────────────────────────────────
const NKCA_TEAMS = [
  { kid: 'dawson',  id: '91945', label: 'Dawson',  team: 'Diamond Dawgs', age: '8U'  },
  { kid: 'cameron', id: '92229', label: 'Cameron', team: 'KC Sharks',      age: '12U' },
];
const NKCA_BASE = 'https://nkcabaseball.com/schedule/filter';
const NKCA_FROM = 'Aug+25+2026';

// ── GameChanger iCal feeds ────────────────────────────────────────────────────
const GC_FEEDS = [
  {
    kid:   'dawson',
    label: 'Dawson',
    team:  'Diamond Dawgs',
    url:   'https://api.team-manager.gc.com/ics-calendar-documents/user/18cba33e-a5b0-4edc-ae5f-89231fc8d1cf.ics?teamId=ac231855-94fe-4f22-8497-f395f19a6439&token=1d34c56ed4ed0959a4bfac392f6c9875558daed486b85640113c6b6331a72c80',
  },
  {
    kid:   'cameron',
    label: 'Cameron',
    team:  'KC Sharks',
    url:   'https://api.team-manager.gc.com/ics-calendar-documents/user/18cba33e-a5b0-4edc-ae5f-89231fc8d1cf.ics?teamId=5683a9ec-54a0-4bac-8716-4ccb015308f3&token=260be27b263f0132104c53ab6ac6907328cb6a774e946240bb1f35fc7b30aeb3',
  },
  {
    kid:   'parker',
    label: 'Parker',
    team:  'TBD',
    url:   'https://api.team-manager.gc.com/ics-calendar-documents/user/18cba33e-a5b0-4edc-ae5f-89231fc8d1cf.ics?teamId=958c2928-7e95-478b-8664-42eb815654c2&token=c175c47fd421697bc215603542a333d5b8631f7f8d98383537cd7d27c5be3132',
  },
  // nora-softball and nora-volleyball use STATIC_EVENTS
];

// ── TeamSnap iCal feeds ───────────────────────────────────────────────────────
// These are fetched as plain iCal. Games are split into Gold/Navy by time slot.
// Gold = earlier game each day, Navy = later game each day.
const TEAMSNAP_FEEDS = [
  {
    label: 'Preston Eagles',
    url:   'https://ical-cdn.teamsnap.com/team_schedule/7e606136-a4f4-421c-884d-d945b17870fb.ics',
  },
];

// ── Parse TeamSnap iCal ───────────────────────────────────────────────────────
function parseTeamSnapiCal(icsText) {
  const games = [];
  // Unfold iCal line continuations
  const unfolded = icsText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const eventBlocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of eventBlocks) {
    const end = block.indexOf('END:VEVENT');
    const ev  = block.slice(0, end);

    const summary = (ev.match(/^SUMMARY:(.+)$/m)?.[1] || '').replace(/\r/g,'').trim();
    if (!summary) continue;
    if (/practice|camp|meeting/i.test(summary)) continue;

    // Date/time
    const dtMatch = ev.match(/DTSTART(?:;[^:]+)?:(\d{8})T(\d{6})/);
    if (!dtMatch) continue;
    const dateStr = dtMatch[1];
    const timeStr = dtMatch[2];
    const year  = parseInt(dateStr.slice(0,4));
    const month = parseInt(dateStr.slice(4,6));
    const day   = parseInt(dateStr.slice(6,8));
    const hour  = parseInt(timeStr.slice(0,2));
    const min   = parseInt(timeStr.slice(2,4));
    const dateKey = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    if (dateKey < '2026-08-25') continue;

    const h12  = hour % 12 || 12;
    const ampm = hour < 12 ? 'AM' : 'PM';
    const timeFormatted = `${h12}:${String(min).padStart(2,'0')} ${ampm}`;

    let endFormatted = '';
    const dtEnd = ev.match(/DTEND(?:;[^:]+)?:(\d{8})T(\d{6})/);
    if (dtEnd) {
      const eh = parseInt(dtEnd[2].slice(0,2));
      const em = parseInt(dtEnd[2].slice(2,4));
      endFormatted = `${eh % 12 || 12}:${String(em).padStart(2,'0')} ${eh < 12 ? 'AM' : 'PM'}`;
    }

    const location = (ev.match(/^LOCATION:(.+)$/m)?.[1] || '').replace(/\r/g,'').trim();

    // Opponent from summary — TeamSnap format: "Eagles vs Opponent" or "Eagles @ Opponent"
    let opp  = summary;
    let home = true;
    const vsMatch = summary.match(/(?:vs\.?\s+|@\s*)(.+)$/i);
    if (vsMatch) {
      opp  = vsMatch[1].trim();
      home = !/@/.test(summary.slice(0, summary.search(/vs\.|@/i)));
    }

    games.push({ dateKey, timeFormatted, endFormatted, home, opp, field: location, hour, min });
  }

  // Sort by date then time
  games.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.hour * 60 + a.min - (b.hour * 60 + b.min));

  // Split into Gold (earlier game) and Navy (later game) by day
  const byDay = {};
  for (const g of games) {
    (byDay[g.dateKey] = byDay[g.dateKey] || []).push(g);
  }

  const result = [];
  for (const [date, dayGames] of Object.entries(byDay)) {
    dayGames.forEach((g, idx) => {
      const kid = idx === 0 ? 'gold-football' : 'navy-football';
      result.push({ kid, date, time: g.timeFormatted, end: g.endFormatted, home: g.home, opp: g.opp, field: g.field });
    });
  }

  return result;
}
const STATIC_EVENTS = [
  // NORA — Team Melton Softball 9/10U (Liberty Parks & Rec — hardcoded)
  { kid:'nora-softball', date:'2026-09-08', time:'6:00 PM',  end:'7:30 PM', home:false, opp:'Ducks',                 field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-09-15', time:'6:00 PM',  end:'7:30 PM', home:true,  opp:'Team Coultis',          field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-09-22', time:'6:00 PM',  end:'7:30 PM', home:false, opp:'Savage Queens',         field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-09-29', time:'7:30 PM',  end:'9:00 PM', home:true,  opp:'Savage Queens',         field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-10-13', time:'6:00 PM',  end:'7:30 PM', home:true,  opp:'Cotton Candy Crushers', field:'Sonic · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-10-20', time:'6:00 PM',  end:'7:30 PM', home:false, opp:'Team Coultis',          field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-10-27', time:'6:00 PM',  end:'7:30 PM', home:true,  opp:'Ducks',                 field:'The Landing · Liberty Parks & Rec' },
  { kid:'nora-softball', date:'2026-10-27', time:'7:30 PM',  end:'9:00 PM', home:false, opp:'Cotton Candy Crushers', field:'The Landing · Liberty Parks & Rec' },

  // NORA — Waves Volleyball (Liberty Parks & Rec / TeamSideline — hardcoded)
  { kid:'nora-volleyball', date:'2026-09-12', time:'1:30 PM',  end:'2:30 PM',  home:true,  opp:'Husnain',       field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-09-26', time:'10:30 AM', end:'11:30 AM', home:true,  opp:'Strikers',      field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-03', time:'8:30 AM',  end:'9:30 AM',  home:false, opp:'Lady Warriors', field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-10', time:'9:30 AM',  end:'10:30 AM', home:false, opp:'FCA Knights',   field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-10', time:'10:30 AM', end:'11:30 AM', home:true,  opp:'Panthers',      field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-17', time:'1:30 PM',  end:'2:30 PM',  home:true,  opp:'Broadbent',     field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-24', time:'8:30 AM',  end:'9:30 AM',  home:false, opp:'Dolphins',      field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
  { kid:'nora-volleyball', date:'2026-10-31', time:'8:30 AM',  end:'9:30 AM',  home:true,  opp:'Strikers',      field:'SVMS Court B, 1000 Midjay Dr, Liberty' },
]; // Preston football scraped from TeamSnap iCal; Dawson/Cameron from NKCA + GameChanger

const SNAPSHOT_FILE = path.join(__dirname, '..', 'schedule-snapshot.json');
const OUTPUT_FILE   = path.join(__dirname, '..', 'public', 'index.html');
const CHANGE_LOG    = path.join(__dirname, '..', 'changes.json');

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchUrl(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScheduleBot/1.0)', 'Accept': 'text/html,text/calendar,*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parse NKCA schedule filter HTML ──────────────────────────────────────────
function parseNKCA(html, kid) {
  const games = [];
  const myId  = NKCA_TEAMS.find(t => t.kid === kid)?.id;
  const rowRe = /<tr\s+id="event_\d+">([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    if (!row.includes('icon-clock')) continue;
    const isHome = /<span>Game\s+<img[^>]*title="Home Team"/i.test(row);
    const dateMatch = row.match(/(\w{3}),\s+(\w{3}\s+\d{1,2}\s+\d{4})/);
    if (!dateMatch) continue;
    const d = new Date(dateMatch[2]);
    if (isNaN(d.getTime())) continue;
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const timeMatch = row.match(/(\d{1,2}:\d{2}\s+[AP]M)\s+to\s+(\d{1,2}:\d{2}\s+[AP]M)/i);
    if (!timeMatch) continue;
    const fieldMatch = row.match(/title="Map">([^<]+)<\/span>/i);
    const field = fieldMatch ? fieldMatch[1].trim() : '';
    const oppMatch = row.match(/class="small-padding-left small-padding-right"[^>]*>([^<]+)<\/span>/i);
    if (!oppMatch) continue;
    const opp = oppMatch[1].replace(/&amp;/g, '&').trim();
    if (!opp || opp.length < 2) continue;
    const noteMatch = row.match(/class="margin-left schedule_more_info"[^>]*>([^<]+)<\/div>/i);
    games.push({ kid, date: dateKey, time: timeMatch[1], end: timeMatch[2], home: isHome, opp, field, note: noteMatch ? noteMatch[1].trim() : undefined });
  }
  return games;
}

// ── Parse GameChanger / Google Calendar iCal feed ────────────────────────────
function parseGCiCal(icsText, kid) {
  const games = [];

  // iCal lines can be "folded" — long lines wrapped with CRLF + space/tab
  // Unfold before parsing: remove any newline followed by whitespace
  const unfolded = icsText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');

  const eventBlocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of eventBlocks) {
    const end = block.indexOf('END:VEVENT');
    const ev  = block.slice(0, end);

    const summary = (ev.match(/^SUMMARY:(.+)$/m)?.[1] || '').replace(/\r/g,'').trim();
    if (!summary) continue;
    if (/practice|camp|meeting/i.test(summary)) continue;
    if (/\bTBD\b/i.test(summary)) continue; // skip unconfirmed placeholders

    // Handle both datetime and all-day date formats
    // DTSTART;VALUE=DATE:20260930          → all-day, no time
    // DTSTART:20260930T180000              → local time
    // DTSTART:20260930T230000Z            → UTC, needs CDT conversion (-5h)
    // DTSTART;TZID=America/Chicago:20260930T180000 → already local

    const dtRaw = ev.match(/^DTSTART([^:]*):(.+)$/m);
    if (!dtRaw) continue;
    const dtParams = dtRaw[1]; // e.g. ";VALUE=DATE" or ";TZID=America/Chicago" or ""
    const dtVal   = dtRaw[2].replace(/\r/g,'').trim();

    let dateKey, timeFormatted = '', endFormatted = '';

    if (/VALUE=DATE/i.test(dtParams)) continue; // skip all-day/unscheduled events
    if (false) {
      // All-day event — just a date
      const y = dtVal.slice(0,4), m = dtVal.slice(4,6), d = dtVal.slice(6,8);
      dateKey = `${y}-${m}-${d}`;
    } else {
      // Datetime event
      const dateStr = dtVal.slice(0,8);
      const timeStr = dtVal.slice(9,15);
      const isUtc   = dtVal.endsWith('Z');

      let year  = parseInt(dateStr.slice(0,4));
      let month = parseInt(dateStr.slice(4,6));
      let day   = parseInt(dateStr.slice(6,8));
      let hour  = parseInt(timeStr.slice(0,2));
      let min   = parseInt(timeStr.slice(2,4));

      if (isUtc) {
        // Convert UTC to CDT (UTC-5) — fall season is after DST ends Nov 1
        // Sep/Oct = CDT (UTC-5), Nov+ = CST (UTC-6)
        const offsetHours = (month < 11) ? 5 : 6;
        hour -= offsetHours;
        if (hour < 0) {
          hour += 24;
          day  -= 1;
          // Handle month rollback
          if (day < 1) {
            month -= 1;
            if (month < 1) { month = 12; year -= 1; }
            const daysInPrevMonth = new Date(year, month, 0).getDate();
            day = daysInPrevMonth;
          }
        }
      }

      dateKey = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const h12  = hour % 12 || 12;
      const ampm = hour < 12 ? 'AM' : 'PM';
      timeFormatted = `${h12}:${String(min).padStart(2,'0')} ${ampm}`;

      // End time
      const dtEndRaw = ev.match(/^DTEND([^:]*):(.+)$/m);
      if (dtEndRaw) {
        const ev2    = dtEndRaw[2].replace(/\r/g,'').trim();
        const isUtc2 = ev2.endsWith('Z');
        let eh = parseInt(ev2.slice(9,11));
        let em = parseInt(ev2.slice(11,13));
        let ed = parseInt(ev2.slice(6,8));
        let emo= parseInt(ev2.slice(4,6));
        if (isUtc2) {
          const offsetHours = (emo < 11) ? 5 : 6;
          eh -= offsetHours;
          if (eh < 0) eh += 24;
        }
        endFormatted = `${eh % 12 || 12}:${String(em).padStart(2,'0')} ${eh < 12 ? 'AM' : 'PM'}`;
      }
    }

    if (dateKey < '2026-08-25') continue;

    const location = (ev.match(/^LOCATION:(.+)$/m)?.[1] || '').replace(/\r/g,'').trim();

    let opp  = summary;
    let home = true;
    const vsMatch = summary.match(/(?:vs\.?\s+|@\s*)(.+)$/i);
    if (vsMatch) {
      opp  = vsMatch[1].trim();
      home = !/@/.test(summary.slice(0, summary.search(/vs\.|@/i)));
    }

    games.push({ kid, date: dateKey, time: timeFormatted, end: endFormatted, home, opp, field: location });
  }

  return games;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const liveGames = [];

  // 1. Scrape NKCA
  console.log('\n🔍 Fetching NKCA schedules...');
  for (const t of NKCA_TEAMS) {
    const url = `${NKCA_BASE}?team=${t.id}&eventType=1&location=0&complexId=0&gameSeasonId=0&ageGoupDivisionId=0&homeAwayValue=0&dateRange=21&fromDateRange=${NKCA_FROM}&toDateRange=`;
    console.log(`  ${t.label} (${t.id})...`);
    try {
      const html  = await fetchUrl(url);
      const games = parseNKCA(html, t.kid);
      console.log(`  → ${games.length} games`);
      liveGames.push(...games);
    } catch (err) {
      console.error(`  ✗ ${t.label}: ${err.message}`);
      process.exit(2);
    }
  }

  // 2. Fetch GameChanger iCal feeds
  console.log('\n🔍 Fetching GameChanger iCal feeds...');
  const gcKidsFound = new Set();
  for (const feed of GC_FEEDS) {
    console.log(`  ${feed.label} (GameChanger)...`);
    try {
      const ics   = await fetchUrl(feed.url);
      const games = parseGCiCal(ics, feed.kid);
      console.log(`  → ${games.length} games`);
      if (games.length === 0) {
        // Log first 500 chars of feed for debugging
        console.log(`  ⚠ Feed preview: ${ics.slice(0, 300).replace(/\n/g, ' ')}`);
      }
      // Only use GC games for kids that NKCA didn't already find
      // (GC is supplementary — adds tournaments, makeup games, etc.)
      const nkcaDates = new Set(liveGames.filter(g => g.kid === feed.kid).map(g => g.date + g.time));
      const newGames  = games.filter(g => !nkcaDates.has(g.date + g.time));
      console.log(`  → ${newGames.length} new/additional games from GameChanger`);
      liveGames.push(...newGames);
      if (newGames.length > 0) gcKidsFound.add(feed.kid); // only mark as found if we got real games
    } catch (err) {
      console.warn(`  ⚠ ${feed.label} GC feed failed: ${err.message} — continuing`);
    }
  }

  // 3. Fetch TeamSnap iCal feeds (Preston football)
  console.log('\n🔍 Fetching TeamSnap iCal feeds...');
  for (const feed of TEAMSNAP_FEEDS) {
    console.log(`  ${feed.label}...`);
    try {
      const ics   = await fetchUrl(feed.url);
      const games = parseTeamSnapiCal(ics);
      console.log(`  → ${games.length} games (split Gold/Navy by time slot)`);
      liveGames.push(...games);
    } catch (err) {
      console.warn(`  ⚠ ${feed.label} TeamSnap feed failed: ${err.message} — continuing`);
    }
  }

  // 4. Merge live + static, sort
  // Only include static events for kids NOT successfully fetched from a live feed
  const filteredStatic = STATIC_EVENTS.filter(e => !gcKidsFound.has(e.kid));
  const allEvents = [...liveGames, ...filteredStatic];
  allEvents.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  liveGames.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const newSnapshot = JSON.stringify(liveGames, null, 2);

  // 4. Diff
  let changed = true;
  const changes = { detected_at: new Date().toISOString(), added: [], removed: [], modified: [] };
  if (fs.existsSync(SNAPSHOT_FILE)) {
    const old = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    if (old === newSnapshot) {
      changed = false;
      console.log('\n✅ No schedule changes detected.');
    } else {
      console.log('\n⚡ Changes detected!');
      const oldGames = JSON.parse(old);
      const oldMap   = Object.fromEntries(oldGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
      const newMap   = Object.fromEntries(liveGames.map(g => [`${g.kid}|${g.date}|${g.time}`, g]));
      for (const [k,g] of Object.entries(newMap)) { if (!oldMap[k]) changes.added.push(g); else if (JSON.stringify(g)!==JSON.stringify(oldMap[k])) changes.modified.push({old:oldMap[k],new:g}); }
      for (const [k,g] of Object.entries(oldMap)) { if (!newMap[k]) changes.removed.push(g); }
      console.log(`  Added: ${changes.added.length}, Removed: ${changes.removed.length}, Modified: ${changes.modified.length}`);
    }
  } else {
    console.log('\n📋 No snapshot — first run.');
  }

  if (!changed && process.env.FORCE_REBUILD !== '1') { process.exit(0); }
  if (!changed) console.log('🔄 Force rebuild requested — rebuilding anyway.');
  changed = true; // ensure we always write and exit 1 when forced

  fs.writeFileSync(SNAPSHOT_FILE, newSnapshot);
  fs.writeFileSync(CHANGE_LOG, JSON.stringify(changes, null, 2));
  console.log('💾 Snapshot updated.');
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, buildHTML(allEvents));
  console.log(`✅ Built ${OUTPUT_FILE} with ${allEvents.length} events.`);
  process.exit(1);
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHTML(events) {
  const lastUpdated = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', month:'short', day:'numeric', year:'numeric',
    hour:'numeric', minute:'2-digit', timeZoneName:'short'
  });
  const eventsJson = JSON.stringify(events, null, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Belcher Grandkids Sports Schedule 2026</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--dawson:#2563EB;--cameron:#059669;--gold-football:#D97706;--navy-football:#1D4ED8;--nora-softball:#DB2777;--nora-volleyball:#9333EA;--parker:#7C3AED;--bg:#F9F7F4;--surface:#FFFFFF;--border:#E5E2DC;--text:#1A1916;--muted:#6B6860;--subtle:#9A9890}
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
  .filter-btn[data-kid="preston"].active{background:var(--gold-football)}
  .filter-btn[data-kid="nora"].active{background:var(--nora-softball)}
  .filter-btn[data-kid="parker"].active{background:var(--parker)}
  .summary-bar{display:flex;gap:12px;padding:12px 28px;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
  .sum-card{text-align:center;flex:1;min-width:60px}
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
  .pill-gold-football{background:#FEF3C7;color:#B45309}
  .pill-navy-football{background:#DBEAFE;color:#1E40AF}
  .pill-nora-softball{background:#FCE7F3;color:#BE185D}
  .pill-nora-volleyball{background:#F3E8FF;color:#7E22CE}
  .pill-parker{background:#EDE9FE;color:#6D28D9}
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
  @media(max-width:640px){.page-header,.cal-nav,.cal-wrap,.summary-bar,.updated-bar,.filter-bar{padding-left:12px;padding-right:12px}.day-cell{min-height:72px}.page-title{font-size:16px}.summary-bar{gap:8px}}
</style>
</head>
<body>
<div class="page-header">
  <div class="header-top">
    <div><div class="page-title">Belcher Grandkids Sports Schedule</div><div class="page-subtitle">Fall 2026 · NKCA Baseball · Liberty Parks &amp; Rec · Flag Football</div></div>
    <div style="font-size:11px;color:#9A9890;font-family:'DM Mono',monospace;text-align:right;line-height:1.9" id="hdr-totals"></div>
  </div>
  <div class="legend">
    <div class="leg"><div class="leg-swatch" style="background:#2563EB"></div><span class="leg-name">Dawson</span> · Diamond Dawgs · Baseball 8U</div>
    <div class="leg"><div class="leg-swatch" style="background:#059669"></div><span class="leg-name">Cameron</span> · KC Sharks · Baseball 12U</div>
    <div class="leg"><div class="leg-swatch" style="background:#D97706"></div><span class="leg-name">Preston</span> · Eagles Gold · Flag Football</div>
    <div class="leg"><div class="leg-swatch" style="background:#1D4ED8"></div><span class="leg-name">Preston</span> · Eagles Navy · Flag Football</div>
    <div class="leg"><div class="leg-swatch" style="background:#DB2777"></div><span class="leg-name">Nora</span> · Team Melton · Softball 9/10U</div>
    <div class="leg"><div class="leg-swatch" style="background:#9333EA"></div><span class="leg-name">Nora</span> · Waves · Volleyball</div>
    <div class="leg"><div class="leg-swatch" style="background:#7C3AED"></div><span class="leg-name">Parker</span> · TBD · Baseball</div>
  </div>
</div>
<div class="updated-bar"><span>Last synced: ${lastUpdated}</span><span id="conflict-label" style="color:#B91C1C"></span></div>
<div class="filter-bar">
  <span style="font-size:11px;color:var(--subtle);align-self:center;margin-right:4px">Filter:</span>
  <button class="filter-btn active" data-kid="all">All kids</button>
  <button class="filter-btn" data-kid="dawson">Dawson</button>
  <button class="filter-btn" data-kid="cameron">Cameron</button>
  <button class="filter-btn" data-kid="preston">Preston</button>
  <button class="filter-btn" data-kid="nora">Nora</button>
  <button class="filter-btn" data-kid="parker">Parker</button>
</div>
<div class="summary-bar" id="summary-bar"></div>
<div class="cal-nav">
  <div style="display:flex;align-items:center;gap:12px">
    <div class="nav-btns"><button class="nav-btn" id="prev">&#8249;</button><button class="nav-btn" id="next">&#8250;</button></div>
    <span class="month-label" id="month-label"></span>
  </div>
  <span class="game-count" id="game-count"></span>
</div>
<div class="cal-wrap"><div class="week-header" id="week-header"></div><div class="cal-grid" id="cal-grid"></div></div>
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-header"><span class="modal-date" id="modal-date"></span><button class="modal-close" id="modal-close">&times;</button></div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>
<script>
const KIDS={
  'dawson':       {label:'Dawson',  sport:'Baseball',     team:'Diamond Dawgs',age:'8U',   cls:'pill-dawson',       color:'#2563EB',group:'dawson'},
  'cameron':      {label:'Cameron', sport:'Baseball',     team:'KC Sharks',     age:'12U',  cls:'pill-cameron',      color:'#059669',group:'cameron'},
  'gold-football':{label:'Preston', sport:'Flag Football',team:'Eagles Gold',   age:'',     cls:'pill-gold-football',color:'#D97706',group:'preston'},
  'navy-football':{label:'Preston', sport:'Flag Football',team:'Eagles Navy',   age:'',     cls:'pill-navy-football',color:'#1D4ED8',group:'preston'},
  'nora-softball':{label:'Nora',    sport:'Softball',     team:'Team Melton',  age:'9/10U',cls:'pill-nora-softball',   color:'#DB2777',group:'nora'},
  'nora-volleyball':{label:'Nora', sport:'Volleyball',   team:'Waves',        age:'',     cls:'pill-nora-volleyball', color:'#9333EA',group:'nora'},
  'parker':       {label:'Parker',  sport:'Baseball',     team:'TBD',          age:'',     cls:'pill-parker',       color:'#7C3AED',group:'parker'},
};
const EVENTS=${eventsJson};
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TODAY=new Date().toISOString().slice(0,10);
let curYear=new Date().getFullYear(),curMonth=new Date().getMonth(),activeFilter='all';
const bar=document.getElementById('summary-bar');
[['dawson'],['cameron'],['gold-football','navy-football'],['nora-softball','nora-volleyball'],['parker']].forEach(keys=>{
  const n=EVENTS.filter(e=>keys.includes(e.kid)).length;
  const t=KIDS[keys[0]];
  bar.innerHTML+=\`<div class="sum-card"><div class="sum-num" style="color:\${t.color}">\${n}</div><div class="sum-label">\${t.label}</div></div>\`;
});
document.getElementById('hdr-totals').textContent=EVENTS.length+' total events';
const byDate={};EVENTS.forEach(e=>{byDate[e.date]=(byDate[e.date]||[]).concat(e)});
let conflicts=0;for(const evs of Object.values(byDate)){if([...new Set(evs.map(e=>KIDS[e.kid].group))].length>=3)conflicts++;}
if(conflicts)document.getElementById('conflict-label').textContent='⚠ '+conflicts+' busy day'+(conflicts>1?'s':'')+' (3+ kids)';
document.querySelectorAll('.filter-btn').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');activeFilter=btn.dataset.kid;render();});});
function pad(n){return String(n).padStart(2,'0')}
function dateKey(y,m,d){return \`\${y}-\${pad(m+1)}-\${pad(d)}\`}
function daysInMonth(y,m){return new Date(y,m+1,0).getDate()}
function firstDow(y,m){return new Date(y,m,1).getDay()}
function eventsOn(dk){return EVENTS.filter(e=>e.date===dk)}
function visibleOn(dk){return eventsOn(dk).filter(e=>activeFilter==='all'||KIDS[e.kid].group===activeFilter)}
function timeSort(a,b){const p=t=>{const[hm,ap]=t.split(' ');let[h,mn]=hm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+mn};return p(a.time)-p(b.time);}
function render(){
  document.getElementById('month-label').textContent=MONTHS[curMonth]+' '+curYear;
  const grid=document.getElementById('cal-grid'),wh=document.getElementById('week-header');
  grid.innerHTML='';wh.innerHTML='';
  DAYS.forEach(d=>{const c=document.createElement('div');c.className='wh-cell';c.textContent=d;wh.appendChild(c)});
  const first=firstDow(curYear,curMonth),days=daysInMonth(curYear,curMonth);
  const prevDays=daysInMonth(curYear,curMonth===0?11:curMonth-1);
  const total=Math.ceil((first+days)/7)*7;let monthGames=0;
  for(let i=0;i<total;i++){
    let y=curYear,m=curMonth,d,other=false;
    if(i<first){m=curMonth===0?11:curMonth-1;y=curMonth===0?curYear-1:curYear;d=prevDays-first+i+1;other=true}
    else if(i>=first+days){m=curMonth===11?0:curMonth+1;y=curMonth===11?curYear+1:curYear;d=i-first-days+1;other=true}
    else d=i-first+1;
    const dk=dateKey(y,m,d);const evs=visibleOn(dk).sort(timeSort);
    if(!other)monthGames+=evs.length;
    const cell=document.createElement('div');
    cell.className='day-cell'+(other?' other-month':'')+(dk===TODAY?' today':'');
    const num=document.createElement('span');num.className='day-num';num.textContent=d;cell.appendChild(num);
    if(evs.length>=3&&!other){const b=document.createElement('span');b.className='busy-badge';b.textContent=evs.length+' events';cell.appendChild(b)}
    evs.forEach(ev=>{
      const t=KIDS[ev.kid];const pill=document.createElement('button');
      pill.className='pill '+t.cls;pill.textContent=t.label+' '+ev.time;
      pill.title=t.label+' '+t.sport+' vs '+ev.opp+' \xb7 '+(ev.home?'Home':'Away')+' \xb7 '+ev.field;
      pill.onclick=e=>{e.stopPropagation();showModal(dk,eventsOn(dk).sort(timeSort))};cell.appendChild(pill);
    });grid.appendChild(cell);
  }
  document.getElementById('game-count').textContent=monthGames+' event'+(monthGames!==1?'s':'')+' this month'+(activeFilter!=='all'?' (filtered)':'');
}
function showModal(dk,evs){
  const d=new Date(dk+'T12:00:00');
  document.getElementById('modal-date').textContent=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const body=document.getElementById('modal-body');body.innerHTML='';
  evs.forEach(ev=>{
    const t=KIDS[ev.kid];const div=document.createElement('div');div.className='modal-event';
    const note=ev.note?\`<span class="modal-note">\${ev.note}</span>\`:'';
    div.innerHTML=\`<div class="modal-sport-badge" style="background:\${t.color}22;color:\${t.color}">\${t.sport}</div>
      <div class="modal-kid-label" style="color:\${t.color}">\${t.label} \u2014 \${t.team}\${t.age?' ('+t.age+')':''}</div>
      <div class="modal-opp">vs \${ev.opp}<span class="ha-badge \${ev.home?'ha-home':'ha-away'}">\${ev.home?'Home':'Away'}</span></div>
      <div class="modal-meta">\${ev.time}\${ev.end?' \u2013 '+ev.end:''}<br>\${ev.field}</div>\${note}\`;
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
