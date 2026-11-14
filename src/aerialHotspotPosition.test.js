import test from 'node:test';
import assert from 'node:assert/strict';
import { imageToOffset, offsetToImage } from './aerialHotspotPosition.js';

test('image points round-trip at every supported zoom width', () => {
  for (const width of [200, 400, 600, 1000, 1600]) {
    for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5], [0.25, 0.75]]) {
      const actual = offsetToImage(imageToOffset(x, y, width), width);
      assert.ok(Math.abs(actual.x - x) < 1e-10);
      assert.ok(Math.abs(actual.y - y) < 1e-10);
    }
  }
});

test('saved hotspots retain their ground offset as the view zooms out', () => {
  const saved = JSON.parse(JSON.stringify(imageToOffset(0.75, 0.2, 200)));
  const position = offsetToImage(saved, 400);
  assert.equal(position.x, 0.625);
  assert.equal(position.y, 0.35);
});

test('zooming in can put a hotspot outside the visible footprint', () => {
  const saved = imageToOffset(0.9, 0.1, 1600);
  const { x, y } = offsetToImage(saved, 200);
  assert.ok(x > 1 && y < 0);
});
