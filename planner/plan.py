"""Step 5: plan() — the optimal order + route through a drill's tasks.

Meter-based v1 (the order search minimizes meters; estSeconds stays None). With
no rescues, this is a small TSP over the task anchors + start, ending at the
nearest usable exit. Rescues add a carry leg (room -> exit) under exitAfterRescue.

All cost goes through cost.leg_cost so the v2 speed layer is a one-function swap.
"""

from __future__ import annotations

from statistics import mean
from typing import Optional

from contract import (
    DEFAULT_SETTINGS, Leg, RoutePlan, Settings, SweepGraph, TaskList,
)
from cost import distance, leg_cost
from graph import build_graph, dijkstra, shortest_path

INF = float("inf")


def anchor_of(graph: SweepGraph, room_id: str) -> Optional[str]:
    """The room's center-most sweep (nearest the centroid of its sweeps)."""
    sweeps = [s for s in graph.sweeps if s.room == room_id]
    if not sweeps:
        return None
    cx = mean(s.position.x for s in sweeps)
    cy = mean(s.position.y for s in sweeps)
    cz = mean(s.position.z for s in sweeps)
    center = type(sweeps[0].position)(cx, cy, cz)
    return min(sweeps, key=lambda s: distance(s.position, center)).id


def usable_exits(graph: SweepGraph, blocked_exits: set[str]) -> list[tuple[str, str]]:
    """(exit_id, sweep_id) for exits that aren't blocked and (for windows) aren't
    known ladder-unreachable. null ladderReachable is treated as usable."""
    out = []
    for e in graph.exits:
        if e.id in blocked_exits:
            continue
        if e.type == "window" and e.ladderReachable is False:
            continue
        out.append((e.id, e.sweepId))
    return out


def _check_mustfollow(tasks) -> None:
    """Raise ValueError naming both tasks if mustFollow has a cycle."""
    ids = {t.id for t in tasks}
    deps = {t.id: [d for d in (t.mustFollow or []) if d in ids] for t in tasks}
    WHITE, GREY, BLACK = 0, 1, 2
    color = {tid: WHITE for tid in deps}

    def visit(u, stack):
        color[u] = GREY
        for v in deps[u]:
            if color[v] == GREY:
                raise ValueError(f"mustFollow cycle: {v} <-> {u}")
            if color[v] == WHITE:
                visit(v, stack + [u])
        color[u] = BLACK

    for tid in deps:
        if color[tid] == WHITE:
            visit(tid, [])


def plan(graph: SweepGraph, drill: TaskList, settings: Settings = DEFAULT_SETTINGS,
         *, max_edge_meters: Optional[float] = None, same_floor: bool = False) -> RoutePlan:
    sc = drill.scenario
    _check_mustfollow(drill.tasks)

    adj = build_graph(graph, sc.blockedSweeps, max_edge_meters=max_edge_meters, same_floor=same_floor)
    sweep_room = {s.id: s.room for s in graph.sweeps}
    start = drill.start_sweepId
    start_room = sweep_room.get(start)

    # A search task whose room contains the start is done at time 0; it drops out.
    prestarted = {t.id for t in drill.tasks
                  if t.type == "search" and t.roomId == start_room}
    tasks = [t for t in drill.tasks if t.id not in prestarted]

    anchors = {t.id: anchor_of(graph, t.roomId) for t in tasks}
    exits = usable_exits(graph, set(sc.blockedExits or ()))

    # Key nodes to run Dijkstra from: start, every anchor, every exit sweep.
    key_nodes = {start} | {a for a in anchors.values() if a} | {sw for _, sw in exits}
    dmaps, pmaps = {}, {}
    for n in key_nodes:
        if n in adj:
            dmaps[n], pmaps[n] = dijkstra(adj, n)

    def d(a: str, b: str) -> float:
        return dmaps.get(a, {}).get(b, INF)

    # Reachability: any task whose anchor is missing or unreachable from start.
    unreachable = [t.id for t in tasks
                   if not anchors[t.id] or d(start, anchors[t.id]) == INF]
    if unreachable:
        return RoutePlan(drill.drillId, False, [], [], None, 0.0, unreachable)

    has_rescue = any(t.type == "rescue" for t in tasks)
    if has_rescue and not exits:
        return RoutePlan(drill.drillId, False, [], [], None, 0.0,
                         [t.id for t in tasks if t.type == "rescue"])

    tasks_by_id = {t.id: t for t in tasks}
    best = {"cost": INF, "order": None, "exit": None, "legs": None}

    def search(cur, at_exit, remaining, done, cost, order, legmeta):
        if cost >= best["cost"]:
            return
        if not remaining:
            # Close the drill at an exit.
            if at_exit is not None:          # last task was a rescue, already outside
                total, exit_id, legs = cost, at_exit, legmeta
            elif exits:                      # walk to the nearest usable exit
                eid, esw = min(exits, key=lambda e: d(cur, e[1]))
                step = d(cur, esw)
                if step == INF:
                    return
                total = cost + step
                exit_id = eid
                legs = legmeta + [("exit:" + eid, cur, esw, step, False)]
            else:                            # search-only drill, no exits defined
                total, exit_id, legs = cost, None, legmeta
            if total < best["cost"]:
                best.update(cost=total, order=list(order), exit=exit_id, legs=legs)
            return

        for tid in remaining:
            t = tasks_by_id[tid]
            if any(dep not in done for dep in (t.mustFollow or [])):
                continue
            a = anchors[tid]
            reach = d(cur, a)
            if reach == INF:
                continue
            rest = remaining - {tid}
            nd = done | {tid}
            if t.type == "search":
                legs = legmeta + [(tid, cur, a, reach, False)]
                search(a, None, rest, nd, cost + reach, order + [tid], legs)
            else:  # rescue: reach the room, then carry to an exit, continue from there
                for eid, esw in exits:
                    carry = d(a, esw)
                    if carry == INF:
                        continue
                    legs = legmeta + [(tid, cur, a, reach, False),
                                      ("exit:" + eid, a, esw, carry, True)]
                    search(esw, eid, rest, nd, cost + reach + carry, order + [tid], legs)

    search(start, None, set(tasks_by_id), set(prestarted), 0.0, [], [])

    if best["order"] is None:
        return RoutePlan(drill.drillId, False, [], [], None, 0.0, [t.id for t in tasks])

    # Rebuild sweep paths for each leg from the stored predecessor maps.
    legs = []
    for to_label, frm_sw, to_sw, meters, carrying in best["legs"]:
        sweeps = shortest_path(pmaps.get(frm_sw, {}), frm_sw, to_sw) or [frm_sw, to_sw]
        # name the leg's "from" as start/taskId/exit for the first hop's origin
        legs.append(Leg(frm="start" if frm_sw == start and not legs else _node_name(frm_sw, start, anchors),
                        to=to_label, sweeps=sweeps, meters=round(meters, 2), carrying=carrying))

    return RoutePlan(
        drillId=drill.drillId, feasible=True, order=best["order"], legs=legs,
        exitId=best["exit"], totalMeters=round(best["cost"], 2), unreachable=[],
    )


def _node_name(sweep_id, start, anchors) -> str:
    if sweep_id == start:
        return "start"
    for tid, a in anchors.items():
        if a == sweep_id:
            return tid
    return sweep_id
