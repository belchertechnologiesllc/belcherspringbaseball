# NKCA Baseball Schedule — Belcher Family

Auto-syncing schedule for Dawson, Cameron, Preston, and Parker.  
Live site: **https://belcherspringbaseball.netlify.app**

## How it works

```
Once per day at 12:00 UTC:
  GitHub Actions → scrapes nkcabaseball.com (4 team URLs)
       ↓ changes detected?
      YES → rebuild index.html → commit snapshot → trigger Netlify deploy hook
       NO → stop, nothing to do
```

## Setup (one-time)

### 1. Push to GitHub

Create a new GitHub repo and push all files in this folder to it.

### 2. Connect Netlify to GitHub

1. Netlify → **Add new site → Import an existing project → GitHub**
2. Select your repo
3. Set **Publish directory** to `public`, leave **Build command** blank
4. Click **Deploy site**

Netlify will now redeploy automatically on every push — no secrets or deploy hooks needed.

### 3. Initial build

Run the workflow manually once to generate the first `public/index.html` and `schedule-snapshot.json`:

**GitHub → Actions → Check & Deploy Schedule → Run workflow → Force rebuild: ✓ → Run**

That commit will trigger an immediate Netlify deploy.

## Manual commands

```bash
# Run locally (check for changes, rebuild if needed)
node scripts/build.js

# Force rebuild regardless of changes
FORCE_REBUILD=1 node scripts/build.js
```

## Change log

Each sync writes `changes.json` with:
- `added` — new games
- `removed` — cancelled/removed games  
- `modified` — time, field, or opponent changes

## Schedule frequency

Edit `.github/workflows/schedule-sync.yml` → `cron: '0 12 * * *'`  
to change check frequency (currently once per day at 12:00 UTC).

> **Timezone note:** GitHub Actions cron uses **UTC** time.
