#!/usr/bin/env python3
"""Generate out/quiz_<model>.json from an exported SweepGraph.

The usual generator (quiz_scenarios.build_quiz) pulls rooms + labels from the
Matterport GraphQL API by propertyId + credentials. For a demo we don't have a
propertyId mapping, but a SweepGraph export (window.exportSweepGraph() + the
Exit marker panel) already carries every room id and the room->sweep mapping we
need. This builds the same quizItems shape straight from that file.

Each distinct room (excluding the "unknown" bucket for sweeps with no roomInfo)
becomes one quizItem, anchored to that room's CENTROID sweep -- the same
anchor_of() the planner (plan.py) uses to compute routes. Originally this used
a naive "first sweep found" anchor instead; for a room with several sweeps
that could be an off-center node the trainee doesn't naturally stand on,
which both made some questions unreliable to trigger AND meant the quiz's
anchor didn't match the point the route solver was actually routing to.
Scenario text is assigned with assign_distinct (no repeats within a
category), exactly as serve.py re-derives it live on load. Room labels from
the SDK export are "Unlabeled room", so categories fall back to "generic"
unless --labels supplies real labels (roomId -> label JSON) captured
separately.

Usage:
  python planner/quiz_from_sweepgraph.py planner/sweepgraph_KBqHB8Xq9Vo.json
  python planner/quiz_from_sweepgraph.py <graph> --labels labels.json --max 8
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from itertools import zip_longest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLANNER_DIR = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(PLANNER_DIR) not in sys.path:
    sys.path.insert(0, str(PLANNER_DIR))

from quiz_scenarios import assign_distinct  # noqa: E402
from contract import SweepGraph  # noqa: E402
from plan import anchor_of  # noqa: E402

OUT = ROOT / "out"


def rooms_from_graph(graph, labels, floor=None, labeled_only=False):
    """Ordered (room_id, label, anchor_sweep_id) for each real room, anchored
    to its centroid sweep (anchor_of) -- the same point the planner routes to.

    floor: if given, only rooms whose anchor sweep is on that floor are kept.

    Rooms are returned round-robin across floors so that a --max cap pulls an
    even spread from every floor rather than filling up one floor first. The
    planner can route across floors with same_floor=False; with
    same_floor=True, scope to one floor via `floor`."""
    label_of = {r.get("id"): r.get("label") for r in graph.get("rooms", [])}
    label_of.update(labels)  # explicit labels override the export's placeholders
    sweep_graph = SweepGraph.from_dict(graph)
    floor_of_sweep = {s.id: s.floor for s in sweep_graph.sweeps}
    room_ids = sorted({s.room for s in sweep_graph.sweeps if s.room and s.room != "unknown"})

    anchors = {}     # room_id -> centroid anchor sweep id
    room_floor = {}  # room_id -> floor of that anchor
    for rid in room_ids:
        if labeled_only and rid not in labels:
            continue  # only place checkpoints in rooms with a real captured label
        anchor = anchor_of(sweep_graph, rid)
        if anchor is None:
            continue
        if floor is not None and floor_of_sweep.get(anchor) != floor:
            continue
        anchors[rid] = anchor
        room_floor[rid] = floor_of_sweep.get(anchor)

    by_floor = {}
    for rid in anchors:
        by_floor.setdefault(room_floor[rid], []).append(rid)
    ordered = []
    for group in zip_longest(*(by_floor[f] for f in sorted(by_floor))):
        ordered.extend(rid for rid in group if rid is not None)
    return [(rid, label_of.get(rid) or "Unlabeled room", anchors[rid]) for rid in ordered]


def build(graph, labels, limit, floor=None, labeled_only=False):
    model_id = graph.get("modelId") or "unknown-model"
    rooms = rooms_from_graph(graph, labels, floor, labeled_only)
    if limit:
        rooms = rooms[:limit]
    assignment = assign_distinct((rid, label) for rid, label, _ in rooms)
    items = []
    for rid, label, sweep in rooms:
        category, scenario = assignment[rid]
        items.append({
            "roomId": rid,
            "roomLabel": label,
            "roomLabelSource": "sweepgraph-export",
            "matterportModelId": model_id,
            "sweepId": sweep,
            "quizCategory": category,
            "scenario": scenario["scenario"],
            "question": scenario["question"],
            "options": scenario["options"],
            "rationale": scenario["rationale"],
            "scenarioSource": "sweepgraph-derived",
        })
    return model_id, items


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("graph", help="path to sweepgraph_<model>.json")
    ap.add_argument("--labels", help="optional JSON mapping roomId -> real label")
    ap.add_argument("--max", type=int, default=0, help="cap number of checkpoints (0 = all)")
    ap.add_argument("--floor", type=int, default=None,
                    help="keep only rooms on this floor index (planner is same-floor)")
    ap.add_argument("--labeled-only", action="store_true",
                    help="only place checkpoints in rooms present in --labels (so every question matches its room)")
    args = ap.parse_args()

    graph = json.loads(Path(args.graph).read_text(encoding="utf-8"))
    labels = json.loads(Path(args.labels).read_text(encoding="utf-8")) if args.labels else {}

    model_id, items = build(graph, labels, args.max, args.floor, args.labeled_only)
    OUT.mkdir(exist_ok=True)
    out_path = OUT / f"quiz_{model_id}.json"
    out_path.write_text(
        json.dumps({"matterportModelId": model_id, "quizItems": items}, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {len(items)} quiz item(s) to {out_path}")
    for it in items:
        print(f"  [{it['quizCategory']:8}] {it['roomLabel']:14} {it['sweepId'][:10]}… {it['question']}")


if __name__ == "__main__":
    main()
