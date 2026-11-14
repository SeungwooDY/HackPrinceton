"""Step 2: build the navigable graph and run Dijkstra.

`build_graph` turns a SweepGraph into a weighted adjacency map:
  - one node per sweep,
  - every neighbor link becomes an edge BOTH ways (SDK links may be one-way),
  - blocked sweeps are dropped along with any edge touching them,
  - edge weight = leg_cost(straight-line meters) so the v2 speed swap is free.

`dijkstra` returns distances + a predecessor map from one source; `shortest_path`
rebuilds the sweep list for any reachable target.
"""

from __future__ import annotations

import heapq
from typing import Iterable, Optional

from contract import SweepGraph
from cost import distance, leg_cost

# adjacency: sweep_id -> list of (neighbor_id, weight)
Adjacency = dict[str, list[tuple[str, float]]]


def build_graph(graph: SweepGraph, blocked: Optional[Iterable[str]] = None) -> Adjacency:
    blocked_set = set(blocked or ())
    pos = {s.id: s.position for s in graph.sweeps if s.id not in blocked_set}
    adj: Adjacency = {sid: [] for sid in pos}

    def add_edge(a: str, b: str) -> None:
        # skip if either endpoint is blocked/unknown, or edge already present
        if a not in pos or b not in pos:
            return
        w = leg_cost(distance(pos[a], pos[b]), False)
        if not any(n == b for n, _ in adj[a]):
            adj[a].append((b, w))

    for s in graph.sweeps:
        if s.id in blocked_set:
            continue
        for n in s.neighbors:
            add_edge(s.id, n)  # forward
            add_edge(n, s.id)  # reverse (SDK links may be one-way)
    return adj


def dijkstra(adj: Adjacency, source: str) -> tuple[dict[str, float], dict[str, str]]:
    """Shortest-path distances and predecessors from `source`. Unreachable nodes
    simply don't appear in the returned maps."""
    dist: dict[str, float] = {source: 0.0}
    prev: dict[str, str] = {}
    pq: list[tuple[float, str]] = [(0.0, source)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")):
            continue
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def shortest_path(prev: dict[str, str], source: str, target: str) -> Optional[list[str]]:
    """Rebuild the sweep list source->target from a predecessor map, or None if
    target was never reached."""
    if target == source:
        return [source]
    if target not in prev:
        return None
    path = [target]
    while path[-1] != source:
        path.append(prev[path[-1]])
    path.reverse()
    return path
