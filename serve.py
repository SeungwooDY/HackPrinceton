#!/usr/bin/env python3
"""Serve the Matterport prototype with its browser SDK key from .env."""

import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote
from vexcel import ImageryError, imagery_for_model, site_for_model

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"


# Room labels too generic to show in a "Checkpoint N -- <room>" wayfinding label.
_GENERIC_CHECKPOINT_LABELS = {"other", "unfurnished", "unlabeled room"}


def quiz_items_for_model(model_id):
    """All quizItems across out/quiz_*.json whose matterportModelId matches.

    Hybrid: the saved files supply the stable room/sweep anchors, but the scenario
    text is re-derived live from the current quiz_scenarios bank. Scenarios are
    assigned with NO repeats across this model's rooms (assign_distinct), so every
    question in a drill is different (until a category's pool is exhausted). Edits
    to the bank show up on reload with no regeneration. Falls back to the saved
    text if the generator module can't be imported.

    Every item also gets a stable "id" (q1, q2, ...) and a "checkpointLabel"
    ("Checkpoint 3", or "Checkpoint 3 -- Bedroom" when the room has a real
    label). This numbering is order-BLIND on purpose: it's a stable wayfinding
    name for a native 3D marker, not a hint about which checkpoint the solver
    says to visit first -- that comparison only happens after the drill, in
    the debrief."""
    try:
        from quiz_scenarios import assign_distinct
    except Exception:
        assign_distinct = None

    items = []
    if not OUT.is_dir():
        return items
    for path in sorted(OUT.glob("quiz_*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
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

    for i, q in enumerate(items):
        q["id"] = f"q{i + 1}"
        room_label = (q.get("roomLabel") or "").strip()
        has_real_label = bool(room_label) and room_label.lower() not in _GENERIC_CHECKPOINT_LABELS
        q["checkpointLabel"] = f"Checkpoint {i + 1} -- {room_label}" if has_real_label else f"Checkpoint {i + 1}"
    return items


def route_plan_for_model(model_id):
    """Optimal route through this model's quiz rooms. Needs an exported SweepGraph
    at planner/sweepgraph_<model>.json (from window.exportSweepGraph())."""
    import sys
    planner_dir = ROOT / "planner"
    graph_path = planner_dir / f"sweepgraph_{model_id}.json"
    if not graph_path.is_file():
        return {"feasible": False,
                "error": f"No exported SweepGraph. Run exportSweepGraph() for "
                         f"{model_id} and save {graph_path.name} into planner/."}
    if str(planner_dir) not in sys.path:
        sys.path.insert(0, str(planner_dir))
    from contract import SweepGraph
    from adapter import tasklist_from_quiz
    from plan import plan

    graph = SweepGraph.load(str(graph_path))
    tl = tasklist_from_quiz({"quizItems": quiz_items_for_model(model_id)}, graph)
    rp = plan(graph, tl, max_edge_meters=6.0, same_floor=False, auto_complete_start=False)
    exit_sweep = next((e.sweepId for e in graph.exits if e.id == rp.exitId), None)
    return {
        "drillId": rp.drillId, "feasible": rp.feasible, "order": rp.order,
        "exitId": rp.exitId, "exitSweepId": exit_sweep,
        "totalMeters": rp.totalMeters, "unreachable": rp.unreachable,
        "legs": [{"from": lg.frm, "to": lg.to, "sweeps": lg.sweeps,
                  "meters": lg.meters, "carrying": lg.carrying} for lg in rp.legs],
    }


def sdk_key():
    value = os.environ.get("MATTER_PORT_SDK_KEY", "").strip()
    if value:
        return value
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
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
            self.respond(200, "application/json", json.dumps({"matterportSdkKey": key, "matterportBundleUrl": "/bundle/showcase.html" if (ROOT / "public/bundle/showcase.html").is_file() or (ROOT / "dist/bundle/showcase.html").is_file() else None}).encode())
        elif path.startswith("/bundle/"):
            relative = unquote(path[len("/bundle/"):])
            for base in (ROOT / "public/bundle", ROOT / "dist/bundle"):
                target = (base / relative).resolve()
                if target.is_relative_to(base.resolve()) and target.is_file():
                    self.respond(200, mimetypes.guess_type(target.name)[0] or "application/octet-stream", target.read_bytes())
                    return
            self.respond(404, "text/plain", b"Matterport bundle missing. Run npm run setup:bundle.")
        elif path in ("/api/aerial/site", "/api/aerial/image"):
            query = parse_qs(urlsplit(self.path).query)
            model_id = (query.get("model") or [""])[0]
            try:
                if not model_id or len(model_id) != 11 or not model_id.isascii() or not model_id.isalnum():
                    raise ImageryError("A valid model query parameter is required.", 400)
                if path.endswith("/site"):
                    self.respond(200, "application/json", json.dumps(site_for_model(model_id)).encode())
                else:
                    try:
                        width = int((query.get("width") or ["600"])[0])
                    except ValueError:
                        raise ImageryError("Invalid aerial view width.", 400) from None
                    content_type, image = imagery_for_model(model_id, width)
                    self.respond(200, content_type, image)
            except ImageryError as failure:
                self.respond(failure.status, "application/json", json.dumps({"error": str(failure)}).encode())
        elif path == "/api/quiz":
            model_id = (parse_qs(urlsplit(self.path).query).get("model") or [""])[0]
            if not model_id:
                self.respond(400, "application/json", json.dumps({"error": "model query param required"}).encode())
                return
            items = quiz_items_for_model(model_id)
            self.respond(200, "application/json", json.dumps({"model": model_id, "quizItems": items}).encode())
        elif path == "/api/plan":
            model_id = (parse_qs(urlsplit(self.path).query).get("model") or [""])[0]
            if not model_id:
                self.respond(400, "application/json", json.dumps({"error": "model query param required"}).encode())
                return
            try:
                result = route_plan_for_model(model_id)
            except Exception as e:
                result = {"feasible": False, "error": str(e)[:300]}
            self.respond(200, "application/json", json.dumps(result).encode())
        elif path in ("/", "/index.html") or path.startswith("/assets/") or path.startswith("/models/"):
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
