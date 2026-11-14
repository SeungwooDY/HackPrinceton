"""Adapt the task/quiz generators' output into a planner TaskList.

Neither generator emits a full TaskList, and they carry different fields:

  generate_floor_tasks.py -> {"tasks": [{ id, type(Search/Rescue/...),
      title, description, location: { locationId (REAL sweep id),
      matterportModelId, roomLabel } }]}
      -- has task TYPE, but the room id was dropped; we recover roomId from the
         SweepGraph via the sweep id (sweep.room).

  quiz_scenarios.py -> {"propertyId", "quizItems": [{ roomId (REAL room id),
      sweepId, matterportModelId, quizCategory, scenario, question,
      options[4 ranked], rationale }]}
      -- has roomId directly, but NO task type (quizzes are decision content,
         not navigation), so every item becomes a "search"/visit task. The 4
         ranked options are stashed in Task.extra for the (separate) decision grader.

Both return a planner `contract.TaskList`. `start` isn't in either generator's
output, so it's supplied here (default: a door exit sweep, else first sweep) and
is meant to be replaced by random_start() later.
"""

from __future__ import annotations

from typing import Optional

from contract import Task, TaskList, Scenario, SweepGraph


def _planner_type(generator_type: str) -> str:
    # Only Rescue adds a carry leg; every other type (Search/Recon/Ventilation/
    # Utility/Hazard/Evacuation) is "reach the room" == search for routing.
    return "rescue" if str(generator_type).strip().lower() == "rescue" else "search"


def _default_start(graph: Optional[SweepGraph]) -> str:
    if graph is None or not graph.sweeps:
        return ""  # caller should pass start_sweep; random_start() fills this later
    door = next((e for e in graph.exits if e.type == "door"), None)
    if door is not None:
        return door.sweepId
    return graph.sweeps[0].id


def tasklist_from_tasks(
    doc: dict,
    graph: SweepGraph,
    *,
    start_sweep: Optional[str] = None,
    drill_id: Optional[str] = None,
) -> TaskList:
    """Adapt generate_floor_tasks.py output. Needs the SweepGraph to recover
    roomId from each task's real sweep id."""
    sweep_to_room = {s.id: s.room for s in graph.sweeps}
    room_ids = {r.id for r in graph.rooms}

    model_id = graph.modelId
    tasks: list[Task] = []
    for t in doc.get("tasks", []):
        loc = t.get("location", {}) or {}
        sweep_id = loc.get("locationId")
        model_id = loc.get("matterportModelId") or model_id
        room_id = sweep_to_room.get(sweep_id)
        if room_id is None:
            # sweep not in this graph (wrong model, or placeholder sweep) -> skip
            print(f"  skip task {t.get('id')!r}: sweep {sweep_id!r} not in graph")
            continue
        if room_id not in room_ids:
            print(f"  warn task {t.get('id')!r}: room {room_id!r} not in graph.rooms")
        tasks.append(Task(
            id=str(t["id"]),
            type=_planner_type(t.get("type", "Search")),
            roomId=room_id,
            prompt=" — ".join(x for x in (t.get("title"), t.get("description")) if x) or None,
            extra={"generatorType": t.get("type"), "refs": t.get("refs"), "location": loc},
        ))

    floor_id = None
    if doc.get("tasks"):
        floor_id = (doc["tasks"][0].get("refs") or {}).get("propertyFloorId")
    return TaskList(
        drillId=drill_id or f"drill-{floor_id or model_id}",
        modelId=model_id,
        unitId=str(floor_id or model_id),
        start_sweepId=start_sweep or _default_start(graph),
        tasks=tasks,
        scenario=Scenario(),
    )


def tasklist_from_quiz(
    doc: dict,
    graph: Optional[SweepGraph] = None,
    *,
    start_sweep: Optional[str] = None,
    drill_id: Optional[str] = None,
) -> TaskList:
    """Adapt quiz_scenarios.py output. roomId comes straight from each quizItem;
    the graph is optional and only used to validate/choose a start sweep. Every
    item becomes a 'search' task (quizzes carry no Search/Rescue type); the 4
    ranked options are preserved in Task.extra for the decision grader."""
    room_ids = {r.id for r in graph.rooms} if graph else None

    model_id = None
    property_id = doc.get("propertyId")
    tasks: list[Task] = []
    for i, q in enumerate(doc.get("quizItems", [])):
        room_id = q.get("roomId")
        model_id = q.get("matterportModelId") or model_id
        if not room_id:
            print(f"  skip quizItem #{i}: no roomId")
            continue
        if room_ids is not None and room_id not in room_ids:
            print(f"  warn quizItem #{i}: room {room_id!r} not in graph.rooms")
        tasks.append(Task(
            id=q.get("id") or f"q{i + 1}",
            type="search",  # quizzes have no task type; visiting the room == search
            roomId=room_id,
            prompt=" ".join(x for x in (q.get("scenario"), q.get("question")) if x) or None,
            extra={
                "quizCategory": q.get("quizCategory"),
                "sweepId": q.get("sweepId"),
                "options": q.get("options"),      # the 4 ranked choices
                "rationale": q.get("rationale"),
            },
        ))

    return TaskList(
        drillId=drill_id or f"drill-{property_id or model_id}",
        modelId=model_id or (graph.modelId if graph else "unknown-model"),
        unitId=str(property_id or model_id or "unknown-unit"),
        start_sweepId=start_sweep or _default_start(graph),
        tasks=tasks,
        scenario=Scenario(),
    )


def to_tasklist(doc: dict, graph: Optional[SweepGraph] = None, **kw) -> TaskList:
    """Dispatch by shape: quiz docs have 'quizItems', task docs have 'tasks'."""
    if "quizItems" in doc:
        return tasklist_from_quiz(doc, graph, **kw)
    if "tasks" in doc:
        if graph is None:
            raise ValueError("task-file adapter needs a SweepGraph to recover roomId from sweep ids")
        return tasklist_from_tasks(doc, graph, **kw)
    raise ValueError("unrecognized generator output: expected 'quizItems' or 'tasks'")
