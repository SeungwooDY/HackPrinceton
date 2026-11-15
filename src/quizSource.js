import { readJsonResponse } from './apiResponse.js';
import { parseTaskDocument } from './taskImport.js';

// Rank-based partial credit: picking a better-ranked option scores more.
const RANK_POINTS = { best: 3, second_best: 2, second_worst: 1, worst: 0 };
export const MAX_POINTS_PER_QUESTION = 3;

// Drive the viewer's sweep-triggered questions from the server (/api/quiz) rather
// than a bundled demo-tasks.json. We shape the quiz items into the same task
// document parseTaskDocument already accepts, so everything downstream
// (ModelTags, SweepQuestions, resolveTask) is unchanged.
//
// Phase 1: options are shuffled and the "best" option is mapped to correctIndex so
// the existing binary widget works. Phase 2 swaps this for rank-based scoring
// (best=3, second_best=2, second_worst=1, worst=0) and drops the binary mapping.
export async function loadQuizFile(modelId) {
  const res = await fetch(`/api/quiz?model=${encodeURIComponent(modelId)}`);
  if (!res.ok) throw new Error(`quiz fetch failed: ${res.status}`);
  const { quizItems = [] } = await readJsonResponse(res, 'Quiz API');

  const tasks = quizItems.map((q, i) => {
    const opts = (q.options || []).filter(o => o && typeof o.text === 'string');
    // shuffle so the best answer isn't always first
    const order = opts.map((_, j) => j);
    for (let j = order.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
    const shuffled = order.map(j => opts[j]);
    const correctIndex = Math.max(0, shuffled.findIndex(o => o.rank === 'best'));
    return {
      id: q.id || `q${i + 1}`,
      // checkpointLabel ("Checkpoint 3", or "Checkpoint 3 -- Bedroom") is an
      // order-blind wayfinding name from the server -- see serve.py. It's
      // what the native 3D marker shows AND what the debrief uses to name
      // this checkpoint when comparing the trainee's order to the optimal one.
      title: q.checkpointLabel || q.roomLabel || q.quizCategory || 'Checkpoint',
      type: 'Search',
      location: {
        matterportModelId: q.matterportModelId,
        locationId: q.sweepId,
        roomLabel: q.roomLabel,
      },
      quiz: {
        question: [q.scenario, 'Select the best option.'].filter(Boolean).join(' '),
        options: shuffled.map(o => o.text),
        correctIndex,
        scores: shuffled.map(o => RANK_POINTS[o.rank] ?? 0),
      },
    };
  });

  const doc = { matterportModelId: modelId, tasks };
  return { ...parseTaskDocument(doc, `api-quiz:${modelId}`), autoActivate: true };
}
