"""Route planner types — the contract between the Matterport loader, the task
generator (or hardcoded tasks), the planner, and the 3D view/grader.

v1 is METER-BASED: the order search minimizes meters and `est_seconds` stays
None. Speed/time become an additive layer in v2 (rescue carry + crawl), routed
through a single `leg_cost()` seam (see cost.py) so nothing else changes.

These dataclasses mirror the shared JSON shapes. The canonical sweep graph lives
in mock_unit.json (frontend reads the same file); `SweepGraph.from_dict` parses it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional
import json

# ---------------------------------------------------------------------------
# Input 1: Sweep graph (from the Matterport loader; snapshotted once per model)
# ---------------------------------------------------------------------------

RoomType = Literal[
    "kitchen", "living", "bedroom", "bathroom",
    "hallway", "foyer", "dining", "office", "other",
]
ExitType = Literal["door", "window"]


@dataclass
class Vec3:
    x: float
    y: float
    z: float  # meters, Matterport coords; y is up


@dataclass
class Sweep:
    id: str
    floor: int
    room: str            # room this sweep belongs to — the room<->sweep join
    position: Vec3
    neighbors: list[str]  # may be one-way in the SDK; planner adds the reverse edge

    @classmethod
    def from_dict(cls, d: dict) -> "Sweep":
        return cls(d["id"], d["floor"], d["room"], Vec3(**d["position"]), list(d["neighbors"]))


@dataclass
class Room:
    id: str
    type: RoomType
    label: str
    unitId: str
    floor: int


@dataclass
class Exit:
    id: str
    type: ExitType
    sweepId: str
    unitId: str
    # Windows only. Valid for a rescue unless this is False. None = unknown
    # (filled later from Vexcel + CoStar story count). Open decision: whether
    # None should count as usable for planning.
    ladderReachable: Optional[bool] = None


@dataclass
class SweepGraph:
    modelId: str
    sweeps: list[Sweep]
    rooms: list[Room]
    exits: list[Exit]

    @classmethod
    def from_dict(cls, d: dict) -> "SweepGraph":
        return cls(
            modelId=d["modelId"],
            sweeps=[Sweep.from_dict(s) for s in d["sweeps"]],
            rooms=[Room(**r) for r in d["rooms"]],
            exits=[Exit(**e) for e in d["exits"]],
        )

    @classmethod
    def load(cls, path: str) -> "SweepGraph":
        with open(path) as f:
            return cls.from_dict(json.load(f))


# ---------------------------------------------------------------------------
# Input 2: Task list (from the task generator OR hardcoded)
# The planner reads only the fields below; any extra keys (title, description,
# CoStar refs, points) are kept in `extra` and ignored by the planner.
# ---------------------------------------------------------------------------

TaskType = Literal["search", "rescue"]
_TASK_FIELDS = {"id", "type", "roomId", "prompt", "mustFollow"}


@dataclass
class Task:
    id: str
    type: TaskType
    roomId: str                       # target is a ROOM, never a sweep
    prompt: Optional[str] = None
    mustFollow: list[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)  # generator extras, ignored by planner

    @classmethod
    def from_dict(cls, d: dict) -> "Task":
        return cls(
            id=d["id"],
            type=d["type"],
            roomId=d["roomId"],
            prompt=d.get("prompt"),
            mustFollow=list(d.get("mustFollow", [])),
            extra={k: v for k, v in d.items() if k not in _TASK_FIELDS},
        )


@dataclass
class Scenario:
    timeOfDay: Optional[Literal["day", "night"]] = None
    blockedSweeps: list[str] = field(default_factory=list)
    blockedExits: list[str] = field(default_factory=list)
    smoke: bool = False  # v2: swaps walkSpeed -> crawlSpeed


@dataclass
class TaskList:
    drillId: str
    modelId: str
    unitId: str
    start_sweepId: str          # drop point — a precise point, so this one IS a sweep
    tasks: list[Task]
    scenario: Scenario = field(default_factory=Scenario)

    @classmethod
    def from_dict(cls, d: dict) -> "TaskList":
        sc = d.get("scenario", {})
        return cls(
            drillId=d["drillId"],
            modelId=d["modelId"],
            unitId=d["unitId"],
            start_sweepId=d["start"]["sweepId"],
            tasks=[Task.from_dict(t) for t in d["tasks"]],
            scenario=Scenario(
                timeOfDay=sc.get("timeOfDay"),
                blockedSweeps=list(sc.get("blockedSweeps", [])),
                blockedExits=list(sc.get("blockedExits", [])),
                smoke=sc.get("smoke", False),
            ),
        )


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

RescueRule = Literal["exitAfterRescue", "rescueLast"]


@dataclass
class Settings:
    walkSpeed: float = 1.0   # m/s — placeholders; unused in v1 (meter-based)
    crawlSpeed: float = 0.4
    carrySpeed: float = 0.3
    rescueRule: RescueRule = "exitAfterRescue"
    maxTasks: int = 8


DEFAULT_SETTINGS = Settings()


# ---------------------------------------------------------------------------
# Output: Route plan
# ---------------------------------------------------------------------------

@dataclass
class Leg:
    frm: str            # "start" | task_id | "exit:<exit_id>"
    to: str
    sweeps: list[str]   # the path the 3D view draws / "way out" hints use
    meters: float
    carrying: bool      # true on carry (victim) legs; v2 uses the slower speed


@dataclass
class RoutePlan:
    drillId: str
    feasible: bool
    order: list[str]              # task ids in execution order
    legs: list[Leg]
    exitId: Optional[str]
    totalMeters: float
    unreachable: list[str]        # task ids that can't be reached
    estSeconds: Optional[float] = None  # v1: None. v2: filled once speeds matter.


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------

@dataclass
class TrailPoint:
    sweepId: str
    t: float
    carrying: bool


@dataclass
class Grade:
    tasks_done: int
    tasks_total: int
    missed: list[str]
    efficiency_pct: float              # plan meters / trainee meters, capped at 100
    plan_order: list[str]
    trainee_order: list[str]
    extra_meters_by_diff: dict[str, float]
    # v2 (needs speeds):
    trainee_seconds: Optional[float] = None
    plan_seconds: Optional[float] = None
    air_budget_seconds: Optional[float] = None
    mayday: Optional[bool] = None
