"""Fetches data from the Bouncie API and writes JSON snapshots into ./data.

Required env vars (set as GitHub Action secrets):
    BOUNCIE_CLIENT_ID
    BOUNCIE_CLIENT_SECRET
    BOUNCIE_REDIRECT_URI
    BOUNCIE_REFRESH_TOKEN   (or BOUNCIE_AUTH_CODE for first-run exchange)

Outputs:
    data/vehicles.json       latest vehicle snapshot
    data/trips.json          rolling 90-day trip history (deduped)
    data/stats.json          computed aggregates for the dashboard
    data/last_updated.json   metadata
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
TRIP_HISTORY_DAYS = 90


def get_access_token() -> str:
    client_id = os.environ["BOUNCIE_CLIENT_ID"]
    client_secret = os.environ["BOUNCIE_CLIENT_SECRET"]
    redirect_uri = os.environ["BOUNCIE_REDIRECT_URI"]
    refresh_token = os.environ.get("BOUNCIE_REFRESH_TOKEN")
    auth_code = os.environ.get("BOUNCIE_AUTH_CODE")

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
        sys.exit("Set BOUNCIE_REFRESH_TOKEN or BOUNCIE_AUTH_CODE.")

    resp = requests.post(TOKEN_URL, data=payload, timeout=30)
    resp.raise_for_status()
    body = resp.json()
    if "refresh_token" in body and body["refresh_token"] != refresh_token:
        # Surface a rotated refresh token so the user can update the secret.
        print("::warning::Bouncie returned a new refresh_token. Update BOUNCIE_REFRESH_TOKEN secret.")
        print(f"new_refresh_token={body['refresh_token']}")
    return body["access_token"]


def api_get(token: str, path: str, params: dict | None = None) -> list | dict:
    resp = requests.get(
        f"{API_BASE}{path}",
        headers={"Authorization": token},
        params=params,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def load_existing_trips() -> list[dict]:
    path = DATA_DIR / "trips.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text()).get("trips", [])
    except (json.JSONDecodeError, AttributeError):
        return []


def merge_trips(existing: list[dict], fresh: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for trip in existing + fresh:
        key = trip.get("transactionId") or trip.get("id") or f"{trip.get('startTime')}|{trip.get('imei')}"
        by_id[key] = trip
    cutoff = datetime.now(timezone.utc) - timedelta(days=TRIP_HISTORY_DAYS)
    out = []
    for trip in by_id.values():
        start = trip.get("startTime") or trip.get("start_ts")
        if start:
            try:
                ts = datetime.fromisoformat(start.replace("Z", "+00:00"))
                if ts < cutoff:
                    continue
            except ValueError:
                pass
        out.append(trip)
    out.sort(key=lambda t: t.get("startTime") or "", reverse=True)
    return out


def compute_stats(vehicles: list[dict], trips: list[dict]) -> dict:
    now = datetime.now(timezone.utc)

    def trip_start(t: dict) -> datetime | None:
        s = t.get("startTime") or t.get("start_ts")
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None

    def in_window(days: int) -> list[dict]:
        cutoff = now - timedelta(days=days)
        return [t for t in trips if (ts := trip_start(t)) and ts >= cutoff]

    def sum_field(items: list[dict], *keys: str) -> float:
        total = 0.0
        for it in items:
            for k in keys:
                v = it.get(k)
                if isinstance(v, (int, float)):
                    total += float(v)
                    break
        return total

    by_day: dict[str, dict[str, float]] = {}
    for t in in_window(30):
        ts = trip_start(t)
        if not ts:
            continue
        day = ts.date().isoformat()
        bucket = by_day.setdefault(day, {"miles": 0.0, "trips": 0, "fuel": 0.0, "hard_brakes": 0, "hard_accels": 0, "max_mph": 0.0})
        miles = t.get("distance") or t.get("totalDistance") or 0
        bucket["miles"] += float(miles or 0)
        bucket["trips"] += 1
        bucket["fuel"] += float(t.get("fuelConsumed") or 0)
        bucket["hard_brakes"] += int(t.get("hardBrakingCount") or 0)
        bucket["hard_accels"] += int(t.get("hardAccelerationCount") or 0)
        top_speed = t.get("maxSpeed") or t.get("topSpeed") or 0
        if float(top_speed or 0) > bucket["max_mph"]:
            bucket["max_mph"] = float(top_speed)

    daily = [{"date": d, **vals} for d, vals in sorted(by_day.items())]

    last7 = in_window(7)
    last30 = in_window(30)

    return {
        "totals": {
            "trips_7d": len(last7),
            "trips_30d": len(last30),
            "miles_7d": round(sum_field(last7, "distance", "totalDistance"), 1),
            "miles_30d": round(sum_field(last30, "distance", "totalDistance"), 1),
            "fuel_7d": round(sum_field(last7, "fuelConsumed"), 2),
            "fuel_30d": round(sum_field(last30, "fuelConsumed"), 2),
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

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=TRIP_HISTORY_DAYS)
    fresh_trips: list[dict] = []
    for v in vehicles:
        imei = v.get("imei")
        if not imei:
            continue
        try:
            trips = api_get(
                token,
                "/trips",
                params={
                    "imei": imei,
                    "starts-after": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "ends-before": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
            )
            if isinstance(trips, dict):
                trips = trips.get("trips") or trips.get("data") or []
            for t in trips:
                t.setdefault("imei", imei)
            fresh_trips.extend(trips)
        except requests.HTTPError as e:
            print(f"::warning::Failed to fetch trips for {imei}: {e}")

    merged = merge_trips(load_existing_trips(), fresh_trips)
    stats = compute_stats(vehicles, merged)
    updated_at = datetime.now(timezone.utc).isoformat()

    (DATA_DIR / "vehicles.json").write_text(json.dumps({"vehicles": vehicles, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "trips.json").write_text(json.dumps({"trips": merged, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "stats.json").write_text(json.dumps({**stats, "updated_at": updated_at}, indent=2))
    (DATA_DIR / "last_updated.json").write_text(json.dumps({"updated_at": updated_at}, indent=2))

    print(f"Wrote {len(vehicles)} vehicles, {len(merged)} trips at {updated_at}")


if __name__ == "__main__":
    main()
