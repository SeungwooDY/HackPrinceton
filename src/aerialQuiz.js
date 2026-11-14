import { gradeTagAnswer, normalizeQuiz } from './tagStorage.js';

// Default questions are property-level tasks; no feature locations are asserted.
export const AERIAL_QUIZ_POINTS = [
  {
    id: 'property-overview-v1', label: 'Property overview', east: null, north: null, placementStatus: 'unlocated',
    description: 'Start with the property at the center of the aerial view.',
    quiz: {
      question: 'Before planning work from an aerial image, how should you confirm the area you are assessing?',
      options: ['Assume the image edges show the legal property boundary.', 'Confirm the property location and boundaries using verified site information.', 'Treat every nearby building as part of the same property.'],
      correctIndex: 1,
    },
    explanation: 'The image is centered on address coordinates. Its edges and the checkpoint markers do not define property boundaries.',
  },
  {
    id: 'access-review-v1', label: 'Access review', east: null, north: null, placementStatus: 'unlocated',
    description: 'Use the surrounding imagery to begin reviewing possible site access.',
    quiz: {
      question: 'What is the best next step when a route in the aerial image appears to lead onto the site?',
      options: ['Confirm the entrance, permissions, and current route conditions with site information.', 'Assume the route is open because it is visible.', 'Choose the shortest route without checking restrictions.'],
      correctIndex: 0,
    },
    explanation: 'Aerial imagery can suggest a route, but it does not establish that an entrance is open, permitted, or suitable today.',
  },
  {
    id: 'surroundings-review-v1', label: 'Surroundings review', east: null, north: null, placementStatus: 'unlocated',
    description: 'Zoom out to review how the property relates to its surroundings.',
    quiz: {
      question: 'Why review a wider aerial view before planning activity at the property?',
      options: ['It replaces checking current conditions on site.', 'It proves every visible area is available for storage.', 'It helps identify nearby roads, buildings, and other areas that need further review.'],
      correctIndex: 2,
    },
    explanation: 'A wider view provides context for planning. Follow up on visible features with current, verified site information.',
  },
];

const keyFor = modelId => `aerial-quiz-answers:v1:${modelId}`;

export function loadAerialQuizAnswers(storage, modelId, points = AERIAL_QUIZ_POINTS) {
  const saved = JSON.parse(storage.getItem(keyFor(modelId)) || '{}');
  return Object.fromEntries(points.filter(point => gradeTagAnswer(point, saved?.[point.id]) !== null)
    .map(point => [point.id, saved[point.id]]));
}

export function saveAerialQuizAnswers(storage, modelId, answers) {
  storage.setItem(keyFor(modelId), JSON.stringify(answers));
}

const pointsKeyFor = modelId => `aerial-quiz-points:v1:${modelId}`;

export function parseAerialQuizFile(text, modelId) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  if (data?.version !== 1) throw new Error('The JSON must have version: 1.');
  if (data.modelId !== modelId) throw new Error(`This file must have modelId: "${modelId}" for the current property.`);
  if (!Array.isArray(data.points) || !data.points.length || data.points.length > 100) throw new Error('Provide between 1 and 100 quiz points.');
  const ids = new Set();
  return data.points.map((point, index) => {
    const fail = message => { throw new Error(`Point ${index + 1}: ${message}`); };
    if (!point || typeof point.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(point.id) || ['__proto__', 'constructor', 'prototype'].includes(point.id) || ids.has(point.id)) fail('id must be unique and contain only letters, numbers, underscores, or hyphens.');
    ids.add(point.id);
    if (typeof point.label !== 'string' || !point.label.trim() || point.label.length > 100) fail('provide a label of 1–100 characters.');
    const legacyLayout = typeof point.placementNote === 'string' && point.placementNote.startsWith('Training layout around the property address coordinates');
    const unlocated = point.placementStatus === 'unlocated' || legacyLayout;
    if (unlocated && !legacyLayout && (point.east !== null || point.north !== null)) fail('unlocated tasks must have null east and north.');
    if (!unlocated && (!Number.isFinite(point.east) || !Number.isFinite(point.north) || Math.abs(point.east) > 800 || Math.abs(point.north) > 1600 / 3)) fail('east and north must be meter offsets within the widest aerial footprint (±800 east, ±533.33 north).');
    if (point.placementStatus !== undefined && !['unlocated', 'candidate', 'reviewed'].includes(point.placementStatus)) fail('placementStatus must be unlocated, candidate, or reviewed.');
    if (typeof point.quiz?.question === 'string' && point.quiz.question.length > 300) fail('quiz question must be at most 300 characters.');
    if (Array.isArray(point.quiz?.options) && point.quiz.options.some(option => typeof option === 'string' && option.length > 150)) fail('quiz options must be at most 150 characters each.');
    const quiz = normalizeQuiz(point.quiz);
    if (!quiz) fail('quiz needs a question, 2–4 text options, and a zero-based correctIndex.');
    for (const field of ['description', 'explanation']) {
      if (point[field] !== undefined && (typeof point[field] !== 'string' || point[field].length > 1000)) fail(`${field} must be text up to 1000 characters.`);
    }
    const metadata = {};
    if (unlocated) metadata.placementStatus = 'unlocated';
    else if (point.placementStatus) metadata.placementStatus = point.placementStatus;
    if (legacyLayout) metadata.placementNote = 'No feature location is available. Select this task from the property checklist or place it on reviewed imagery.';
    if (point.placementNote !== undefined) {
      if (typeof point.placementNote !== 'string' || point.placementNote.length > 1000) fail('placementNote must be text up to 1000 characters.');
      if (!legacyLayout) metadata.placementNote = point.placementNote;
    }
    if (point.evidence !== undefined) {
      if (!Array.isArray(point.evidence) || point.evidence.length > 100) fail('evidence must be a list of at most 100 source fields.');
      metadata.evidence = point.evidence.map(source => {
        if (!source || typeof source !== 'object') fail('each evidence entry must be a source object.');
        for (const field of ['dataset', 'path']) {
          if (typeof source[field] !== 'string' || !source[field].trim() || source[field].length > 300) fail(`evidence ${field} must be text of 1–300 characters.`);
        }
        if (!(typeof source.recordId === 'string' && source.recordId.length <= 100) && !Number.isSafeInteger(source.recordId)) fail('evidence recordId must be a record identifier.');
        if (!(source.value === null || typeof source.value === 'boolean' || (typeof source.value === 'string' && source.value.length <= 1000) || (typeof source.value === 'number' && Number.isFinite(source.value)))) fail('evidence value must be text, a number, a boolean, or null.');
        const normalized = { dataset: source.dataset, recordId: source.recordId, path: source.path, value: source.value };
        if (source.origin !== undefined) {
          if (typeof source.origin !== 'string' || source.origin.length > 100) fail('evidence origin must be text up to 100 characters.');
          normalized.origin = source.origin;
        }
        if (source.featureId !== undefined) {
          if (!Number.isSafeInteger(source.featureId)) fail('evidence featureId must be an integer.');
          normalized.featureId = source.featureId;
        }
        return normalized;
      });
    }
    return { id: point.id, label: point.label.trim(), east: unlocated ? null : point.east, north: unlocated ? null : point.north, description: point.description || '', explanation: point.explanation || '', quiz, ...metadata };
  });
}

export function loadAerialQuizPoints(storage, modelId) {
  const saved = storage.getItem(pointsKeyFor(modelId));
  return saved ? parseAerialQuizFile(saved, modelId) : null;
}

export function saveAerialQuizPoints(storage, modelId, points) {
  if (points === null) storage.removeItem(pointsKeyFor(modelId));
  else storage.setItem(pointsKeyFor(modelId), JSON.stringify({ version: 1, modelId, points }));
}
