#!/usr/bin/env python3
"""Deterministic, zero-LLM quiz scenarios for real Matterport rooms.

No network call, no LLM: each real room (from generate_floor_tasks'
real_location_pool) gets one scenario deterministically picked from a
hand-written bank, keyed by room-type category and seeded by the room's
own id (same room always gets the same scenario -- reproducible).

This content is training-scenario flavor text, not a CoStar/Matterport
fact -- it is never meant to be mistaken for real victim/hazard data. The
"who/what takes priority" answers encode one triage convention (assist the
least-mobile occupant first) -- that's an editorial default, not a
validated firefighting rule; it's a stand-in for the same open question
already flagged in README.md ("Rescue rule ... ideally confirmed with a
firefighter"). Swap ANSWERS if your team confirms a different convention.

Usage:
    python3 quiz_scenarios.py --property-id 27120
"""
import argparse
import json
import os
import random

from generate_floor_tasks import load_env, real_location_pool

OUT = os.path.join(os.path.dirname(__file__), "out")
SCENARIO_SOURCE = "deterministic-template-bank"
PRIORITY_RULE_SOURCE = "editorial-default:assist-least-mobile-occupant-first (unconfirmed with a firefighter -- see README open question)"

# Raw Matterport tags/labels -> bank category key.
CATEGORY_ALIASES = {
    "kitchen": "kitchen",
    "bedroom": "bedroom",
    "bathroom": "bathroom",
    "office": "office",
    "open floor": "office",
    "conference room": "office",
    "lobby": "lobby",
    "corridor": "hallway",
    "hallway": "hallway",
    "living": "living",
    "dining": "living",
    "closet": "closet",
    "laundry": "utility",
    "utility": "utility",
    "breakroom": "utility",
    "staircase": "hallway",
    "basement": "basement",
    "garage": "garage",
    "warehouse": "warehouse",
}

RANKS = ("best", "second_best", "second_worst", "worst")


def _ranked(scenario, question, options, rationale):
    """options: 4 strings, already ordered best -> worst."""
    return {
        "scenario": scenario, "question": question,
        "options": [{"rank": r, "text": t} for r, t in zip(RANKS, options)],
        "rationale": rationale,
    }


SCENARIO_BANK = {
    "kitchen": [
        _ranked("You smell gas. The stove's knobs are all turned to the 'on' position but no burners are lit.",
                "Rank these actions best to worst.",
                ["Shut off the gas supply and ventilate before any ignition source enters.",
                 "Ventilate the room first, then shut off the gas.",
                 "Leave the room and continue the search, planning to report the gas smell later.",
                 "Flip the light switch to see the knobs better."],
                "Unburned gas plus an ignition source (switch, pilot, spark) risks an explosion; cut the fuel source first, before or alongside ventilating. Delaying it, or worse, introducing a spark, is progressively more dangerous."),
        _ranked("A pot on the stove has caught fire. There's a fire extinguisher on the wall and a bag of flour on the counter.",
                "Rank these actions best to worst.",
                ["Smother it with a lid or use the extinguisher.",
                 "Use the extinguisher from across the room without closing in.",
                 "Try to carry the pot to the sink.",
                 "Throw water on it."],
                "Smothering/extinguishing in place is safest; moving a burning pot risks spreading fire or burns; water on a grease fire causes violent flare-up and is the clearly worst option."),
        _ranked("The kitchen is clear of fire, but smoke-stained dishes suggest someone was cooking recently.",
                "Rank these actions best to worst.",
                ["Continue searching the unit -- a recently-occupied kitchen means someone may still be nearby.",
                 "Note it and search the kitchen again on the way out.",
                 "Mark the kitchen cleared and move to the next room.",
                 "Mark the entire unit cleared based on this room alone."],
                "Evidence of recent occupancy raises the odds of a victim elsewhere; treating one clear room as proof the whole unit is clear is the most dangerous assumption."),
    ],
    "bedroom": [
        _ranked("You find a child and a grandmother sharing this bedroom. Both are conscious; the grandmother cannot stand without help.",
                "Who do you assist out, in priority order?",
                ["Grandmother first, then guide the child out right behind her.",
                 "Child first, then come back for the grandmother.",
                 "Try to carry both at once.",
                 "Tell both to wait while you search the rest of the room."],
                PRIORITY_RULE_SOURCE + " -- the child can self-evacuate with verbal guidance; the grandmother cannot move without physical assistance, so she needs you first. Leaving either behind to search further is worst."),
        _ranked("The bedroom door is hot to the touch. You hear no response to your verbal announcement.",
                "Rank these actions best to worst.",
                ["Check for flashover signs (smoke color, pressure) before any entry.",
                 "Open the door slowly while staying low and ready to retreat.",
                 "Force the door open quickly to search faster.",
                 "Break a window from inside the hot room first."],
                "A hot door with no response is a classic flashover warning; forcing entry fast is the clearly worst move since sudden oxygen can feed a ready-to-ignite room."),
        _ranked("An unconscious adult is on the floor between the bed and the window, closer to the window.",
                "Rank these actions best to worst.",
                ["Remove via the nearest viable exit (the window).",
                 "Drag them back out through your entry route.",
                 "Wait for a second crew member before moving them.",
                 "Search the rest of the room before moving the victim."],
                "Shortest path to safety for an unconscious victim wins; delaying removal to search further is worst."),
    ],
    "bathroom": [
        _ranked("The bathroom door is locked from the inside. You hear coughing.",
                "Rank these actions best to worst.",
                ["Force entry immediately -- an audible occupant is an active rescue.",
                 "Knock and wait for a response before forcing entry.",
                 "Look for a key elsewhere in the unit first.",
                 "Move on and note it as 'occupied, locked' for later."],
                "Coughing means a live, distressed occupant; moving on without acting is the worst option by far."),
        _ranked("The bathroom is empty but the shower is running and the mirror is fogged.",
                "Rank these actions best to worst.",
                ["Shut off the water and widen the search to nearby rooms.",
                 "Shut off the water and mark the room cleared.",
                 "Leave the water running and move on.",
                 "Mark the whole unit cleared since this room is empty."],
                "A running, fogged shower means someone was here minutes ago -- widen the search rather than treating the unit as clear."),
    ],
    "office": [
        _ranked("Several desks have monitors still on and chairs pulled out, but the room is empty.",
                "Rank these actions best to worst.",
                ["Treat as recently occupied; check adjoining rooms before clearing the area.",
                 "Note it, then clear this room and continue the pattern search.",
                 "Clear the room without comment.",
                 "Assume everyone already evacuated based on the empty room."],
                "Powered equipment and disturbed furniture suggest occupants left in a hurry and may be nearby; assuming full evacuation from one empty room is the worst read."),
        _ranked("A server rack in the corner is sparking intermittently.",
                "Rank these actions best to worst.",
                ["De-energize the circuit, then flag as an electrical hazard.",
                 "Flag the hazard and avoid the area without de-energizing.",
                 "Apply water-based suppression directly to the sparking rack.",
                 "Ignore it and continue the primary search through that corner."],
                "Cutting power is the correct first step for an electrical fire; water on a live circuit is the clearly worst option (electrocution risk)."),
    ],
    "lobby": [
        _ranked("The lobby is the main path between two stairwells and is filling with light smoke.",
                "Rank these actions best to worst.",
                ["Prioritize clearing/holding this space -- it's the primary egress route.",
                 "Ventilate it when convenient, after other rooms.",
                 "Treat it the same priority as any other room on the floor.",
                 "Ignore it since no fire is visible here."],
                "A lobby on the egress path outranks an equivalent side room; losing it to smoke blocks evacuation for everyone behind it."),
        _ranked("A receptionist's desk has a phone off the hook and a half-finished drink.",
                "Rank these actions best to worst.",
                ["Treat as recently occupied; the receptionist may be deeper in the building.",
                 "Note it and continue the planned search pattern.",
                 "Assume the receptionist already left through the front door.",
                 "Disregard the desk entirely as irrelevant."],
                "Signs of a hastily-abandoned post suggest the occupant went further in rather than out; assuming they safely left is the riskiest read."),
    ],
    "hallway": [
        _ranked("This corridor connects four rooms and is the only path to the stairwell from this side of the floor.",
                "Rank these actions best to worst.",
                ["Keep this hallway clear and ventilated before focusing on side rooms.",
                 "Search a side room first, then return to the hallway.",
                 "Treat it as equal priority to any single room.",
                 "Let smoke bank here while fully clearing one room first."],
                "A blocked single-path corridor traps every room behind it; protecting it outranks searching any one adjoining room first."),
        _ranked("Smoke is banking down the hallway ceiling but visibility at floor level is still clear.",
                "Rank these actions best to worst.",
                ["Stay low and continue moving toward the search objective.",
                 "Pause briefly to reassess, then continue low.",
                 "Retreat fully and wait for conditions to improve.",
                 "Stand upright to move faster through the hallway."],
                "Banking smoke with clear floor-level visibility is still passable low; standing upright into the smoke layer is the worst choice."),
    ],
    "living": [
        _ranked("A couch cushion is smoldering, and a dog is barking from an adjacent room.",
                "Rank these actions best to worst.",
                ["Knock down the smoldering cushion, then follow the barking.",
                 "Follow the barking first, deal with the cushion after.",
                 "Deal with the cushion only, ignore the barking.",
                 "Ignore both and continue the planned route."],
                "Suppressing the active fire source protects your exit path; the barking is a strong lead to a live occupant and shouldn't be ignored either."),
        _ranked("The room is clear, but a baby monitor on the shelf is powered on and transmitting static.",
                "Rank these actions best to worst.",
                ["Treat it as evidence of an infant nearby and prioritize nearby bedrooms.",
                 "Note it and continue the standard search order.",
                 "Mark the room cleared and move on.",
                 "Disregard it as an irrelevant object."],
                "A powered baby monitor strongly implies a child is present somewhere nearby; disregarding it is the worst read of the evidence."),
    ],
    "closet": [
        _ranked("The closet door is slightly ajar and you notice small shoes just inside.",
                "Rank these actions best to worst.",
                ["Check inside -- children sometimes hide in closets during a fire.",
                 "Glance in from the doorway without physically checking.",
                 "Note the shoes and move on.",
                 "Skip the closet entirely since it's a small space."],
                "Closets are a common hiding spot for frightened children; a quick but thorough check is low-cost and high-value, skipping it entirely is worst."),
    ],
    "utility": [
        _ranked("You find the gas meter here with the shutoff valve partially obstructed by stored boxes.",
                "Rank these actions best to worst.",
                ["Clear access and shut off the gas supply.",
                 "Shut off the gas without fully clearing access, if reachable.",
                 "Report the obstruction and move on without acting.",
                 "Leave it for another crew without flagging it."],
                "An obstructed utility shutoff delays a critical life-safety action for the whole unit; leaving it unflagged is worst."),
    ],
    "basement": [
        _ranked("Visibility is near zero and you can hear the HVAC system still running.",
                "Rank these actions best to worst.",
                ["Confirm your egress route before proceeding further in.",
                 "Proceed slowly while periodically checking your route back.",
                 "Proceed quickly to cover more ground.",
                 "Proceed without tracking the way back out."],
                "Limited-egress, low-visibility spaces are high-risk for disorientation; moving fast without tracking your exit is the worst approach."),
    ],
    "garage": [
        _ranked("A vehicle's engine compartment is smoking, and fuel odor is present.",
                "Rank these actions best to worst.",
                ["Maintain distance, ventilate, and flag as a fuel-fire hazard.",
                 "Approach cautiously to assess further before deciding.",
                 "Approach and attempt to open the hood immediately.",
                 "Ignore the smell and continue the search routine."],
                "A smoking engine with fuel odor is a hazard-containment task; closing distance to open the hood immediately risks a flare-up."),
    ],
    "warehouse": [
        _ranked("High-piled storage racks are visible, and smoke is lightly banking near the ceiling, far from any visible fire.",
                "Rank these actions best to worst.",
                ["Treat high-piled storage as a collapse/hidden-fire hazard and avoid working underneath.",
                 "Work near the racks cautiously, watching the ceiling.",
                 "Work directly underneath the racks since no fire is visible.",
                 "Assume the area is safe since there is no visible fire anywhere."],
                "High-piled storage can hide fire spread and risks rack collapse; assuming safety from a lack of visible fire is the worst read."),
    ],
    "generic": [
        _ranked("The room is clear of visible fire but has moderate smoke and reduced visibility.",
                "Rank these actions best to worst.",
                ["Complete a hands-on primary search before moving to the next room.",
                 "Do a quick visual scan from the doorway, then move on.",
                 "Glance in briefly and mark it cleared.",
                 "Skip the room entirely based on the doorway view."],
                "Reduced visibility still needs a hands-on primary search; skipping a room from a doorway glance is the worst option."),
    ],
}

TASK_TYPE_PRIORITY = {"Rescue": 1, "Hazard": 2, "Evacuation": 3, "Search": 4, "Recon": 5, "Utility": 6, "Ventilation": 7}


def category_for_label(label):
    # Multi-tag rooms (real-matterport-tags) come as a joined string, e.g.
    # "Office, Kitchen, Living, Dining" -- match on the first recognized part.
    for part in (label or "").split(","):
        key = part.strip().lower()
        if key in CATEGORY_ALIASES:
            return CATEGORY_ALIASES[key]
    return "generic"


def pick_scenario(room_id, room_label):
    """Deterministic: the same room_id always picks the same scenario."""
    category = category_for_label(room_label)
    bank = SCENARIO_BANK.get(category) or SCENARIO_BANK["generic"]
    scenario = bank[random.Random(room_id).randrange(len(bank))]
    return category, scenario


def highest_priority_task(tasks):
    """Deterministic ranking over an existing floor's generated tasks -- no LLM judging."""
    if not tasks:
        return None
    return min(tasks, key=lambda t: TASK_TYPE_PRIORITY.get(t["type"], 99))


def build_quiz(property_id, mp_key, mp_secret):
    pool = real_location_pool(property_id, mp_key, mp_secret)
    items = []
    for room_id, meta in pool.items():
        category, scenario = pick_scenario(room_id, meta["label"])
        items.append({
            "roomId": room_id,
            "roomLabel": meta["label"],
            "roomLabelSource": meta["labelSource"],
            "matterportModelId": meta["modelId"],
            "sweepId": meta["sweepIds"][0] if meta["sweepIds"] else None,
            "quizCategory": category,
            "scenario": scenario["scenario"],
            "question": scenario["question"],
            "options": scenario["options"],
            "rationale": scenario["rationale"],
            "scenarioSource": SCENARIO_SOURCE,
        })
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--property-id", type=int, required=True)
    args = ap.parse_args()

    env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
    mp_key = env.get("MATTERPORT_API_KEY") or os.environ.get("MATTERPORT_API_KEY")
    mp_secret = env.get("MATTERPORT_API_TOKEN") or os.environ.get("MATTERPORT_API_TOKEN")

    items = build_quiz(args.property_id, mp_key, mp_secret)
    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, f"quiz_{args.property_id}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"propertyId": args.property_id, "quizItems": items}, f, indent=2)
    print(f"Wrote {len(items)} quiz item(s) to {out_path}")
    for it in items:
        print(f"  [{it['quizCategory']:8}] {it['roomLabel']:12} {it['question']}")


if __name__ == "__main__":
    main()
