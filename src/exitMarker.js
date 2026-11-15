// On-screen exit marker. Matterport scans have no door/window concept, so exits
// must be designated by hand. This adds a small panel: walk to a door/window in
// the viewer, click a button, and the CURRENT sweep is recorded as an exit. Then
// download the full SweepGraph (from exportSweepGraph) with exits[] populated.
//
// Installed from main.jsx via installExitMarker(). Waits for window.mpSdk.

import { buildSweepGraph, downloadJSON } from "./exportSweepGraph.js";

function currentModelId() {
  const m = new URLSearchParams(window.location.search).get("model");
  return m || undefined;
}

export function installExitMarker() {
  const exits = []; // { id, type, sweepId, ladderReachable? }
  let currentSweep = null;
  let unsub = null;

  // --- panel UI ---
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;left:12px;top:55vh;z-index:9999;background:#111;color:#eee;" +
    "font:12px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:260px;";
  panel.innerHTML = `
    <div data-drag style="font-weight:600;margin-bottom:6px;cursor:move;user-select:none">⠿ Exit marker</div>
    <div data-cur style="opacity:.8;margin-bottom:8px">waiting for SDK…</div>
    <div style="display:flex;gap:6px;margin-bottom:4px">
      <button data-door style="flex:1">+ Exit door</button>
      <button data-window style="flex:1">+ Exit window</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button data-interior style="flex:1">+ Interior door (not an exit)</button>
    </div>
    <ul data-list style="list-style:none;margin:0 0 8px;padding:0;max-height:120px;overflow:auto"></ul>
    <button data-export style="width:100%">Download graph + exits</button>`;
  document.body.appendChild(panel);

  // Draggable via the header. A transparent overlay captures the mouse while
  // dragging so it keeps working even when the pointer passes over the Matterport
  // iframe (which would otherwise swallow the move/up events).
  panel.querySelector("[data-drag]").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const ox = e.clientX - panel.offsetLeft;
    const oy = e.clientY - panel.offsetTop;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9998;cursor:move;";
    document.body.appendChild(overlay);
    const move = (ev) => {
      panel.style.left = `${ev.clientX - ox}px`;
      panel.style.top = `${ev.clientY - oy}px`;
      panel.style.bottom = "auto";
    };
    const up = () => {
      overlay.remove();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  const curEl = panel.querySelector("[data-cur]");
  const listEl = panel.querySelector("[data-list]");

  function render() {
    curEl.textContent = currentSweep
      ? `current sweep: ${currentSweep.slice(0, 10)}…`
      : "move to a sweep…";
    listEl.innerHTML = exits
      .map(
        (e, i) =>
          `<li style="display:flex;justify-content:space-between;gap:6px">
             <span>${e.type}: ${e.sweepId.slice(0, 8)}…</span>
             <a href="#" data-del="${i}" style="color:#f88">✕</a>
           </li>`,
      )
      .join("");
  }

  function addExit(type) {
    if (!currentSweep) return alert("No current sweep yet — click a spot in the model first.");
    if (exits.some((e) => e.sweepId === currentSweep && e.type === type)) return;
    exits.push({
      id: `${type}-${exits.length + 1}`,
      type,
      sweepId: currentSweep,
      ...(type === "window" ? { ladderReachable: null } : {}),
    });
    render();
  }

  panel.querySelector("[data-door]").onclick = () => addExit("door");
  panel.querySelector("[data-window]").onclick = () => addExit("window");
  // Interior doors are recorded but are NOT building exits: the planner ignores
  // them for egress and the drill does not complete when you reach one. Only
  // exterior doors / egress windows count as exits.
  panel.querySelector("[data-interior]").onclick = () => addExit("interior-door");
  listEl.onclick = (ev) => {
    const i = ev.target?.dataset?.del;
    if (i != null) {
      ev.preventDefault();
      exits.splice(Number(i), 1);
      render();
    }
  };
  panel.querySelector("[data-export]").onclick = async () => {
    const sdk = window.mpSdk;
    if (!sdk) return alert("SDK not connected yet.");
    const graph = await buildSweepGraph(sdk, currentModelId());
    graph.exits = exits.map((e) => ({ ...e, unitId: graph.modelId }));
    downloadJSON(graph, `sweepgraph_${graph.modelId}.json`);
  };

  // --- hook SDK current-sweep once connected ---
  const poll = setInterval(() => {
    const sdk = window.mpSdk;
    if (!sdk || unsub) return;
    clearInterval(poll);
    unsub = sdk.Sweep.current.subscribe((c) => {
      currentSweep = c?.sid || null;
      render();
    });
  }, 500);

  render();
}
