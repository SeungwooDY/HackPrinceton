import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createObstacleMesh, createObstacleScene, disposeObstacleMesh, setObstacleDiagnostic } from './obstacleScene.js';

// Exercise the actual pinned Bundle's THREE, not a second renderer instance.
let THREE;
try { THREE = await import('../public/bundle/vendors/three/0.184.0/three.module.min.js'); } catch { /* npm run setup:bundle enables geometry tests. */ }

function fixtureSdk({ failAdd = false } = {}) {
  const registrations = new Map();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1.5, .01, 100);
  camera.position.set(2, 1.6, 5);
  camera.lookAt(2, 1.6, 0);
  camera.updateMatrixWorld();
  const objects = [];
  return { scene, camera, objects, Scene: {
    async register(name, factory) { registrations.set(name, factory); return { dispose() { registrations.delete(name); } }; },
    async createObjects() {
      const group = new THREE.Group();
      scene.add(group);
      let component;
      const node = {
        position: group.position, quaternion: group.quaternion,
        addComponent(name, inputs) {
          if (failAdd) throw new Error('SDK component setup failed');
          component = registrations.get(name)();
          // Match SceneComponentFactory.setupOutputs in the pinned SDK.
          // The SDK owns these slots; component factories must not predeclare them.
          for (const reserved of ['objectRoot', 'collider']) {
            if (Object.hasOwn(component.outputs || {}, reserved)) throw new Error(`outputs.${reserved} is a reserved property of the outputs object`);
          }
          component.outputs = { ...component.outputs, objectRoot: null, collider: null };
          component.inputs = { ...component.inputs, ...inputs };
          component.context = { three: THREE, camera, scene };
          return component;
        },
      };
      const object = {
        addNode() { return node; },
        start() { component.onInit(); if (component.outputs.objectRoot) group.add(component.outputs.objectRoot); component.onTick(); },
        stop() { component?.onDestroy(); scene.remove(group); },
        tick() { component?.onTick(); },
        get root() { return component?.outputs.objectRoot; },
        group,
      };
      objects.push(object);
      return [object];
    },
  } };
}

test('unsupported Embed SDK fails explicitly instead of reporting a rendered prop', async () => {
  await assert.rejects(createObstacleScene({}), /Bundle SDK/);
});

test('all procedural obstacle types have nonempty geometry and dispose GPU resources', { skip: !THREE && 'Run npm run setup:bundle' }, () => {
  for (const type of ['barricade', 'cone', 'debris']) {
    const root = createObstacleMesh(THREE, type);
    const bounds = new THREE.Box3().setFromObject(root);
    assert.ok(bounds.max.y > .4);
    assert.ok(bounds.min.y >= -.02);
    let meshes = 0, disposed = 0;
    root.traverse(object => { if (object.isMesh) { meshes++; object.geometry.addEventListener('dispose', () => disposed++); } });
    assert.ok(meshes >= 4);
    setObstacleDiagnostic(root, true);
    root.traverse(object => { if (object.isMesh) { assert.equal(object.material.depthTest, false); assert.equal(object.renderOrder, 100000); } });
    setObstacleDiagnostic(root, false);
    root.traverse(object => { if (object.isMesh) { assert.equal(object.material.depthTest, true); assert.equal(object.material.transparent, true); } });
    disposeObstacleMesh(root);
    assert.equal(disposed, meshes);
  }
});

test('camera-relative placement produces a fixed world obstacle in the camera frustum', { skip: !THREE && 'Run npm run setup:bundle' }, async () => {
  const sdk = fixtureSdk();
  const controller = await createObstacleScene(sdk);
  const item = await controller.add({ id: 'barrier-1', type: 'barricade', floorY: 0 });
  assert.deepEqual(item.position, { x: 2, y: .03, z: 3.5 });
  sdk.scene.updateMatrixWorld(true);
  const projection = new THREE.Matrix4().multiplyMatrices(sdk.camera.projectionMatrix, sdk.camera.matrixWorldInverse);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projection);
  assert.equal(frustum.intersectsBox(new THREE.Box3().setFromObject(sdk.objects[0].root)), true);
  sdk.camera.position.x = 20;
  sdk.objects[0].tick();
  assert.equal(sdk.objects[0].group.position.x, 2);
  controller.setDiagnostic(true);
  sdk.objects[0].root.traverse(object => { if (object.isMesh) assert.equal(object.material.depthTest, false); });
  const adjusted = controller.adjust(item.id, { height: .2, yaw: Math.PI / 2 });
  assert.equal(adjusted.position.y, .23);
  assert.equal(adjusted.yaw, Math.PI / 2);
  controller.remove(item.id);
  assert.equal(sdk.scene.children.length, 0);
  controller.dispose();
  await assert.rejects(controller.add({ type: 'cone' }), /closed/);
});

test('restored and surface-picked obstacles retain exact world coordinates', { skip: !THREE && 'Run npm run setup:bundle' }, async () => {
  const sdk = fixtureSdk();
  const controller = await createObstacleScene(sdk);
  const spec = { id: 'picked', type: 'cone', position: { x: 4, y: 2.03, z: -6 }, yaw: .5 };
  const item = await controller.add(spec);
  assert.deepEqual(item, spec);
  assert.equal(sdk.objects[0].group.position.y, 2.03);
  controller.dispose();
  assert.equal(sdk.scene.children.length, 0);
});


test('synchronous SDK component failure cleans up without an unhandled rejection', { skip: !THREE && 'Run npm run setup:bundle' }, async () => {
  const sdk = fixtureSdk({ failAdd: true });
  const controller = await createObstacleScene(sdk);
  await assert.rejects(controller.add({ id: 'failed', type: 'barricade', floorY: 0 }), /SDK component setup failed/);
  assert.equal(sdk.scene.children.length, 0);
  controller.dispose();
  // Give Node a turn to report any orphaned attachment rejection.
  await new Promise(resolve => setImmediate(resolve));
});


test('generated model files retain baked colors, details, and meter-scale bounds', { skip: !THREE && 'Run npm run setup:bundle' }, async () => {
  for (const type of ['barricade', 'cone', 'debris']) {
    const data = JSON.parse(await readFile(new URL(`../public/models/${type}.json`, import.meta.url), 'utf8'));
    const root = new THREE.ObjectLoader().parse(data);
    assert.equal(root.userData.generatedAsset, true);
    const bounds = new THREE.Box3().setFromObject(root);
    assert.ok(bounds.min.y >= -.00001);
    assert.ok(bounds.max.y < 1.3 && bounds.max.y > .4);
    let meshes = 0;
    root.traverse(object => {
      if (!object.isMesh) return;
      meshes++;
      assert.equal(object.geometry.getAttribute('color').count, object.geometry.getAttribute('position').count);
      assert.equal(object.material.vertexColors, true);
      assert.equal(object.material.isMeshBasicMaterial, true);
    });
    assert.ok(meshes > 15);
    disposeObstacleMesh(root);
  }
});

test('saved model asset is decoded inside the SDK component and shadows survive diagnostic mode', { skip: !THREE && 'Run npm run setup:bundle' }, async () => {
  const data = JSON.parse(await readFile(new URL('../public/models/cone.json', import.meta.url), 'utf8'));
  const sdk = fixtureSdk();
  const controller = await createObstacleScene(sdk, { loadModel: async () => data });
  await controller.add({ type: 'cone', floorY: 0 });
  const root = sdk.objects[0].root;
  assert.equal(root.userData.generatedAsset, true);
  const shadow = root.children.find(child => child.name === 'Soft contact shadow');
  const opacity = shadow.material.opacity;
  assert.ok(opacity > 0 && opacity < .1);
  controller.setDiagnostic(true);
  controller.setDiagnostic(false);
  assert.equal(shadow.material.opacity, opacity);
  assert.equal(shadow.material.depthWrite, false);
  controller.dispose();
});
