import { isVector, normalizeQuiz } from './tagStorage.js';

const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const scalar = value => ['string', 'number'].includes(typeof value) ? String(value) : '';
const modelPattern = /^[a-zA-Z0-9]{11}$/;
const spaced = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2');

function explicitQuiz(task) {
  const source = task.quiz || task;
  const question = text(source.question, 300);
  if (!question && !task.quiz) return { quiz: null, supplied: false };
  const choices = source.options || source.choices;
  if (!Array.isArray(choices)) return { quiz: null, supplied: true };
  const options = choices.map(option => typeof option === 'string' ? option : text(option?.text || option?.label, 150));
  let correctIndex = source.correctIndex ?? source.correctAnswerIndex;
  if (!Number.isInteger(correctIndex)) {
    const answer = source.correctAnswer ?? source.answer;
    if (answer !== undefined && answer !== null) {
      correctIndex = choices.findIndex((option, i) =>
        options[i].trim().toLowerCase() === String(answer).trim().toLowerCase()
        || (typeof option === 'object' && scalar(option?.id) === String(answer)));
    } else {
      const indices = choices.map((option, i) => option?.isCorrect === true ? i : -1).filter(i => i >= 0);
      if (indices.length === 1) correctIndex = indices[0];
    }
  }
  const quiz = normalizeQuiz({ question, options, correctIndex, scores: source.scores });
  if (quiz && new Set(quiz.options.map(option => option.toLowerCase())).size !== quiz.options.length) return { quiz: null, supplied: true };
  return { quiz, supplied: true };
}

function numericQuiz(question, value, path, clarification = '') {
  const step = Math.max(1, Math.round(Math.abs(value) * 0.1));
  const options = [...new Set([String(value), String(value + step), String(Math.max(0, value - step)), 'Not recorded'])].slice(0, 4);
  const offset = Math.abs(Math.round(value)) % options.length;
  const rotated = [...options.slice(offset), ...options.slice(0, offset)];
  return { quiz: { question: (question + clarification).slice(0, 300), options: rotated, correctIndex: rotated.indexOf(String(value)) }, evidence: [{ path, value }] };
}

function deriveQuiz(task, facts, building, floorPath) {
  const occupant = Array.isArray(facts.occupants) ? facts.occupants.find(person => person.refName === task.refs?.occupantRef) : null;
  const occupantIndex = occupant ? facts.occupants.indexOf(occupant) : -1;
  if (task.type === 'Utility' && typeof building.hasSprinklers === 'boolean') {
    return { quiz: { question: 'What does the supplied building record report about sprinklers?', options: ['Recorded present', 'Recorded absent', 'Not recorded'], correctIndex: building.hasSprinklers ? 0 : 1 }, evidence: [{ path: 'building.hasSprinklers', value: building.hasSprinklers }] };
  }
  if (occupant && Number.isFinite(occupant.employees) && occupant.employees >= 0) {
    return numericQuiz(`How many employees are reported for ${occupant.refName}?`, occupant.employees, `${floorPath}.facts.occupants[${occupantIndex}].employees`, ' This is not a live occupant count.');
  }
  if (occupant && text(occupant.industry) && occupant.industry !== 'Unknown') {
    const answer = spaced(occupant.industry);
    const options = [...new Set([answer, 'Educational Services', 'Health Care And Social Assistance', 'Not recorded'])].slice(0, 4);
    return { quiz: { question: `Which industry is recorded for ${occupant.refName}?`.slice(0, 300), options, correctIndex: 0 }, evidence: [{ path: `${floorPath}.facts.occupants[${occupantIndex}].industry`, value: occupant.industry }] };
  }
  if (Number.isInteger(building.numStoriesAboveGrade) && building.numStoriesAboveGrade > 0) {
    return numericQuiz('How many above-grade stories does the supplied building record list?', building.numStoriesAboveGrade, 'building.numStoriesAboveGrade');
  }
  if (typeof building.hasSprinklers === 'boolean') return deriveQuiz({ type: 'Utility' }, {}, building, floorPath);
  return { quiz: null, evidence: [] };
}

export function parseTaskDocument(input, fileName = 'Imported tasks') {
  let document;
  try { document = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '')) : input; }
  catch { throw new Error('This file is not valid JSON. Check its commas, quotes, and brackets.'); }
  if (!document || typeof document !== 'object') throw new Error('Expected a JSON object or an array of tasks.');
  const building = document.building && typeof document.building === 'object' ? document.building : {};
  const groups = [];
  if (Array.isArray(document.floors)) document.floors.forEach((floor, i) => {
    const facts = floor?.facts || floor || {};
    if (Array.isArray(floor?.tasks)) groups.push({ tasks: floor.tasks, facts, path: `floors[${i}]`, scope: `floor-${i}`, name: `${spaced(facts.floorName || 'Unspecified floor')} (${facts.propertyFloorId ?? i + 1})` });
  });
  const rootKey = Array.isArray(document.tasks) ? 'tasks' : 'questions';
  const rootTasks = Array.isArray(document) ? document : document[rootKey];
  if (Array.isArray(rootTasks)) groups.push({ tasks: rootTasks, facts: {}, path: '', rootKey: Array.isArray(document) ? '' : rootKey, scope: 'document', name: 'Document tasks' });
  if (!groups.length) throw new Error('No tasks found. Use floors[].tasks[], tasks[], questions[], or a top-level task array.');
  if (groups.reduce((count, group) => count + group.tasks.length, 0) > 500) throw new Error('Import up to 500 tasks per file.');
  const tasks = [], issues = [], ids = new Set();
  for (const group of groups) group.tasks.forEach((task, index) => {
    const path = group.path ? `${group.path}.tasks[${index}]` : `${group.rootKey}[${index}]`;
    if (!task || typeof task !== 'object') { issues.push(`${path}: expected a task object.`); return; }
    const location = task.location || {};
    const modelId = text(location.matterportModelId || task.matterportModelId || task.modelId || document.matterportModelId || document.modelId, 50);
    const sweepId = text(location.locationId || location.sweepId || task.sweepId, 150);
    if (!modelPattern.test(modelId) || !sweepId) { issues.push(`${path}: needs a valid matterportModelId and locationId / sweepId.`); return; }
    const floorId = task.refs?.propertyFloorId ?? group.facts.propertyFloorId ?? null;
    const id = `import:${[building.propertyId ?? 'unknown', group.scope, floorId ?? 'unknown', task.id ?? index, modelId, sweepId].map(value => encodeURIComponent(scalar(value))).join(':')}`;
    if (ids.has(id)) { issues.push(`${path}: duplicate task identity skipped.`); return; }
    ids.add(id);
    const parsed = explicitQuiz(task);
    if (parsed.supplied && !parsed.quiz) { issues.push(`${path}: invalid quiz. Provide a question, 2–4 distinct choices, and a zero-based correctIndex or matching correctAnswer.`); return; }
    const derived = parsed.supplied ? { quiz: parsed.quiz, evidence: [{ path: task.quiz ? `${path}.quiz` : path, value: 'Question and answer supplied in file' }] } : deriveQuiz(task, group.facts, building, group.path);
    const warnings = ['Floor, suite, and physical fixture mapping are unverified.'];
    if (task.refs?.propertyFloorId != null && group.facts.propertyFloorId != null && String(task.refs.propertyFloorId) !== String(group.facts.propertyFloorId)) warnings.push('Task floor reference conflicts with its enclosing floor record.');
    if (location.floorMappingNote) warnings.push(text(location.floorMappingNote));
    if (location.roomLabel === 'Other' || !location.roomLabel) warnings.push('Room label is generic or missing.');
    const rawAnchor = location.anchorPosition || task.anchorPosition;
    if (rawAnchor != null && !isVector(rawAnchor)) { issues.push(`${path}: anchorPosition must contain finite x, y, z coordinates.`); return; }
    tasks.push({ id, title: text(task.title || task.label || task.question || task.quiz?.question, 100) || `Task ${task.id ?? index + 1}`,
      description: text(task.description), type: text(task.type, 50) || 'Training',
      modelId, sweepId, floorId, scope: group.scope, scopeName: group.name,
      roomLabel: text(location.roomLabel, 100), anchorPosition: rawAnchor ? { x: rawAnchor.x, y: rawAnchor.y, z: rawAnchor.z } : null,
      quiz: derived.quiz, quizOrigin: parsed.supplied ? 'file' : derived.quiz ? 'recorded-fact' : 'review',
      evidence: derived.evidence, warnings,
      source: { fileName: text(fileName, 200), taskId: scalar(task.id ?? index), taskPath: path, propertyId: building.propertyId ?? null, floorId },
    });
  });
  const sweepFloors = new Map();
  for (const task of tasks) {
    const key = `${task.modelId}:${task.sweepId}`;
    const scopes = sweepFloors.get(key) || new Set(); scopes.add(task.scope); sweepFloors.set(key, scopes);
  }
  for (const task of tasks) if (sweepFloors.get(`${task.modelId}:${task.sweepId}`).size > 1) task.warnings.push('This sweep is reused across multiple floor scenarios in the file.');
  if (!tasks.length) throw new Error(issues.length ? issues.slice(0, 3).join(' ') : 'No task entries were found.');
  return { fileName: text(fileName, 200), tasks, issues, models: [...new Set(tasks.map(task => task.modelId))] };
}

export function resolveTask(task, modelId, sweeps, existingIds = new Set()) {
  if (task.modelId !== modelId) return { status: 'other-model', reason: `Requires model ${task.modelId}` };
  const sweep = sweeps.get(task.sweepId);
  if (!sweep || sweep.enabled === false) return { status: 'missing-sweep', reason: 'Sweep not found among enabled sweeps in this model' };
  if (existingIds.has(task.id)) return { status: 'existing', reason: 'Already imported' };
  const anchorPosition = task.anchorPosition || (isVector(sweep.puckPosition) ? { ...sweep.puckPosition } : null);
  if (!anchorPosition) return { status: 'missing-position', reason: 'No sweep floor position; supply location.anchorPosition or place manually' };
  return { status: 'ready', reason: task.anchorPosition ? 'File coordinates · unverified mapping' : 'Sweep checkpoint · unverified mapping',
    tag: { id: task.id, label: task.title,
      description: `Imported training scenario. Floor and suite mapping are unverified.\n${task.description}`.slice(0, 1000),
      anchorPosition, stemVector: { x: 0, y: 0.3, z: 0 }, reviewed: false,
      quiz: task.quiz, quizResult: null,
      importedTask: { ...task.source, modelId: task.modelId, sweepId: task.sweepId, type: task.type, floorId: task.floorId, mappingStatus: 'unverified', placement: task.anchorPosition ? 'file-coordinates' : 'sweep-checkpoint', quizOrigin: task.quizOrigin, warnings: task.warnings, evidence: task.evidence },
    } };
}
