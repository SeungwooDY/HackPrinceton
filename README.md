# CLAUDE.md — Pre-Incident Plan Agent

Context and rules for Claude when working in this repo. Read this before making changes.

## What we're building

Type an address and get a fire-department **pre-incident plan** in about 60 seconds. The plan comes with:
- a **3D walkthrough** (Matterport) with evacuation routes drawn in
- **apartment task drills**: room-by-room search and rescue exercises, where a trainee's path is scored against the optimal one

Hackathon: HackPrinceton, **CoStar "Inside and Out: AI for the Built World"** track plus the Education track. CoStar's judging weights are data use 30%, agentic depth 30%, usefulness 25%, demo 15%. Choices that strengthen the demo on one hero building beat breadth.

## Rules that must not be broken

1. **Facts are deterministic.** Hazard flags, occupant counts, distances and routes come from code (the rules engine and graph algorithms), never from the LLM. The LLM orders, explains, plans and writes. It never invents a number.
2. **Every fact carries its source.** Each value in the plan JSON keeps the field it came from (for example `hasSprinklers`, `spaces[].propertyFloorId`). The UI shows this as a chip. Don't drop source tags when transforming data.
3. **Unknown means worst case.** If a field is missing, the plan says "unknown," and the rules engine assumes the dangerous value (unsprinklered, lightweight wood frame). Never fill gaps with guesses.
4. **The plan JSON is the single source of truth.** The one-page view, the PDF, the 3D view and the drills all read from it. Don't let any of them recompute facts on their own.
5. **The LLM output is validated.** Generated tasks must reference room IDs that exist in the unit's graph. Reject or regenerate anything else.
6. **Never commit secrets.** API keys live only in `.env`, which is in `.gitignore`. Don't hard-code keys, log them, or paste them into docs.

## Data layers

| Layer | Gives us | Lookup key |
|---|---|---|
| **CoStar** | Who's inside, on which floor, how many, what they do; construction, height, sprinklers, elevators, below-grade levels, attachments | `propertyId` |
| **Matterport** | Interior 3D model; sweeps as a walkable graph; rooms, stairwells, exits | `MatterportModelId` from `commercial-properties.csv` |
| **Vexcel** | Roof, footprint, streets, staging space, hydrant candidates | `primaryAddress` lat/lon |

The demo depends on CoStar: toggling it off should collapse the plan to a generic floor plan.

## Architecture

```
address
  ├─► CoStar ─► building profile + occupants by floor ─► rules engine ─► hazard flags
  ├─► Matterport ─► sweep graph ─► exits, stairwells, rooms
  │                    ├─► per-floor evacuation routes
  │                    └─► per-apartment task routes
  └─► Vexcel ─► roof, footprint, staging, hydrants
                         ▼
          Agent (LLM + tools): ranks, explains, plans, writes
                         ▼
        Plan JSON ─► one-page view + PDF │ 3D walkthrough │ drills
```

### Agent tools

| Tool | Returns |
|---|---|
| `get_building_profile(propertyId)` | Construction, stories, sprinklers, elevators, floors, year built, each tagged with its source field |
| `get_occupants_by_floor(propertyId)` | Tenants per floor with industry and headcount; unit counts for apartments |
| `flag_hazards(propertyId)` | Rules-engine output: hazard, severity, floor, why, source field |
| `get_plan_images(propertyId)` | Floor plan, site plan and aerial URLs from CoStar attachments |
| `get_matterport(modelId)` | Floors, sweep graph, rooms, tagged exits and stairwells |
| `get_site_imagery(lat, lon)` | Vexcel roof geometry, footprint, surrounding imagery |
| `route(from, to)` | Shortest path on the sweep graph |
| `plan_task_route(unitId, tasks[])` | Optimal task order and path for one apartment |

Tools return structured data. Keep them pure and testable without the LLM.

### LLM usage

- Put a thin wrapper around every model call, so models can be swapped with one config change.
- **Task generation:** a small, fast model (currently Ling-3.2-flash). Code picks the rooms; the model writes the scenario text and returns JSON that matches a schema.
- **Main agent:** a model that's reliable at calling tools over many steps. Test it on the hero building early.
- Cache the plan for the hero building so the live demo never waits on an API call.

## CoStar field mapping (rules engine input)

Field fill rates aren't verified yet; the hero-building script measures them.

| Question | CoStar source | Rule / use |
|---|---|---|
| People and where | `location-occupancy.spaces[].propertyFloorId` + `company-detail.numEmployees` | Daytime load per floor; search priority, crew count |
| Can't self-evacuate | `profile.industryType` ∈ `HealthCareAndSocialAssistance`, `EducationalServices` | Assisted-evacuation flag with floor |
| Special hazards | `industryType` ∈ `AccommodationAndFoodServices`, `Manufacturing`, `Wholesaler`, `Utilities`; `locationBio` | Commercial kitchen, hazmat, high-piled storage |
| Burn and collapse | `buildingConstructionMaterial` + year from `constructionEvents` | Wood truss means early collapse; pre-1980 means possible asbestos |
| High-rise | `numStoriesAboveGrade`, `buildingHeightInFeet` | Over 75 ft triggers high-rise ops |
| Suppression | `hasSprinklers`, `sprinklerType` (Wet, Dry, ESFR) | Changes attack plan; dry systems in unheated areas |
| Vertical access | `structural.elevators[]` (Passenger, Freight) | Freight elevator for equipment; recall check |
| Below grade | `floors[].floorName` (Basement, ParkingLevelOne–Ten, Mezzanine) | Smoke-logged, low clearance, EV fires |
| Entry points | `propertyIndustrial` bays and docks; `frontage[].numCurbCuts` | Forcible entry; apparatus access |
| Vacancy/construction | `constructionStatus`, `renovations[]`, ended tenancies (`toDate`) | Higher fire risk |
| Plans/imagery | `attachments[]` (FloorPlan, SitePlan, PlatMap, Aerial, UavVideo, MatterportAerialPlusInteriorXray) | Seeds floor and site plans |
| Residents | `propertyApartment` unit counts and floor plans | Overnight load; 2,765 of 3,339 properties are apartments |

## Plan output (NFPA 1620 / 1660 section order)

1. Building summary: address, occupancy type, construction, stories, year, sprinklers
2. Occupants: load per floor (day and night), assisted evacuation
3. Hazards: ranked flags with floor and source chip
4. Access: approach, apparatus staging, roof access, entry points
5. Water supply: nearest hydrants, FDC location
6. Interior: stairwells, elevators, exits per floor, primary and secondary routes
7. Tactical notes: recommendations for first-arriving units

Keep this section order in the JSON schema and in every rendered view.

## Routing

- **Graph:** sweeps are nodes (position, floor index, room); neighbor links are edges weighted by Euclidean distance.
- **Key nodes:** stairwells, exits, FDC, elevators and hazards are tagged manually (about 10 minutes per demo building). Rooms come from Matterport room labels where available.
- **Evacuation:** per floor, Dijkstra from every sweep to its nearest exit, plus a secondary route to the next-nearest exit that avoids the hazard.
- **2D floor plan:** project sweeps per floor to x/y and overlay routes and tags. Show the CoStar FloorPlan alongside if one exists.
- **Hazard pins:** one per CoStar hazard on its floor. If the suite can't be placed precisely, pin at floor level and label it that way.

## Apartment task drills

**Task types**
- **Rescue:** reach the room, then bring the victim to an exit.
- **Search:** reach the room's sweeps.

**Optimal route algorithm**
1. Key nodes: unit entry, one target node per task room, all reachable exits.
2. All-pairs distances between key nodes (Dijkstra on the sweep graph).
3. Exact ordering: brute-force permutations for small lists, Held–Karp for up to about 8 tasks.
4. Rescue constraint, set in config: either `exit_after_rescue` (go to an exit before continuing) or `rescue_last`.
5. Output: ordered tasks, full path, total distance, estimated time at walking and crawling speeds.

**Scoring the trainee:** tasks completed, path length ÷ optimal (1.0 = perfect), order differences and their cost in distance, time against the optimal time. Show both paths overlaid in 3D and 2D, and link each missed task back to its plan section. A rerun generates a new task list.

## Vexcel

- **Roof:** geometry and height drive ladder placement and roof access; roof type (flat or pitched) affects ventilation.
- **Staging:** footprint and street imagery give aerial and engine positions, cross-checked against `numCurbCuts` and frontage.
- **Hydrants:** prefer city open data (Houston, LA). Otherwise mark from imagery with a human confirming each one, labeled **"unverified."**
- **Output:** a top-down site plan with building outline, staging zones, hydrants and entry points.

## Setup

`.env` in the repo root (never committed):

```
MATTERPORT_API_KEY=
MATTERPORT_API_TOKEN=
MATTER_PORT_SDK_KEY=
VEXCEL_API_KEY=
```

Keys come from `/costar-keys` in the hackathon Discord. The data is only available for the duration of the hackathon.

Matterport's **dollhouse** button loads Vexcel imagery around the selected
building, initially 200 meters across. Zoom controls range from 200 to 1,600
meters. The **Interior view** control in the bottom-left corner of the aerial
image returns to the scan. Floorplan mode remains available in Matterport.
Coordinates come from the model's property in `commercial-properties.csv` and
`data/commercial-property.jsonl`, or the listing address linked by `ListingId` in
`residential-listings.csv` and `data/residential-listings.jsonl` under the local
CoStar kit. Missing coordinates,
coverage, or credentials display an error with a retry option.

Run `python3 serve.py` alongside `npm run dev` (or run `npm run build` and serve
the build with `python3 serve.py`). The Python server proxies Vexcel requests;
`VEXCEL_API_KEY` stays on the server. Images are cached in memory until restart.
The integration uses Vexcel's [ortho extract API](https://api.vexcelgroup.com/v2/api-docs),
with meter-based extents and attribution enabled. Run backend checks with
`python3 -m unittest discover -s tests`.

## Open questions (don't assume answers; ask or check)

- **Matterport access:** which SDK and API calls the access zip allows (sweep graph, room labels, Mattertags).
- **Apartment coverage:** do residential scans cover individual units, or only common areas and model units? Drills need room-level scans.
- **Rescue rule:** `exit_after_rescue` or `rescue_last`? Ideally confirmed with a firefighter.
- **Vexcel products:** which are available (ortho, oblique, elevation, footprints).
- **Field fill rates:** for the hero buildings.
- **Hydrant data:** whether Houston or LA publishes open hydrant locations.
