// Local generated models are decoded with the Bundle's own THREE instance.
import { createObstacleMesh } from './obstacleModels.js';
export { createObstacleMesh } from './obstacleModels.js';

const modelCache = new Map();
export async function loadObstacleModelData(type) {
  if (!['barricade', 'cone', 'debris'].includes(type)) throw new Error('Unknown obstacle type.');
  if (!modelCache.has(type)) {
    const request = (async () => {
      const response = await fetch(`/models/${type}.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Obstacle model asset is unavailable.');
      const data = await response.json();
      if (!data.object || data.object.type !== 'Group') throw new Error('Obstacle model asset is invalid.');
      return data;
    })();
    modelCache.set(type, request);
    request.catch(() => modelCache.delete(type));
  }
  return modelCache.get(type);
}

export function setObstacleDiagnostic(root, enabled) {
  root.traverse(object => {
    if (!object.isMesh) return;
    object.renderOrder = enabled ? 100000 : 50;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      // Transparent pass is needed by Showcase's panorama compositor.
      material.transparent = true;
      material.userData.obstacleDepth ||= { test: material.depthTest, write: material.depthWrite };
      material.depthTest = enabled ? false : material.userData.obstacleDepth.test;
      material.depthWrite = enabled ? false : material.userData.obstacleDepth.write;
      material.needsUpdate = true;
    }
  });
}

export function disposeObstacleMesh(root) {
  const geometries = new Set(), materials = new Set();
  root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

export async function createObstacleScene(sdk, { loadModel = loadObstacleModelData } = {}) {
  if (!sdk.Scene?.register || !sdk.Scene?.createObjects) throw new Error('3D obstacles need the Bundle SDK. Run npm run setup:bundle, restart python3 serve.py, and reload.');
  const name = `training.obstacle.${crypto.randomUUID()}`;
  const entries = new Map();
  let disposed = false;
  let diagnostic = false;
  const registration = await sdk.Scene.register(name, () => ({
    // Bundle injects reserved objectRoot/collider slots after the factory returns.
    inputs: { id: '' }, outputs: {},
    onInit() {
      const entry = entries.get(this.inputs.id);
      if (!entry) return;
      try {
        const THREE = this.context.three;
        const root = entry.modelData ? new THREE.ObjectLoader().parse(entry.modelData) : createObstacleMesh(THREE, entry.spec.type);
        this.outputs.objectRoot = root;
        entry.root = root;
        if (entry.spec.position) {
          entry.node.position.set(entry.spec.position.x, entry.spec.position.y, entry.spec.position.z);
          entry.node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), entry.spec.yaw || 0);
        } else {
          const eye = this.context.camera.getWorldPosition(new THREE.Vector3());
          const forward = this.context.camera.getWorldDirection(new THREE.Vector3());
          forward.y = 0;
          if (forward.lengthSq() < .001) throw new Error('Look forward into the room before adding an obstacle.');
          forward.normalize();
          const y = Number.isFinite(entry.spec.floorY) ? entry.spec.floorY : eye.y - 1.5;
          entry.node.position.set(eye.x + forward.x * 1.5, y + .03, eye.z + forward.z * 1.5);
          entry.node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-forward.x, -forward.z));
          entry.spec.position = { x: entry.node.position.x, y: entry.node.position.y, z: entry.node.position.z };
          entry.spec.yaw = Math.atan2(-forward.x, -forward.z);
        }
        setObstacleDiagnostic(root, diagnostic);
      } catch (error) { entry.reject(error); }
    },
    onTick() {
      const entry = entries.get(this.inputs.id);
      if (entry?.root?.parent && !entry.attached) {
        entry.attached = true;
        entry.resolve({ ...entry.spec });
      }
    },
    onDestroy() { disposeObstacleMesh(this.outputs.objectRoot); this.outputs.objectRoot = null; },
  }));

  const remove = id => {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.reject(new Error('Obstacle placement cancelled.'));
    entry.object?.stop();
    entries.delete(id);
  };
  return {
    async add(spec) {
      if (disposed) throw new Error('Obstacle scene is closed.');
      const id = spec.id || crypto.randomUUID();
      if (entries.has(id)) throw new Error('This obstacle already exists.');
      // Read the reusable model before starting SDK components; fall back to the
      // same authoring geometry if a local asset cannot be fetched.
      const modelData = await loadModel(spec.type).catch(() => null);
      if (disposed) throw new Error('Obstacle scene is closed.');
      const [object] = await sdk.Scene.createObjects(1);
      if (disposed) { object.stop(); throw new Error('Obstacle scene is closed.'); }
      const node = object.addNode();
      const entry = { spec: { ...spec, id }, node, object, modelData };
      const attached = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      // addComponent/start can throw synchronously before we reach await attached.
      // Cleanup still rejects this promise; mark it handled on that failure path.
      attached.catch(() => {});
      entries.set(id, entry);
      entry.timer = setTimeout(() => entry.reject(new Error('The obstacle did not attach to the 3D scene. Try reloading the viewer.')), 5000);
      try {
        node.addComponent(name, { id });
        object.start();
        const result = await attached;
        clearTimeout(entry.timer);
        return result;
      } catch (error) { remove(id); throw error; }
    },
    remove,
    adjust(id, { yaw = 0, height = 0 }) {
      const entry = entries.get(id);
      if (!entry) return null;
      entry.spec.yaw = (entry.spec.yaw || 0) + yaw;
      entry.spec.position.y += height;
      entry.node.position.y = entry.spec.position.y;
      entry.node.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, entry.spec.yaw);
      return { ...entry.spec, position: { ...entry.spec.position } };
    },
    setDiagnostic(enabled) { diagnostic = enabled; entries.forEach(entry => { if (entry.root) setObstacleDiagnostic(entry.root, enabled); }); },
    dispose() { disposed = true; [...entries.keys()].forEach(remove); registration?.dispose?.(); },
  };
}
