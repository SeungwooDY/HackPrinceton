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
