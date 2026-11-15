// Rebuild the same local scene assets used by the Matterport obstacle renderer.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from '../public/bundle/vendors/three/0.184.0/three.module.min.js';
import { createObstacleMesh, OBSTACLE_TYPES } from '../src/obstacleModels.js';
const output = new URL('../public/models/', import.meta.url);
await mkdir(output, { recursive: true });
for (const type of OBSTACLE_TYPES) {
  const root = createObstacleMesh(THREE, type);
  const stableId = label => {
    const hex = createHash('sha256').update(`${type}:${label}`).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  let index = 0;
  const materials = new Set();
  root.traverse(object => {
    object.uuid = stableId(`node-${index}`);
    if (object.geometry) object.geometry.uuid = stableId(`geometry-${index}`);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
    index++;
  });
  [...materials].forEach((material, i) => { material.uuid = stableId(`material-${i}`); });
  const model = root.toJSON();
  await writeFile(new URL(`${type}.json`, output), JSON.stringify(model, (_key, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value));
  const triangles = model.geometries.reduce((sum, geometry) => sum + ((geometry.data?.index?.array.length || geometry.data?.attributes?.position?.array.length / 3 || 0) / 3), 0);
  console.log(`${type}: generated model with ${model.geometries.length} geometry parts, approximately ${Math.round(triangles)} stored triangles`);
}
