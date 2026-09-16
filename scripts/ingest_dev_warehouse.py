#!/usr/bin/env python3
"""HTTP ingest for warehouse JSON from n8n (dev.* + crm.* + sales.* + bots.*).

POST /ingest
  Authorization: Bearer <token>
  Body: {
    "asOf": "...",
    "files": { "dev/...": {...}, "crm/...": {...}, "sales/...": {...}, "bots/...": {...} },
    "manifestDevDatasets": { "dev.card": {...} },
    "manifestCrmDatasets": { "crm.leading": {...} },
    "manifestBotsDatasets": { "bots.funnel": {...} }
  }

Allowed paths: dev/**, crm/**, sales/**, bots/**, manifest.json
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(os.environ.get("MGMT_WAREHOUSE_ROOT", "/var/www/management-report/warehouse"))
TOKEN_PATH = Path(os.environ.get("MGMT_INGEST_TOKEN_FILE", "/etc/management-report/dev-warehouse-ingest.token"))
HOST = os.environ.get("MGMT_INGEST_HOST", "127.0.0.1")
PORT = int(os.environ.get("MGMT_INGEST_PORT", "8791"))

ALLOWED_PREFIXES = ("dev/", "crm/", "sales/", "bots/")


def load_token() -> str:
    return TOKEN_PATH.read_text(encoding="utf-8").strip()


def path_allowed(rel: str) -> bool:
    if rel == "manifest.json":
        return True
    return any(rel.startswith(p) for p in ALLOWED_PREFIXES)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def _auth_ok(self) -> bool:
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            return False
        return auth[7:].strip() == load_token()

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(
                200,
                {
                    "ok": True,
                    "service": "warehouse-ingest",
                    "allows": list(ALLOWED_PREFIXES) + ["manifest.json"],
                },
            )
            return
        self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/ingest":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        if not self._auth_ok():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            payload = self._read_json()
        except Exception as e:
            self._send(400, {"ok": False, "error": f"bad_json: {e}"})
            return

        files = payload.get("files") or {}
        if not isinstance(files, dict) or not files:
            self._send(400, {"ok": False, "error": "files required"})
            return

        written = []
        for rel, content in files.items():
            rel = str(rel).lstrip("/")
            if ".." in rel.split("/"):
                self._send(400, {"ok": False, "error": f"bad path: {rel}"})
                return
            if not path_allowed(rel):
                self._send(400, {"ok": False, "error": f"path not allowed: {rel}"})
                return
            target = ROOT / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, (dict, list)):
                text = json.dumps(content, ensure_ascii=False, indent=2) + "\n"
            else:
                text = str(content)
                if not text.endswith("\n"):
                    text += "\n"
            target.write_text(text, encoding="utf-8")
            written.append(rel)

        patches = []
        for key, prefix in (
            ("manifestDevDatasets", "dev."),
            ("manifestCrmDatasets", "crm."),
            ("manifestBotsDatasets", "bots."),
            ("manifestDatasets", None),
        ):
            patch = payload.get(key)
            if isinstance(patch, dict) and patch:
                patches.append((patch, prefix))

        if patches:
            manifest_path = ROOT / "manifest.json"
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            else:
                manifest = {
                    "version": "2.0",
                    "schemaVersion": "2.0",
                    "warehouseVersion": "2.0",
                    "datasets": {},
                }
            if "datasets" not in manifest or not isinstance(manifest["datasets"], dict):
                manifest["datasets"] = {}
            for patch, prefix in patches:
                for ds_id, ds_body in patch.items():
                    if prefix is not None and not str(ds_id).startswith(prefix):
                        continue
                    if prefix is None and not (
                        str(ds_id).startswith("dev.")
                        or str(ds_id).startswith("crm.")
                        or str(ds_id).startswith("bots.")
                    ):
                        continue
                    prev = manifest["datasets"].get(ds_id) or {}
                    if isinstance(ds_body, dict) and isinstance(prev.get("periods"), dict):
                        merged_periods = {**prev.get("periods", {}), **(ds_body.get("periods") or {})}
                        ds_body = {**ds_body, "periods": merged_periods}
                        keys = sorted(merged_periods.keys())
                        ds_body["coverage"] = {
                            "from": keys[0] if keys else None,
                            "to": keys[-1] if keys else None,
                            "count": len(keys),
                        }
                    manifest["datasets"][ds_id] = ds_body
            manifest["generatedAt"] = payload.get("generatedAt") or datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            manifest["warehouseVersion"] = "2.0"
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            written.append("manifest.json")

        self._send(200, {"ok": True, "written": written, "asOf": payload.get("asOf")})


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"warehouse-ingest on {HOST}:{PORT} allows={ALLOWED_PREFIXES}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
