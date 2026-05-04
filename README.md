# Bouncie Analytics Dashboard

A static dashboard that pulls data from the [Bouncie API](https://docs.bouncie.dev) every 4 hours via GitHub Actions, commits JSON snapshots to the repo, and serves a Chart.js dashboard via GitHub Pages. Free to run.

## How it works

```
GitHub Actions (cron, every 4h)
  └─ scripts/fetch.py
       ├─ refresh OAuth token
       ├─ GET /vehicles
       ├─ GET /trips (last 90d, per IMEI)
       └─ writes data/*.json
  └─ git commit + push
  └─ deploy ./ to GitHub Pages
```

## One-time setup

### 1. Register a Bouncie developer app

1. Go to <https://www.bouncie.dev/> → **Sign in** → **Account** → **Apps**.
2. Click **Create app**.
3. Set **Redirect URI** to anything you control. The simplest option:
   `https://ttohumcu.github.io/bouncie/` (will work after Pages is enabled).
4. Copy the **Client ID** and **Client Secret**.

### 2. Get an authorization code

Open this URL in a browser (replace placeholders):

```
https://auth.bouncie.com/dialog/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT_URI&response_type=code&scope=basic
```

Approve the app. Bouncie will redirect to your URI with `?code=XXXX` in the URL. Copy that `code`.

### 3. Add GitHub repo secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
| --- | --- |
| `BOUNCIE_CLIENT_ID` | from step 1 |
| `BOUNCIE_CLIENT_SECRET` | from step 1 |
| `BOUNCIE_REDIRECT_URI` | exactly what you registered |
| `BOUNCIE_AUTH_CODE` | from step 2 (used only on the first run) |

### 4. Enable Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 5. Run the workflow

**Actions → Update Bouncie data → Run workflow**.

The first run exchanges your `BOUNCIE_AUTH_CODE` for tokens. Look at the job log for a line like:

```
::warning::Bouncie returned a new refresh_token. Update BOUNCIE_REFRESH_TOKEN secret.
new_refresh_token=...
```

Copy that value into a new secret named `BOUNCIE_REFRESH_TOKEN`, then **delete `BOUNCIE_AUTH_CODE`** (auth codes are single-use). All future runs will use the refresh token.

## Local testing

```bash
pip install -r requirements.txt
export BOUNCIE_CLIENT_ID=...
export BOUNCIE_CLIENT_SECRET=...
export BOUNCIE_REDIRECT_URI=...
export BOUNCIE_REFRESH_TOKEN=...
python scripts/fetch.py
python -m http.server 8000   # then open http://localhost:8000
```

## Files

- `scripts/fetch.py` — Bouncie API client + JSON writers
- `.github/workflows/update.yml` — scheduled fetch + Pages deploy
- `index.html`, `assets/` — dashboard UI
- `data/` — committed snapshots, all kept indefinitely:
  - `vehicles.json` — current vehicle state
  - `trips.json` — every trip ever seen (deduped)
  - `vehicle_history.json` — one row per (date, vehicle) with end-of-day stats
  - `stats.json` — per-day aggregates over all-time + summary totals

## Tweaks

- Change the refresh cadence: edit the `cron` in `.github/workflows/update.yml`. `0 */4 * * *` = every 4 hours.
- Change how far back each run queries the API: `TRIP_LOOKBACK_DAYS` in `scripts/fetch.py` (older trips already in `trips.json` are always kept).
- Add more endpoints: extend `main()` in `scripts/fetch.py` and surface them in `assets/dashboard.js`.
