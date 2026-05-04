"""Fetches data from the Bouncie API and writes JSON snapshots into ./data.

Required env vars (set as GitHub Action secrets — only needed once):
    BOUNCIE_CLIENT_ID
    BOUNCIE_CLIENT_SECRET
    BOUNCIE_REDIRECT_URI      e.g. https://github.com/ttohumcu/bouncie
    BOUNCIE_REFRESH_TOKEN     one-time seed; auto-rotated into data/oauth.json

After the first successful run, data/oauth.json stores the refresh token
and is committed back to the repo. Subsequent runs read from there — no
secret updates or GH_PAT required.

Outputs (all kept indefinitely, day-by-day):
    data/vehicles.json          latest vehicle snapshot
    data/trips.json             every trip ever seen (deduped, full history)
    data/vehicle_history.json   one row per (date, vehicle): end-of-day stats
    data/stats.json             per-day aggregates over all-time + summary
    data/last_updated.json      metadata
    data/oauth.json             persisted OAuth state (NOT served by Pages)
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

API_BASE = "https://api.bouncie.dev/v1"
TOKEN_URL = "https://auth.bouncie.com/oauth/token"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OAUTH_FILE = DATA_DIR / "oauth.json"
TRIP_LOOKBACK_DAYS = 28  # how far back to query the API per run; older trips already on disk are preserved
TRIP_WINDOW_DAYS = 7    # max window per single API request (Bouncie enforces ≤1 week)


def load_oauth() -> dict:
    if OAUTH_FILE.exists():
        try:
            return json.loads(OAUTH_FILE.read_text())
        except Exception:
            pass
    return {}


def save_oauth(data: dict) -> None:
    OAUTH_FILE.write_text(json.dumps(data, indent=2))


def get_access_token() -> str:
    client_id = os.environ.get("BOUNCIE_CLIENT_ID")
    client_secret = os.environ.get("BOUNCIE_CLIENT_SECRET")
    redirect_uri = os.environ.get("BOUNCIE_REDIRECT_URI")
    auth_code = os.environ.get("BOUNCIE_AUTH_CODE")

    if not client_id or not client_secret:
        sys.exit("Set BOUNCIE_CLIENT_ID + BOUNCIE_CLIENT_SECRET.")

    # Prefer refresh token from persisted file, fall back to secret env var
    oauth = load_oauth()
    refresh_token = oauth.get("refresh_token") or os.environ.get("BOUNCIE_REFRESH_TOKEN")

    if refresh_token:
        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "redirect_uri": redirect_uri,
        }
    elif auth_code:
        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
        }
    else:
        sys.exit("No refresh token found. Set BOUNCIE_REFRESH_TOKEN secret for the first run.")

    resp = requests.post(TOKEN_URL, data=payload, timeout=30)
    if not resp.ok:
        print(f"Token exchange failed {resp.status_code}: {resp.text[:500]}")
    resp.raise_for_status()
    body = resp.json()
    print(f"Token exchange OK. Keys returned: {list(body.keys())}")

    # Always persist the latest refresh token — self-rotating, no GH_PAT needed
    if "refresh_token" in body:
        new_rt = body["refresh_token"]
        save_oauth({"refresh_token": new_rt})
        if new_rt != refresh_token:
            print("Refresh token rotated and saved to data/oauth.json.")
        else:
            print("Refresh token unchanged; saved to data/oauth.json.")

    access_token = body["access_token"]
    try:
        import base64
        parts = access_token.split(".")
        if len(parts) == 3:
            padded = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.b64decode(padded))
            print(f"Token scopes: {claims.get('scopes')}, exp: {claims.get('exp')}, userId: {claims.get('userId')}")
    except Exception as e:
        print(f"Could not decode token: {e}")
    return access_token


def api_get(token: str, path: str, params: dict | None = None) -> list | dict:
    resp = requests.get(
        f"{API_BASE}{path}",
        headers={"Authorization": token},  # Bouncie uses plain token, no Bearer prefix
        params=params,
        timeout=30,
    )
    if not resp.ok:
        print(f"::error::GET {path} → {resp.status_code}: {resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()


def load_json(name: str, default):
    path = DATA_DIR / name
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return default


def merge_trips(existing: list[dict], fresh: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for trip in existing + fresh:
        key = trip.get("transactionId") or trip.get("id") or f"{trip.get('startTime')}|{trip.get('imei')}"
        by_id[key] = trip
    out = list(by_id.values())
    out.sort(key=lambda t: t.get("startTime") or "", reverse=True)
    return out


def trip_start(t: dict) -> datetime | None:
    s = t.get("startTime") or t.get("start_ts")
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def update_vehicle_history(existing: list[dict], vehicles: list[dict]) -> list[dict]:
    """Append/update one row per (date, imei) with the current vehicle stats."""
    today = datetime.now(timezone.utc).date().isoformat()
    by_key: dict[tuple[str, str], dict] = {(r["date"], r["imei"]): r for r in existing if "date" in r and "imei" in r}
    for v in vehicles:
        imei = v.get("imei")
        if not imei:
            continue
        stats = v.get("stats") or {}
        loc = stats.get("location") or {}
        model_obj = v.get("model") or {}
        row = {
            "date": today,
            "imei": imei,
            "nickName": v.get("nickName"),
            "vin": v.get("vin"),
            "make": model_obj.get("make"),
            "model": model_obj.get("name"),
            "year": model_obj.get("year"),
            "odometer": stats.get("odometer"),
            "fuelLevel": stats.get("fuelLevel"),
            "isRunning": stats.get("isRunning"),
            "battery": (stats.get("battery") or {}).get("status") or (stats.get("battery") or {}).get("level"),
            "milOn": (stats.get("mil") or {}).get("milOn"),
            "speed": stats.get("speed"),
            "heading": loc.get("heading"),
            "lat": loc.get("lat"),
            "lon": loc.get("lon"),
            "lastUpdated": stats.get("lastUpdated"),
        }
        by_key[(today, imei)] = row
    rows = sorted(by_key.values(), key=lambda r: (r["date"], r.get("imei") or ""), reverse=True)
    return rows


def compute_stats(vehicles: list[dict], trips: list[dict]) -> dict:
    now = datetime.now(timezone.utc)

    by_day: dict[str, dict] = {}
    for t in trips:
        ts = trip_start(t)
        if not ts:
            continue
        day = ts.date().isoformat()
        bucket = by_day.setdefault(day, {
            "miles": 0.0, "trips": 0, "fuel": 0.0,
            "hard_brakes": 0, "hard_accels": 0, "max_mph": 0.0,
            "duration_min": 0.0,
        })
        miles = t.get("distance") or t.get("totalDistance") or 0
        bucket["miles"] += float(miles or 0)
        bucket["trips"] += 1
        bucket["fuel"] += float(t.get("fuelConsumed") or 0)
        bucket["hard_brakes"] += int(t.get("hardBrakingCount") or 0)
        bucket["hard_accels"] += int(t.get("hardAccelerationCount") or 0)
        top_speed = t.get("maxSpeed") or t.get("topSpeed") or 0
        if float(top_speed or 0) > bucket["max_mph"]:
            bucket["max_mph"] = float(top_speed)
        end = t.get("endTime") or t.get("end_ts")
        if end:
            try:
                end_ts = datetime.fromisoformat(end.replace("Z", "+00:00"))
                bucket["duration_min"] += max(0.0, (end_ts - ts).total_seconds() / 60.0)
            except ValueError:
                pass

    for vals in by_day.values():
        vals["miles"] = round(vals["miles"], 1)
        vals["fuel"] = round(vals["fuel"], 2)
        vals["duration_min"] = round(vals["duration_min"], 1)
        vals["max_mph"] = round(vals["max_mph"], 1)

    daily = [{"date": d, **vals} for d, vals in sorted(by_day.items())]

    def in_window(days: int) -> list[dict]:
        cutoff = now - timedelta(days=days)
        return [t for t in trips if (ts := trip_start(t)) and ts >= cutoff]

    def sum_field(items, *keys):
        total = 0.0
        for it in items:
            for k in keys:
                v = it.get(k)
                if isinstance(v, (int, float)):
                    total += float(v)
                    break
        return total

    last7 = in_window(7)
    last30 = in_window(30)

    return {
        "totals": {
            "trips_all": len(trips),
            "trips_7d": len(last7),
            "trips_30d": len(last30),
            "miles_all": round(sum_field(trips, "distance", "totalDistance"), 1),
            "miles_7d": round(sum_field(last7, "distance", "totalDistance"), 1),
            "miles_30d": round(sum_field(last30, "distance", "totalDistance"), 1),
            "fuel_all": round(sum_field(trips, "fuelConsumed"), 2),
            "fuel_7d": round(sum_field(last7, "fuelConsumed"), 2),
            "fuel_30d": round(sum_field(last30, "fuelConsumed"), 2),
            "hard_brakes_all": int(sum_field(trips, "hardBrakingCount")),
            "hard_accels_all": int(sum_field(trips, "hardAccelerationCount")),
            "hard_brakes_30d": int(sum_field(last30, "hardBrakingCount")),
            "hard_accels_30d": int(sum_field(last30, "hardAccelerationCount")),
        },
        "daily": daily,
        "vehicle_count": len(vehicles),
    }


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    token = get_access_token()

    vehicles = api_get(token, "/vehicles")
    if isinstance(vehicles, dict):
        vehicles = vehicles.get("vehicles") or vehicles.get("data") or []

    now = datetime.now(timezone.utc)
    lookback_start = now - timedelta(days=TRIP_LOOKBACK_DAYS)
    fresh_trips: list[dict] = []
    for v in vehicles:
        imei = v.get("imei")
        if not imei:
            continue

        # Diagnostic: probe the endpoint with no date filters to surface exact error
        try:
            probe = api_get(token, "/trips", params={"imei": imei})
            print(f"Trips probe (no date filter): got {type(probe).__name__} response")
        except requests.HTTPError:
            pass  # the ::error:: line is printed inside api_get

        # Walk backwards in ≤7-day windows (Bouncie API enforces max 1-week per request)
        window_end = now
        while window_end > lookback_start:
            window_start = max(window_end - timedelta(days=TRIP_WINDOW_DAYS), lookback_start)
            try:
                trips = api_get(
                    token,
                    "/trips",
                    params={
                        "imei": imei,
                        "starts-after": window_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "ends-before": window_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    },
                )
                if isinstance(trips, dict):
                    trips = trips.get("trips") or trips.get("data") or []
                for t in trips:
                    t.setdefault("imei", imei)
                fresh_trips.extend(trips)
                print(f"  Fetched {len(trips)} trips for {imei} {window_start.date()}–{window_end.date()}")
            except requests.HTTPError as e:
                print(f"::error::Trips {imei} {window_start.date()}–{window_end.date()}: {e}")
                break
            window_end = window_start

    existing_trips = (load_json("trips.json", {}) or {}).get("trips", [])
    merged_trips = merge_trips(existing_trips, fresh_trips)

    existing_history = (load_json("vehicle_history.json", {}) or {}).get("history", [])
    history = update_vehicle_history(existing_history, vehicles)

    stats = compute_stats(vehicles, merged_trips)
    updated_at = datetime.now(timezone.utc).isoformat()

    (DATA_DIR / "vehicles.json").write_text(json.dumps({"vehicles": vehicles, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "trips.json").write_text(json.dumps({"trips": merged_trips, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "vehicle_history.json").write_text(json.dumps({"history": history, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "stats.json").write_text(json.dumps({**stats, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "last_updated.json").write_text(json.dumps({"updated_at": updated_at}, indent=2))

    print(f"Wrote {len(vehicles)} vehicles, {len(merged_trips)} trips, {len(history)} history rows at {updated_at}")


if __name__ == "__main__":
    main()
