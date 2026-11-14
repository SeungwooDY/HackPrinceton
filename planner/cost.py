"""The ONE place a leg's cost is defined.

Thread `leg_cost` through Dijkstra's edge weights and the branch-and-bound order
search so that adding speed/time in v2 is a one-function change — nothing else
in the planner should divide by a speed or know what "carrying" costs.

    v1 (now):   cost = meters                        # pure distance
    v2 (later): cost = meters / speed_for(carrying)  # uncomment below
"""

from __future__ import annotations

import math


def leg_cost(meters: float, carrying: bool = False, settings=None) -> float:
    # v1: meter-based. `carrying`/smoke are recorded on the leg but don't change
    # its cost yet.
    return meters

    # v2: swap the body to this (and pass settings + smoke through):
    # speed = settings.carrySpeed if carrying else settings.walkSpeed
    # return meters / speed


def distance(a, b) -> float:
    """3D straight-line distance between two positions (objects with x/y/z)."""
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
