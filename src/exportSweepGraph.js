// Browser-side sweep-graph exporter.
//
// The Matterport GraphQL Model API exposes rooms + locations but NOT neighbor
// adjacency, so the navigable graph must come from the Showcase SDK at runtime.
// `sdk.Sweep.data` gives each sweep's { sid, position, neighbors, floorInfo,
// roomInfo }. This dumps that into the same SweepGraph shape as
// planner/mock_unit.json, so planner/graph.py runs on a real model unchanged.
//
// Usage: load a model in the viewer, open the console, run:
//   await exportSweepGraph()            // downloads sweepgraph_<modelId>.json
//
// NOTE: neighbors are exported RAW. They can include sightline edges (sweeps
// visible across open space, >10 m) and cross-floor links that are NOT walkable.
// Filtering happens at graph-build time (planner/graph.py: max_edge_meters +
// same_floor). exits[] is left empty — the SDK has no door/window concept, so
// exits are hand-added (plus Vexcel/CoStar for window ladder reach).

function collectSweeps(sdk, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let sub;
    const timer = setTimeout(() => {
      try { sub?.cancel?.(); } catch {}
      reject(new Error("Sweep.data did not populate in time"));
    }, timeoutMs);
    sub = sdk.Sweep.data.subscribe({
      onCollectionUpdated(collection) {
        const items = Object.values(collection || {});
        if (items.length) {
          clearTimeout(timer);
          try { sub?.cancel?.(); } catch {}
          resolve(items);
        }
      },
    });
  });
}

export async function buildSweepGraph(sdk, modelId) {
  const raw = await collectSweeps(sdk);
  const sweeps = raw
    .filter((s) => s.enabled !== false && s.position)
    .map((s) => ({
      id: s.sid,
      floor: s.floorInfo?.sequence ?? 0,
      room: s.roomInfo?.id ?? "unknown",
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      neighbors: Array.isArray(s.neighbors) ? [...s.neighbors] : [],
    }));

  // Synthesize rooms[] from the distinct room ids present. Labels are unknown
  // from the SDK (match the quiz's "real-matterport-unlabeled") — hand-label or
  // merge from the GraphQL rooms{ id label } later.
  const floorOf = new Map(sweeps.map((s) => [s.room, s.floor]));
  const rooms = [...new Set(sweeps.map((s) => s.room))].map((id) => ({
    id,
    type: "other",
    label: "Unlabeled room",
    unitId: modelId || "unknown-model",
    floor: floorOf.get(id) ?? 0,
  }));

  const resolvedModelId =
    modelId || (await sdk.Model.getData().catch(() => ({})))?.sid || "unknown-model";

  return {
    modelId: resolvedModelId,
    _note:
      "Exported from Showcase SDK Sweep.data. neighbors are RAW — may include " +
      "sightline/cross-floor edges; filter at graph-build time. exits[] is empty: " +
      "add doors/windows by hand (SDK has no exit concept).",
    sweeps,
    rooms,
    exits: [],
  };
}

// Collect roomId -> label from the SDK's Room data. The exporter above leaves
// room labels as "Unlabeled room" because Sweep.data's roomInfo carries only an
// id; the human-readable label lives in Room.data (same source the viewer's
// "Current room" status bar uses). Rooms the model owner never named are
// skipped, so the map holds only real labels.
function collectRoomLabels(sdk, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!sdk.Room?.data?.subscribe) return resolve({});
    const labels = {};
    let sub;
    const done = () => { try { sub?.cancel?.(); } catch {} resolve(labels); };
    const timer = setTimeout(done, timeoutMs);
    sub = sdk.Room.data.subscribe({
      onCollectionUpdated(collection) {
        for (const room of Object.values(collection || {})) {
          const id = room?.id ?? room?.sid;
          const label = (room?.label ?? room?.name ?? "").trim();
          if (id && label) labels[id] = label;
        }
        if (Object.keys(labels).length) { clearTimeout(timer); done(); }
      },
    });
  });
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Attaches window.exportSweepGraph() for console use once a model is loaded.
export function installExporter() {
  const exporter = async (modelId) => {
    const sdk = window.mpSdk;
    if (!sdk) throw new Error("SDK not connected — load a model first.");
    const graph = await buildSweepGraph(sdk, modelId);
    downloadJSON(graph, `sweepgraph_${graph.modelId}.json`);
    const edges = graph.sweeps.reduce((n, s) => n + s.neighbors.length, 0);
    console.log(
      `Exported ${graph.sweeps.length} sweeps, ${graph.rooms.length} rooms, ` +
        `${edges} raw neighbor links. exits[] is empty — add doors/windows by hand.`,
    );
    return graph;
  };

  // window.exportRoomLabels() -> downloads roomlabels_<model>.json, a
  // { roomId: label } map for quiz_from_sweepgraph.py --labels. Feeds
  // room-type-matched scenarios (and "Checkpoint N -- <room>" markers).
  const roomExporter = async (modelId) => {
    const sdk = window.mpSdk;
    if (!sdk) throw new Error("SDK not connected — load a model first.");
    const labels = await collectRoomLabels(sdk);
    const id = modelId || (await sdk.Model.getData().catch(() => ({})))?.sid || "unknown-model";
    downloadJSON(labels, `roomlabels_${id}.json`);
    console.log(`Exported ${Object.keys(labels).length} room label(s).`, labels);
    return labels;
  };
  window.exportSweepGraph = exporter;
  window.exportRoomLabels = roomExporter;
  return () => {
    if (window.exportSweepGraph === exporter) delete window.exportSweepGraph;
    if (window.exportRoomLabels === roomExporter) delete window.exportRoomLabels;
  };
}
