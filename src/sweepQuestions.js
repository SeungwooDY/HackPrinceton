export function sweepIds(sweep) {
  // An empty sid means transitioning, dollhouse/floorplan mode, or no active panorama.
  if (!sweep?.sid) return [];
  return [...new Set([sweep.id, sweep.sid, sweep.uuid].filter(id => typeof id === 'string' && id))].sort();
}

export function questionsAtSweep(tasks, modelId, ids) {
  const active = new Set(ids);
  if (!active.size) return [];
  return tasks.filter(task => task.importedTask?.modelId === modelId && active.has(task.importedTask.sweepId));
}
