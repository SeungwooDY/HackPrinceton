#!/usr/bin/env python3
"""Serve the Matterport prototype with its browser SDK key from .env."""

import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"


def quiz_items_for_model(model_id):
    """All quizItems across out/quiz_*.json whose matterportModelId matches.

    Hybrid: the saved files supply the stable room/sweep anchors, but the scenario
    text is re-derived live from the current quiz_scenarios bank. Scenarios are
    assigned with NO repeats across this model's rooms (assign_distinct), so every
    question in a drill is different (until a category's pool is exhausted). Edits
    to the bank show up on reload with no regeneration. Falls back to the saved
    text if the generator module can't be imported."""
    try:
        from quiz_scenarios import assign_distinct
    except Exception:
        assign_distinct = None

    items = []
    if not OUT.is_dir():
        return items
    for path in sorted(OUT.glob("quiz_*.json")):
        try:
            doc = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for q in doc.get("quizItems", []):
            if q.get("matterportModelId") == model_id:
                items.append(q)

    if assign_distinct:
        try:
            assignment = assign_distinct(
                (q["roomId"], q.get("roomLabel")) for q in items if q.get("roomId")
            )
            for q in items:
                picked = assignment.get(q.get("roomId"))
                if not picked:
                    continue
                category, scenario = picked
                q.update({
                    "quizCategory": category,
                    "scenario": scenario["scenario"],
                    "question": scenario["question"],
                    "options": scenario["options"],
                    "rationale": scenario["rationale"],
                    "scenarioSource": "live-bank-rederived",
                })
        except Exception:
            pass  # keep the saved text
    return items


def sdk_key():
    value = os.environ.get("MATTER_PORT_SDK_KEY", "").strip()
    if value:
        return value
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].lstrip()
            name, separator, value = line.partition("=")
            if separator and name.strip() == "MATTER_PORT_SDK_KEY":
                value = value.strip()
                if value.startswith(("'", '"')):
                    quote = value[0]
                    end = value.find(quote, 1)
                    if end == -1:
                        return ""
                    return value[1:end]
                return value.split(" #", 1)[0].strip()
    return ""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/config.json":
            key = sdk_key()
            if not key:
                self.respond(503, "application/json", json.dumps({
                    "error": "Set MATTER_PORT_SDK_KEY in .env, then refresh."
                }).encode())
                return
            self.respond(200, "application/json", json.dumps({"matterportSdkKey": key}).encode())
        elif path == "/api/quiz":
            model_id = (parse_qs(urlsplit(self.path).query).get("model") or [""])[0]
            if not model_id:
                self.respond(400, "application/json", json.dumps({"error": "model query param required"}).encode())
                return
            items = quiz_items_for_model(model_id)
            self.respond(200, "application/json", json.dumps({"model": model_id, "quizItems": items}).encode())
        elif path in ("/", "/index.html") or path.startswith("/assets/"):
            dist = ROOT / "dist"
            target = (dist / ("index.html" if path in ("/", "/index.html") else path.lstrip("/"))).resolve()
            if target.is_relative_to(dist.resolve()) and target.is_file():
                self.respond(200, mimetypes.guess_type(target.name)[0] or "application/octet-stream", target.read_bytes())
            elif path in ("/", "/index.html"):
                self.respond(503, "text/plain", b"Build the React frontend first: npm install && npm run build")
            else:
                self.respond(404, "text/plain", b"Not found")
        else:
            self.respond(404, "text/plain", b"Not found")

    def respond(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Avoid logging request URLs that might contain credentials.
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Matterport viewer: http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
