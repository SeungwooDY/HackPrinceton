import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AERIAL_QUIZ_POINTS, loadAerialQuizAnswers, saveAerialQuizAnswers, parseAerialQuizFile, loadAerialQuizPoints, saveAerialQuizPoints } from './aerialQuiz.js';

function memoryStorage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, removeItem: key => items.delete(key), setItem: (key, value) => items.set(key, value) };
}

test('imported quizzes round-trip and answers use the imported set', () => {
  const storage = memoryStorage();
  const point = { ...AERIAL_QUIZ_POINTS[0], id: 'custom-checkpoint' };
  const points = parseAerialQuizFile(JSON.stringify({ version: 1, modelId: 'model-a', points: [point] }), 'model-a');
  saveAerialQuizPoints(storage, 'model-a', points);
  assert.deepEqual(loadAerialQuizPoints(storage, 'model-a'), [point]);
  assert.equal(loadAerialQuizPoints(storage, 'model-b'), null);
  saveAerialQuizAnswers(storage, 'model-a', { [point.id]: point.quiz.correctIndex });
  assert.deepEqual(loadAerialQuizAnswers(storage, 'model-a', points), { [point.id]: point.quiz.correctIndex });
  saveAerialQuizPoints(storage, 'model-a', null);
  assert.equal(loadAerialQuizPoints(storage, 'model-a'), null);
});

test('import rejects wrong models, malformed files, duplicates, and invalid quiz data', () => {
  const point = AERIAL_QUIZ_POINTS[0];
  const file = changes => JSON.stringify({ version: 1, modelId: 'model-a', points: [point], ...changes });
  assert.throws(() => parseAerialQuizFile('{bad', 'model-a'), /valid JSON/);
  assert.throws(() => parseAerialQuizFile(file({ modelId: 'model-b' }), 'model-a'), /modelId/);
  assert.throws(() => parseAerialQuizFile(file({ version: 2 }), 'model-a'), /version/);
  assert.throws(() => parseAerialQuizFile(file({ points: [] }), 'model-a'), /between 1 and 100/);
  assert.throws(() => parseAerialQuizFile(file({ points: [point, point] }), 'model-a'), /unique/);
  for (const changes of [
    { east: 801 }, { north: -534 }, { east: '10' }, { label: '' }, { id: '__proto__' },
    { quiz: { ...point.quiz, correctIndex: 99 } }, { quiz: { ...point.quiz, options: ['one'] } },
    { quiz: { ...point.quiz, question: 'x'.repeat(301) } },
  ]) assert.throws(() => parseAerialQuizFile(file({ points: [{ ...point, ...changes }] }), 'model-a'));
});

test('the example JSON can be imported for the default model', async () => {
  const text = await readFile(new URL('../examples/aerial-quizzes.json', import.meta.url), 'utf8');
  assert.equal(parseAerialQuizFile(text, 'MBnYBa7whdC').length, 3);
});


test('import preserves source evidence and placement notes', () => {
  const point = { ...AERIAL_QUIZ_POINTS[0], placementNote: 'Training layout; not a feature location.', evidence: [
    { dataset: 'residential-listing-features.jsonl', recordId: 101, path: 'features[0].name', value: 'Garage', origin: 'Mls', featureId: 5 },
    { dataset: 'residential-listings.jsonl', recordId: 101, path: 'property.totalParkingSpaces', value: 0 },
  ] };
  const file = JSON.stringify({ version: 1, modelId: 'model-a', points: [point] });
  const [imported] = parseAerialQuizFile(file, 'model-a');
  assert.deepEqual(imported.evidence, point.evidence);
  assert.equal(imported.placementNote, point.placementNote);
  const storage = memoryStorage();
  saveAerialQuizPoints(storage, 'model-a', [imported]);
  assert.deepEqual(loadAerialQuizPoints(storage, 'model-a')[0].evidence, point.evidence);
  for (const evidence of [null, [null], [{ ...point.evidence[0], value: {} }], [{ ...point.evidence[0], path: '' }]]) {
    assert.throws(() => parseAerialQuizFile(JSON.stringify({ version: 1, modelId: 'model-a', points: [{ ...point, evidence }] }), 'model-a'), /evidence/);
  }
});


test('unlocated tasks remain unpinned and legacy training offsets are removed', () => {
  const old = { ...AERIAL_QUIZ_POINTS[0], east: -55, north: 30, placementNote: 'Training layout around the property address coordinates; not a feature location.' };
  delete old.placementStatus;
  const [migrated] = parseAerialQuizFile(JSON.stringify({ version: 1, modelId: 'model-a', points: [old] }), 'model-a');
  assert.equal(migrated.placementStatus, 'unlocated');
  assert.equal(migrated.east, null);
  assert.equal(migrated.north, null);
  const reviewed = { ...old, east: 5, north: -3, placementStatus: 'reviewed', placementNote: 'Reviewed image position.' };
  const [located] = parseAerialQuizFile(JSON.stringify({ version: 1, modelId: 'model-a', points: [reviewed] }), 'model-a');
  assert.equal(located.placementStatus, 'reviewed');
  assert.equal(located.east, 5);
});
