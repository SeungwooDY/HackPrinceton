import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, parseModelId } from './modelCatalog.js';

test('model selection accepts IDs and tour links without navigating to pasted URLs', () => {
  assert.equal(parseModelId('  KBqHB8Xq9Vo  '), 'KBqHB8Xq9Vo');
  assert.equal(parseModelId('https://my.matterport.com/show/?m=Ki9YdfpNKum&play=1'), 'Ki9YdfpNKum');
  assert.equal(parseModelId('https://firesight-six.vercel.app/?model=PLPZJBUixWt'), 'PLPZJBUixWt');
  for (const invalid of ['', 'short', 'abcdefghijkl', 'javascript:alert(1)', 'https://my.matterport.com/show/?m=wrong', 'https://example.com/']) assert.equal(parseModelId(invalid), null);
});

test('all curated choices have unique valid model IDs', () => {
  assert.equal(new Set(MODEL_CATALOG.map(model => model.id)).size, MODEL_CATALOG.length);
  for (const model of MODEL_CATALOG) assert.equal(parseModelId(model.id), model.id);
});
