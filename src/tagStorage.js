const keyFor = modelId => `matterport-tags:v1:${modelId}`;
export const isVector = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]));

export function normalizeQuiz(quiz) {
  if (!quiz || typeof quiz.question !== 'string' || !quiz.question.trim() || !Array.isArray(quiz.options)
      || quiz.options.length < 2 || quiz.options.length > 4 || !quiz.options.every(option => typeof option === 'string' && option.trim())
      || !Number.isInteger(quiz.correctIndex) || quiz.correctIndex < 0 || quiz.correctIndex >= quiz.options.length) return null;
  return { question: quiz.question.trim().slice(0, 300), options: quiz.options.map(option => option.trim().slice(0, 150)), correctIndex: quiz.correctIndex };
}

export function gradeTagAnswer(tag, selectedIndex) {
  const quiz = normalizeQuiz(tag.quiz);
  if (!quiz || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= quiz.options.length) return null;
  return selectedIndex === quiz.correctIndex;
}

export function loadTags(storage, modelId) {
  const data = JSON.parse(storage.getItem(keyFor(modelId)) || '[]');
  if (!Array.isArray(data)) throw new Error('Saved tags are not a list.');
  const ids = new Set();
  return data.filter(tag => {
    if (!tag || typeof tag.id !== 'string' || ids.has(tag.id) || typeof tag.label !== 'string' || !isVector(tag.anchorPosition) || !isVector(tag.stemVector)) return false;
    ids.add(tag.id);
    return true;
  }).map(tag => ({
    id: tag.id, label: tag.label.slice(0, 100),
    description: typeof tag.description === 'string' ? tag.description.slice(0, 1000) : '',
    anchorPosition: { ...tag.anchorPosition }, stemVector: { ...tag.stemVector }, reviewed: tag.reviewed === true,
    quiz: normalizeQuiz(tag.quiz), quizResult: ['correct', 'incorrect'].includes(tag.quizResult) ? tag.quizResult : null,
  }));
}

export function saveTags(storage, modelId, tags) {
  storage.setItem(keyFor(modelId), JSON.stringify(tags));
}

export function surfacePosition(hit) {
  if (!isVector(hit?.position) || !isVector(hit?.normal)) return null;
  const length = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z);
  return {
    anchorPosition: { ...hit.position },
    stemVector: length > 0 ? Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, hit.normal[axis] / length * 0.3])) : { x: 0, y: 0.3, z: 0 },
  };
}
