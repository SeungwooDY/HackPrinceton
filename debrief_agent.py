#!/usr/bin/env python3
"""Multi-step debrief coaching agent: analyzes one completed drill and gives
targeted suggestions.

Three deterministic "tools" do the actual data work (no LLM, no invented
facts); Gemini decides WHICH tools are worth calling, in what order, based on
what it learns -- then writes suggestions citing only what the tools
returned, forced into a JSON schema. Uses Gemini's real function-calling
("Interactions") API: https://generativelanguage.googleapis.com/v1beta/interactions
-- request/response shape confirmed with live test calls against this
project's actual GEMINI_API_KEY before writing this (it differs from the
older generateContent shape: steps[] with "thought"/"function_call"/
"model_output" entries, status "requires_action"/"completed", continuation
via previous_interaction_id -- see the test calls in this session's history).

Every tool call and the final suggestions are returned in "trace" so the
frontend can show the agent's actual reasoning steps, not just its answer.
"""
from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request

from generate_floor_tasks import load_env

GEMINI_MODEL = "gemini-3.8-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
GEMINI_API_REVISION = "2026-05-20"
MAX_ROUNDS = 4  # request round-trips; the last round forces tool_choice "none"

POINTS_TO_RANK = {3: "best", 2: "second_best", 1: "second_worst", 0: "worst"}


# ---------------------------------------------------------------------------
# Tools -- pure functions over data the caller already has. No LLM, no guessing.
# ---------------------------------------------------------------------------

def path_efficiency_breakdown(trail, plan):
    """Per-leg comparison between the trainee's recorded path and the optimal
    route's legs -- not just the one aggregate efficiency %, but WHICH leg
    cost the most extra distance."""
    if not plan or not plan.get("feasible") or not plan.get("legs"):
        return {"available": False, "reason": "no feasible optimal plan for this model"}

    first_visit = {}
    for point in trail:
        sid = point.get("sweepId")
        if sid and sid not in first_visit:
            first_visit[sid] = point.get("t")

    def distance_between(t_from, t_to):
        pts = sorted(
            (p for p in trail if t_from <= (p.get("t") or 0) <= t_to),
            key=lambda p: p.get("t") or 0,
        )
        total = 0.0
        for a, b in zip(pts, pts[1:]):
            pa, pb = a.get("position") or {}, b.get("position") or {}
            total += math.dist(
                (pa.get("x", 0), pa.get("y", 0), pa.get("z", 0)),
                (pb.get("x", 0), pb.get("y", 0), pb.get("z", 0)),
            )
        return total

    legs = []
    for leg in plan["legs"]:
        sweeps = leg.get("sweeps") or []
        if len(sweeps) < 2:
            continue
        t_start, t_end = first_visit.get(sweeps[0]), first_visit.get(sweeps[-1])
        if t_start is None or t_end is None or t_end < t_start:
            continue
        actual = distance_between(t_start, t_end)
        optimal = leg.get("meters", 0)
        legs.append({
            "from": leg.get("frm"), "to": leg.get("to"),
            "optimalMeters": optimal, "actualMeters": round(actual, 2),
            "overBy": round(actual - optimal, 2),
        })
    worst = max(legs, key=lambda l: l["overBy"], default=None)
    return {"available": True, "legs": legs, "worstLeg": worst}


def order_deviations(your_order, optimal_order):
    """Which checkpoints were visited out of position, by how much, and
    which optimal checkpoints were never reached at all."""
    if not optimal_order:
        return {"available": False, "reason": "no optimal order available"}
    deviations = []
    for i, cp_id in enumerate(optimal_order):
        your_pos = your_order.index(cp_id) if cp_id in your_order else None
        deviations.append({
            "checkpointId": cp_id, "optimalPosition": i + 1,
            "yourPosition": (your_pos + 1) if your_pos is not None else None,
            "delta": (your_pos - i) if your_pos is not None else None,
        })
    skipped = [d["checkpointId"] for d in deviations if d["yourPosition"] is None]
    return {"available": True, "deviations": deviations, "skipped": skipped}


def quiz_mistakes(quiz_items, answers):
    """Which quiz decisions weren't the best choice, with the scenario and
    the rationale for the choice that was better."""
    by_id = {q["id"]: q for q in quiz_items}
    mistakes = []
    for a in answers:
        q = by_id.get(a.get("checkpointId"))
        points = a.get("points")
        if not q or points is None or points >= 3:
            continue  # no match, or already the best choice -- not a mistake
        best_option = next(
            (o["text"] for o in q.get("options", []) if o.get("rank") == "best"), None,
        )
        mistakes.append({
            "checkpointId": q["id"], "label": q.get("checkpointLabel"),
            "scenario": q.get("scenario"),
            "yourChoiceRank": POINTS_TO_RANK.get(points, "unknown"),
            "betterChoice": best_option, "rationale": q.get("rationale"),
        })
    return {"available": True, "mistakes": mistakes, "mistakeCount": len(mistakes)}


TOOL_DECLARATIONS = [
    {"type": "function", "name": "path_efficiency",
     "description": "Per-leg distance comparison between the trainee's actual path and the "
                     "optimal route; finds the single worst (most-over-distance) leg.",
     "parameters": {"type": "object", "properties": {}, "required": []}},
    {"type": "function", "name": "order_deviations",
     "description": "How far out of order each checkpoint was visited vs. the optimal order, "
                     "and any checkpoints skipped entirely.",
     "parameters": {"type": "object", "properties": {}, "required": []}},
    {"type": "function", "name": "quiz_mistakes",
     "description": "Which quiz decisions weren't the best choice, with the scenario and the "
                     "rationale for why the better choice was better.",
     "parameters": {"type": "object", "properties": {}, "required": []}},
]

RESPONSE_FORMAT = {
    "type": "text", "mime_type": "application/json",
    "schema": {
        "type": "object",
        "properties": {"suggestions": {"type": "array", "items": {"type": "string"}}},
        "required": ["suggestions"],
    },
}

SYSTEM_INSTRUCTIONS = """You are a debrief coach analyzing a completed fire-training drill. \
You have three tools, each returning real measured data -- call only the ones that would \
actually add something new; you don't have to call any if the summary alone is conclusive \
(e.g. a perfect run doesn't need investigating). Once you've learned enough, stop calling \
tools and give your final answer.

Your final answer must be 2-4 suggestions, each citing a concrete number or event that a \
tool (or the summary below) actually returned -- never invent a fact. If performance was \
already excellent, say so plainly instead of inventing criticism."""


def _post(api_key, body):
    req = urllib.request.Request(
        GEMINI_URL, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={
            "x-goog-api-key": api_key, "Content-Type": "application/json",
            "Api-Revision": GEMINI_API_REVISION,
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_debrief_agent(plan, quiz_items, trail, your_order, optimal_order, answers):
    """The multi-step loop. Returns {suggestions, trace} -- trace records every
    tool the agent chose to call and what it got back, for display."""
    env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
    api_key = env.get("GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"suggestions": [], "trace": [], "error": "GEMINI_API_KEY not set"}

    your_meters = _trail_meters(trail)
    summary = {
        "score": sum(a.get("points", 0) for a in answers),
        "maxScore": len(answers) * 3,
        "checkpointsVisited": len(your_order),
        "checkpointsTotal": len(optimal_order) if optimal_order else len(your_order),
        "efficiencyPercent": (
            min(100, round(100 * plan["totalMeters"] / max(1e-6, your_meters)))
            if plan and plan.get("feasible") else None
        ),
    }

    trace = []
    interaction_id = None
    tools_called = set()
    body = {
        "model": GEMINI_MODEL,
        "input": SYSTEM_INSTRUCTIONS + "\n\nDrill summary: " + json.dumps(summary),
        "tools": TOOL_DECLARATIONS, "response_format": RESPONSE_FORMAT,
        "generation_config": {"tool_choice": "auto"},
    }

    for round_i in range(MAX_ROUNDS):
        last_round = round_i == MAX_ROUNDS - 1
        if last_round:
            body["generation_config"]["tool_choice"] = "none"
        try:
            data = _post(api_key, body)
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
            break

        steps = data.get("steps") or []
        calls = [s for s in steps if s.get("type") == "function_call"]
        outputs = [s for s in steps if s.get("type") == "model_output"]

        if not calls:
            text = "".join(
                block.get("text", "") for s in outputs for block in (s.get("content") or [])
            )
            try:
                suggestions = json.loads(text).get("suggestions") if text else []
            except json.JSONDecodeError:
                suggestions = []
            return {"suggestions": [str(s) for s in (suggestions or [])][:4], "trace": trace}

        results = []
        for call in calls:
            name = call.get("name")
            if name == "path_efficiency":
                result = path_efficiency_breakdown(trail, plan)
            elif name == "order_deviations":
                result = order_deviations(your_order, optimal_order)
            elif name == "quiz_mistakes":
                result = quiz_mistakes(quiz_items, answers)
            else:
                result = {"available": False, "reason": f"unknown tool {name}"}
            tools_called.add(name)
            trace.append({"tool": name, "result": result})
            results.append({
                "type": "function_result", "name": name, "call_id": call.get("id"),
                "result": [{"type": "text", "text": json.dumps(result)}],
            })

        interaction_id = data.get("id")
        body = {
            "model": GEMINI_MODEL, "previous_interaction_id": interaction_id,
            "tools": TOOL_DECLARATIONS, "response_format": RESPONSE_FORMAT,
            "generation_config": {"tool_choice": "auto"},
            "input": results,
        }

    return {"suggestions": [], "trace": trace}


def _trail_meters(trail):
    total = 0.0
    for a, b in zip(trail, trail[1:]):
        pa, pb = a.get("position") or {}, b.get("position") or {}
        total += math.dist(
            (pa.get("x", 0), pa.get("y", 0), pa.get("z", 0)),
            (pb.get("x", 0), pb.get("y", 0), pb.get("z", 0)),
        )
    return total
