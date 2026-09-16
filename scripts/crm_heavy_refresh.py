#!/usr/bin/env python3
"""Heavy CRM refresh вне n8n (Salebot full scan + enKod email_base).

n8n Code node ограничен ~300s task timeout — полный get_clients туда не влезает.
Запуск:
  set -a; source ~/.config/crm-dashboard.env; set +a
  python3 scripts/crm_heavy_refresh.py

Пишет через ingest: crm/_cache/salebot_base.json + обновляет messenger/email_base
в crm/base/{prev,cur}.json и meta.sources.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DASHBOARD = os.environ.get("DASHBOARD_BASE", "https://dashboard.edpro.ru")
WAREHOUSE = f"{DASHBOARD.rstrip('/')}/warehouse"
INGEST_URL = os.environ.get(
    "MGMT_WAREHOUSE_INGEST_URL",
    f"{DASHBOARD.rstrip('/')}/api/dev-warehouse/ingest",
)
SALEBOT_API_BASE = "https://chatter.salebot.pro/api"
ENKOD_API_BASE = os.environ.get("ENKOD_API_BASE", "https://api.enkod.ru").rstrip("/")

SALEBOT_BOTS = {
    "nutra": {"tg": ["edpronutricion_bot", "vyalov_edpro_bot"], "vk": []},
    "psi": {"tg": ["edpropsi_bot"], "vk": ["202635360"]},
    "sex": {"tg": ["edprosex_bot"], "vk": ["201669944"]},
    "icf": {"tg": ["edprocoachingicf_bot", "edprocoaching_bot"], "vk": ["201669903", "202326818"]},
    "design": {"tg": ["edprodesign_bot"], "vk": ["204324740"]},
}
ENKOD_BASE_GROUPS = {
    "nutra": "nutriciologia",
    "psi": "psychology",
    "sex": "sexology",
    "icf": "couching",
    "design": "design",
}
DIRECTIONS = ["nutra", "psi", "sex", "icf", "design"]


def as_of() -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d")
    except Exception:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def ym_of(iso: str) -> str:
    return iso[:7]


def prev_ym(ym: str) -> str:
    y, m = map(int, ym.split("-"))
    if m == 1:
        return f"{y - 1}-12"
    return f"{y}-{m - 1:02d}"


def http_json(url: str, headers: dict | None = None, timeout: int = 180) -> Any:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_bytes(url: str, headers: dict | None = None, timeout: int = 600) -> bytes:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_post_json(url: str, payload: dict, token: str, timeout: int = 120) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def retry(fn, attempts: int = 8, base: float = 1.0):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last = e
            time.sleep(min(60, base * (2 ** i)))
    raise last  # type: ignore


def norm_token(s: str) -> str:
    return re.sub(r"[^a-z0-9_]", "", str(s or "").lower().lstrip("@"))


def match_dir_channel(haystack: str):
    h = norm_token(haystack)
    if not h:
        return None
    for dir_, bots in SALEBOT_BOTS.items():
        for name in bots.get("tg") or []:
            n = norm_token(name)
            if n and (h == n or h in n or n in h):
                return dir_, "tg"
        for name in bots.get("vk") or []:
            n = norm_token(name)
            if n and (h == n or h in n or n in h):
                return dir_, "vk"
    return None


def salebot_get(key: str, path: str, qs: dict | None = None):
    q = urllib.parse.urlencode(qs or {})
    url = f"{SALEBOT_API_BASE}/{key}/{path}" + (f"?{q}" if q else "")
    return retry(lambda: http_json(url, timeout=180), attempts=8, base=1.0)


def fetch_salebot_bases(key: str) -> dict:
    bases = {d: {"messenger_tg": 0, "messenger_vk": 0} for d in DIRECTIONS}
    channels_raw = salebot_get(key, "connected_channels")
    group_map: dict[str, tuple[str, str]] = {}

    def add_channel(ch: dict, forced: str | None):
        if not isinstance(ch, dict):
            return
        group_id = ch.get("group_id") or ch.get("group") or ch.get("short_name") or ch.get("id")
        if group_id is None or group_id == "":
            return
        needles = [ch.get("short_name"), ch.get("group_id"), ch.get("group"), ch.get("name"), ch.get("username"), str(group_id)]
        hit = None
        for n in needles:
            hit = match_dir_channel(n or "")
            if hit:
                break
        if not hit:
            return
        dir_, channel = hit
        if forced:
            channel = forced
        group_map[str(group_id)] = (dir_, channel)

    if isinstance(channels_raw, dict) and not isinstance(channels_raw, list):
        for ch in channels_raw.get("telegram") or channels_raw.get("tg") or []:
            add_channel(ch, "tg")
        for ch in channels_raw.get("vkontakte") or channels_raw.get("vk") or []:
            add_channel(ch, "vk")
    else:
        channels = channels_raw if isinstance(channels_raw, list) else (
            (channels_raw or {}).get("channels")
            or (channels_raw or {}).get("data")
            or (channels_raw or {}).get("result")
            or []
        )
        for ch in channels:
            add_channel(ch, None)

    for dir_, bots in SALEBOT_BOTS.items():
        for name in bots.get("tg") or []:
            group_map[str(name)] = (dir_, "tg")
        for name in bots.get("vk") or []:
            group_map[str(name)] = (dir_, "vk")

    offset = 0
    limit = 500
    clients = 0
    pages = 0
    t0 = time.time()
    while pages < 4000:
        page = salebot_get(key, "get_clients", {"offset": offset, "limit": limit})
        lst = page if isinstance(page, list) else (
            (page or {}).get("clients")
            or (page or {}).get("data")
            or (page or {}).get("result")
            or (page or {}).get("items")
            or []
        )
        if not lst:
            break
        for c in lst:
            clients += 1
            gid = str(c.get("group") or c.get("group_id") or c.get("groupId") or "")
            mapped = group_map.get(gid)
            if not mapped:
                continue
            dir_, channel = mapped
            if channel == "tg":
                bases[dir_]["messenger_tg"] += 1
            elif channel == "vk":
                bases[dir_]["messenger_vk"] += 1
        pages += 1
        if len(lst) < limit:
            break
        offset += limit
        if pages % 20 == 0:
            print(f"  salebot pages={pages} clients={clients} sec={time.time()-t0:.0f}", flush=True)
            time.sleep(0.08)
        else:
            time.sleep(0.02)

    return {
        "asOf": as_of(),
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "clients": clients,
        "mappedGroups": len(group_map),
        "pages": pages,
        "byDirection": bases,
        "status": "ok",
    }


def fetch_enkod_bases(api_key: str) -> dict:
    out = {}
    for dir_, sn in ENKOD_BASE_GROUPS.items():
        url = f"{ENKOD_API_BASE}/v1/group/subscribers/?systemName={urllib.parse.quote(sn)}"
        raw = retry(lambda u=url: http_bytes(u, headers={"apiKey": api_key}, timeout=600), attempts=5, base=1.5)
        lines = [ln for ln in raw.splitlines() if ln]
        count = max(0, len(lines) - 1)
        out[dir_] = count
        print(f"  enkod {dir_}={count}", flush=True)
        time.sleep(0.2)
    return out


def checksum_data(data: Any) -> str:
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{h:08x}{len(s):08x}"


def patch_base_envelope(env: dict, salebot: dict, enkod_bases: dict, sources: dict) -> dict:
    data = env.get("data") or {}
    rows = data.get("rows") or []
    by = salebot.get("byDirection") or {}
    new_rows = []
    for row in rows:
        d = row.get("direction")
        sb = by.get(d) or {}
        nr = dict(row)
        if d in enkod_bases:
            nr["email_base"] = enkod_bases[d]
        if sb:
            nr["messenger_tg"] = sb.get("messenger_tg")
            nr["messenger_vk"] = sb.get("messenger_vk")
        new_rows.append(nr)
    data = {**data, "asOf": as_of(), "rows": new_rows}
    meta = dict(env.get("meta") or {})
    meta["asOf"] = as_of()
    meta["runMode"] = "heavy-external"
    meta["sources"] = {**(meta.get("sources") or {}), **sources}
    meta["note"] = "Heavy refresh вне n8n: Salebot full scan + enKod email_base."
    out = dict(env)
    out["data"] = data
    out["meta"] = meta
    out["fetchedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    out["checksum"] = checksum_data(data)
    return out


def patch_leading_meta(env: dict, sources: dict) -> dict:
    meta = dict(env.get("meta") or {})
    meta["asOf"] = as_of()
    meta["runMode"] = "heavy-external"
    meta["sources"] = {**(meta.get("sources") or {}), **sources}
    out = dict(env)
    out["meta"] = meta
    out["fetchedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if "data" in out:
        out["checksum"] = checksum_data(out["data"])
    return out


def main() -> int:
    salebot_key = os.environ.get("SALEBOT_API_KEY") or ""
    enkod_key = (
        os.environ.get("ENKOD_REPORTS_API_KEY")
        or os.environ.get("ENKOD_STATS_API_KEY")
        or os.environ.get("ENKOD_API_KEY")
        or ""
    )
    ingest_token = os.environ.get("MGMT_WAREHOUSE_INGEST_TOKEN") or ""
    if not salebot_key or not enkod_key or not ingest_token:
        print("Need SALEBOT_API_KEY, ENKOD_* key, MGMT_WAREHOUSE_INGEST_TOKEN", file=sys.stderr)
        return 2

    today = as_of()
    cur = ym_of(today)
    months = [prev_ym(cur), cur]
    print(f"heavy asOf={today} months={months}", flush=True)

    print("Salebot full scan…", flush=True)
    salebot = fetch_salebot_bases(salebot_key)
    print(f"Salebot done clients={salebot['clients']} pages={salebot['pages']}", flush=True)
    for d in DIRECTIONS:
        b = salebot["byDirection"][d]
        print(f"  {d} tg={b['messenger_tg']} vk={b['messenger_vk']}", flush=True)

    print("enKod email_base…", flush=True)
    enkod_bases = fetch_enkod_bases(enkod_key)

    sources = {
        "salebot": "ok",
        "enkod_base": "ok",
        "runMode": "heavy-external",
    }

    files: dict[str, Any] = {
        "crm/_cache/salebot_base.json": salebot,
    }

    for ym in months:
        try:
            base = http_json(f"{WAREHOUSE}/crm/base/{ym}.json", timeout=60)
            files[f"crm/base/{ym}.json"] = patch_base_envelope(base, salebot, enkod_bases, sources)
            print(f"patched base {ym}", flush=True)
        except Exception as e:
            print(f"skip base {ym}: {e}", flush=True)
        try:
            leading = http_json(f"{WAREHOUSE}/crm/leading/{ym}.json", timeout=60)
            files[f"crm/leading/{ym}.json"] = patch_leading_meta(leading, sources)
            print(f"patched leading meta {ym}", flush=True)
        except Exception as e:
            print(f"skip leading {ym}: {e}", flush=True)

    # merge manifest coverage lightly via remote
    manifest_crm = {}
    try:
        man = http_json(f"{WAREHOUSE}/manifest.json", timeout=60)
        for ds_id, path in [("crm.base", "crm/base"), ("crm.leading", "crm/leading")]:
            prev = (man.get("datasets") or {}).get(ds_id)
            if not prev:
                continue
            entry_periods = dict(prev.get("periods") or {})
            for ym in months:
                key = f"{path}/{ym}.json"
                if key not in files:
                    continue
                env = files[key]
                entry_periods[ym] = {
                    "fetchedAt": env.get("fetchedAt"),
                    "checksum": env.get("checksum"),
                    "file": f"{path}/{ym}.json",
                    "changed": True,
                    "source": "crm-heavy-external",
                }
            keys = sorted(entry_periods)
            manifest_crm[ds_id] = {
                "path": path,
                "coverage": {"from": keys[0], "to": keys[-1], "count": len(keys)},
                "periods": entry_periods,
            }
    except Exception as e:
        print(f"manifest warn: {e}", flush=True)

    body = {
        "asOf": today,
        "runMode": "heavy-external",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "files": files,
        "manifestCrmDatasets": manifest_crm,
        "summary": {
            "asOf": today,
            "runMode": "heavy-external",
            "salebotClients": salebot["clients"],
            "enkodBases": enkod_bases,
            "sources": sources,
        },
    }
    print("ingest…", flush=True)
    resp = http_post_json(INGEST_URL, body, ingest_token, timeout=180)
    print("ingest", resp, flush=True)
    return 0 if resp.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
