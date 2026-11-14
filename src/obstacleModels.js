// Authoring geometry for the generated local Three.js model assets.
// World units are meters, +Y is up, and all props are grounded at Y=0.
export const OBSTACLE_TYPES = ['barricade', 'cone', 'debris'];

export function createObstacleMesh(THREE, type = 'barricade') {
  const root = new THREE.Group();
  root.name = `training-${type}`;
  const materials = {};
  function material(name, color, opacity = 1) {
    return materials[name] ||= new THREE.MeshBasicMaterial({ name, color, vertexColors: true, toneMapped: false,
      transparent: opacity < 1, opacity, depthWrite: opacity === 1, side: THREE.DoubleSide });
  }
  const orange = material('Safety orange plastic', 0xf57917);
  const reflective = material('Reflective ivory', 0xf7f5e8);
  const rubber = material('Weighted rubber', 0x292a2a);
  const metal = material('Galvanized steel', 0xaeb8bb);
  const rust = material('Oxidized steel', 0x6b4530);
  function mesh(geometry, mat, x = 0, y = 0, z = 0) {
    const result = new THREE.Mesh(geometry, mat);
    result.position.set(x, y, z);
    root.add(result);
    return result;
  }
  function rounded(w, h, d, radius, mat, x = 0, y = 0, z = 0) {
    const shape = new THREE.Shape();
    const a = -w / 2, b = -h / 2, r = Math.min(radius, w / 3, h / 3);
    shape.moveTo(a + r, b); shape.lineTo(a + w - r, b); shape.quadraticCurveTo(a + w, b, a + w, b + r);
    shape.lineTo(a + w, b + h - r); shape.quadraticCurveTo(a + w, b + h, a + w - r, b + h);
    shape.lineTo(a + r, b + h); shape.quadraticCurveTo(a, b + h, a, b + h - r);
    shape.lineTo(a, b + r); shape.quadraticCurveTo(a, b, a + r, b);
    const bevel = Math.min(.006, d / 5, radius / 2);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * bevel, bevelEnabled: true, bevelSize: bevel,
      bevelThickness: bevel, bevelSegments: 2, curveSegments: 4, steps: 1 });
    geometry.translate(0, 0, -d / 2 + bevel);
    return mesh(geometry, mat, x, y, z);
  }
  function rod(a, b, radius, mat, sides = 12) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    const result = mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), sides), mat);
    result.position.copy(start.add(end).multiplyScalar(.5));
    result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return result;
  }
  function clipPolygon(points, axis, boundary, greater) {
    const result = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const ain = greater ? a[axis] >= boundary : a[axis] <= boundary;
      const bin = greater ? b[axis] >= boundary : b[axis] <= boundary;
      if (ain) result.push(a);
      if (ain !== bin) {
        const t = (boundary - a[axis]) / (b[axis] - a[axis]);
        result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    return result;
  }
  function stripedBoard(y) {
    rounded(1.58, .2, .055, .018, reflective, 0, y, 0);
    // Clip diagonal reflective bands to the board face, instead of stacking boxes.
    for (let x = -.95; x < .95; x += .29) {
      let polygon = [[x - .1, -.088], [x + .035, -.088], [x + .21, .088], [x + .075, .088]];
      polygon = clipPolygon(polygon, 0, -.765, true);
      polygon = clipPolygon(polygon, 0, .765, false);
      if (polygon.length < 3) continue;
      const shape = new THREE.Shape(polygon.map(p => new THREE.Vector2(...p)));
      for (const side of [-1, 1]) mesh(new THREE.ShapeGeometry(shape), orange, 0, y, side * .0285);
    }
    for (const x of [-.61, .61]) {
      for (const z of [-.031, .031]) {
        const bolt = mesh(new THREE.CylinderGeometry(.014, .014, .012, 6), metal, x, y, z);
        bolt.rotation.x = Math.PI / 2;
      }
    }
  }
  if (type === 'cone') {
    rounded(.58, .58, .065, .06, rubber, 0, .033, 0).rotation.x = -Math.PI / 2;
    for (const x of [-.21, .21]) for (const z of [-.21, .21]) {
      mesh(new THREE.CylinderGeometry(.016, .016, .004, 12), rubber, x, .068, z);
    }
    const radius = y => .235 - (y - .07) / .76 * .19;
    const levels = [.07, .25, .38, .51, .64, .83];
    for (let i = 0; i < levels.length - 1; i++) {
      const low = levels[i], high = levels[i + 1];
      mesh(new THREE.CylinderGeometry(radius(high), radius(low), high - low, 40, 1, true), i === 1 || i === 3 ? reflective : orange, 0, (low + high) / 2, 0);
    }
    const lip = mesh(new THREE.TorusGeometry(.045, .008, 8, 40), orange, 0, .83, 0);
    lip.rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(.037, .037, .018, 32), rubber, 0, .815, 0);
    const flange = mesh(new THREE.TorusGeometry(.234, .011, 8, 40), orange, 0, .077, 0);
    flange.rotation.x = Math.PI / 2;
  } else if (type === 'debris') {
    const concrete = [material('Dusty concrete', 0xa8a49b), material('Broken aggregate', 0x817f78), material('Pale rubble', 0xc6beb0)];
    for (let i = 0; i < 14; i++) {
      const angle = i * 2.39996;
      const radius = .12 + (i % 4) * .105;
      const stone = mesh(new THREE.DodecahedronGeometry(.14 + i % 3 * .035, 0), concrete[i % 3], Math.cos(angle) * radius, .14 + (i % 3) * .035, Math.sin(angle) * radius * .75);
      stone.scale.set(1.1, .65 + i % 2 * .2, .8);
      stone.rotation.set(i * .37, i * .73, i * .19);
    }
    const brick = material('Broken brick', 0xa26948), wood = material('Splintered timber', 0x8b704e);
    for (let i = 0; i < 5; i++) {
      const block = rounded(.23, .075, .115, .008, brick, (i - 2) * .17, .08 + i % 2 * .12, i % 2 * .3 - .15);
      block.rotation.set(.1 * i, i * .8, i % 2 * .15);
    }
    for (let i = 0; i < 3; i++) {
      const plank = rounded(.85 - i * .12, .045, .095, .003, wood, -.1 + i * .14, .3 + i * .045, i * .13 - .13);
      plank.rotation.set(.15 * i, -.6 + i * .5, -.12 + i * .13);
    }
    for (let i = 0; i < 2; i++) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.5, .13, i * .2), new THREE.Vector3(-.1, .37, i * .2), new THREE.Vector3(.28, .25, -.12 + i * .2), new THREE.Vector3(.48, .12, i * .2)]);
      mesh(new THREE.TubeGeometry(curve, 18, .009, 7, false), rust);
    }
  } else {
    // A-frame supports, rubber feet, reflective boards, hardware, and warning beacon.
    for (const x of [-.61, .61]) {
      for (const side of [-1, 1]) {
        rod([x, .07, side * .29], [x, 1.02, 0], .026, metal);
        rounded(.14, .065, .16, .016, rubber, x, .033, side * .29);
      }
      rod([x, .22, -.24], [x, .22, .24], .012, metal);
      const hinge = mesh(new THREE.CylinderGeometry(.045, .045, .08, 16), orange, x, 1.01, 0);
      hinge.rotation.z = Math.PI / 2;
    }
    stripedBoard(.62); stripedBoard(.93);
    const housing = mesh(new THREE.CylinderGeometry(.072, .075, .065, 24), rubber, .61, 1.07, 0);
    const beacon = mesh(new THREE.SphereGeometry(.065, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), material('Amber warning lens', 0xf4a72b), .61, 1.1, 0);
    housing.name = 'Beacon base'; beacon.name = 'Amber beacon';
  }
  // Soft contact shadow is part of the asset, not a global scene light.
  for (let i = 0; i < 4; i++) {
    const shade = material(`Contact shadow ${i}`, 0x171410, .035);
    const shadow = mesh(new THREE.CircleGeometry(type === 'cone' ? .31 + i * .025 : .57 + i * .04, 40), shade, 0, .001 + i * .00015, 0);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.y = type === 'cone' ? 1 : .65;
    shadow.name = 'Soft contact shadow';
  }
  // Bake a consistent soft light into vertex colors; unlit materials stay visible
  // in Showcase's panorama renderer without adding lights to the scanned room.
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!object.isMesh || object.name === 'Soft contact shadow') return;
    const bottom = new THREE.Box3().setFromObject(object).min.y;
    if (bottom < 0) object.position.y -= bottom;
  });
  root.updateMatrixWorld(true);
  const light = new THREE.Vector3(-.45, .85, .65).normalize();
  root.traverse(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry;
    const normal = geometry.getAttribute('normal');
    const colors = new Float32Array(normal.count * 3);
    const transform = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
    for (let i = 0; i < normal.count; i++) {
      const n = new THREE.Vector3().fromBufferAttribute(normal, i).applyNormalMatrix(transform);
      const shade = object.name === 'Soft contact shadow' ? 1 : .5 + .4 * Math.max(0, n.dot(light)) + .1 * Math.max(0, n.y);
      colors.set([shade, shade, shade], i * 3);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    // Parametric geometries serialize only constructor parameters, losing baked
    // color attributes. Store an ordinary BufferGeometry in the model asset.
    object.geometry = new THREE.BufferGeometry().copy(geometry);
    geometry.dispose();
  });
  const bounds = new THREE.Box3().setFromObject(root);
  root.position.y -= Math.min(0, bounds.min.y);
  root.userData = { generatedAsset: true, units: 'meters', shading: 'baked vertex lighting', version: 2 };
  return root;
}
