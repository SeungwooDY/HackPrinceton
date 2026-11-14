// Bridge: generated quiz data -> live graded Matterport tags.
//
// For the loaded model, fetch its quiz items (serve.py /api/quiz), map each
// item's sweepId to a 3D position (Sweep.data), and place a graded tag there
// reusing the model_tags widget. The 4-rank quiz is collapsed to "pick the best"
// (best -> correctIndex, options shuffled) so it fits the widget's single-correct
// format; this is upgradeable to full rank-grading without changing steps 1/2/4.
//
// Logs matched vs missing sweeps — if the quiz's sweepIds aren't in this model's
// Sweep.data (wrong model, or a re-scan changed ids), that surfaces here.

import { createTagWidget } from './tagWidget.js';
import { gradeTagAnswer } from './tagStorage.js';

const RANK_BEST = 'best';

function sweepPositionMap(sdk, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let sub;
    const t = setTimeout(() => {
      try { sub?.cancel?.(); } catch {}
      reject(new Error('Sweep.data did not populate in time'));
    }, timeoutMs);
    sub = sdk.Sweep.data.subscribe({
      onCollectionUpdated(collection) {
        const items = Object.values(collection || {});
        if (!items.length) return;
        clearTimeout(t);
        try { sub?.cancel?.(); } catch {}
        // A sweep exposes several identifiers (sid, id, uuid). Quiz sweepIds come
        // from the GraphQL Model API (location.id), which may be any of these —
        // so index the position under ALL of them to be id-space agnostic.
        const map = new Map();
        for (const s of items) {
          if (!s.position) continue;
          for (const key of [s.sid, s.id, s.uuid]) {
            if (key && !map.has(key)) map.set(key, s.position);
          }
        }
        // Diagnostic: sample live identifiers to compare against quiz sweepIds.
        console.log('[quizTags] live sweeps:', items.length, '| sample ids:',
          items.slice(0, 2).map(s => ({ sid: s.sid, id: s.id, uuid: s.uuid })));
        resolve(map);
      },
    });
  });
}

// 4-rank quiz item -> { question, options, correctIndex } with options shuffled.
function toWidgetQuiz(item) {
  const opts = (item.options || []).filter(o => o && typeof o.text === 'string');
  if (opts.length < 2) return null;
  const order = opts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const shuffled = order.map(i => opts[i]).slice(0, 4);
  const correctIndex = shuffled.findIndex(o => o.rank === RANK_BEST);
  if (correctIndex < 0) return null; // no "best" option -> can't grade
  const question =
    [item.scenario, item.question].filter(Boolean).join(' ') || 'Rank these actions.';
  return { question, options: shuffled.map(o => o.text), correctIndex };
}

export async function installQuizTags(sdk, modelId) {
  const result = { placed: 0, missing: [], placedIds: [] };
  if (!sdk?.Tag?.add || !sdk?.Sweep?.data?.subscribe) {
    console.warn('[quizTags] SDK Tag/Sweep API unavailable');
    return result;
  }

  let items = [];
  try {
    const res = await fetch(`/api/quiz?model=${encodeURIComponent(modelId)}`);
    items = (await res.json())?.quizItems || [];
  } catch (e) {
    console.warn('[quizTags] quiz fetch failed', e);
    return result;
  }
  if (!items.length) {
    console.log(`[quizTags] no quiz items for model ${modelId}`);
    return result;
  }

  let positions;
  try {
    positions = await sweepPositionMap(sdk);
  } catch (e) {
    console.warn('[quizTags]', e.message);
    return result;
  }

  for (const item of items) {
    const pos = positions.get(item.sweepId);
    if (!pos) { result.missing.push(item.sweepId); continue; }
    const quiz = toWidgetQuiz(item);
    if (!quiz) { console.warn('[quizTags] ungradeable item at', item.roomId); continue; }

    const tag = {
      id: `quiz-${item.sweepId}`,
      label: item.roomLabel || item.quizCategory || 'Checkpoint',
      description: item.scenario || '',
      anchorPosition: { x: pos.x, y: pos.y, z: pos.z },
      stemVector: { x: 0, y: 0.3, z: 0 },
      quiz,
      quizResult: null,
      reviewed: false,
    };
    try {
      const [sdkId] = await sdk.Tag.add({
        label: tag.label,
        description: tag.description,
        anchorPosition: tag.anchorPosition,
        stemVector: tag.stemVector,
        color: { r: 0.85, g: 0.3, b: 0.2 },
      });
      if (!sdkId) continue;
      result.placedIds.push(sdkId);
      try {
        const [attachmentId, messenger] = await sdk.Tag.registerSandbox(
          createTagWidget(tag),
          { name: 'Checkpoint quiz', size: { w: 320, h: 430 } },
        );
        messenger.on('answer', payload => {
          const correct = gradeTagAnswer(tag, payload?.selectedIndex);
          if (correct !== null) console.log(`[quizTags] ${tag.label}: ${correct ? 'correct' : 'incorrect'}`);
        });
        await sdk.Tag.attach(sdkId, attachmentId);
      } catch {
        // native tag still shows; only the interactive widget failed
      }
      result.placed += 1;
    } catch (e) {
      console.warn('[quizTags] could not place tag at', tag.label, e);
    }
  }

  console.log(`[quizTags] placed ${result.placed}/${items.length} quiz tags for ${modelId}`);
  if (result.missing.length) {
    console.warn(
      `[quizTags] ${result.missing.length} quiz sweepId(s) not in this model's Sweep.data ` +
        `(model mismatch or re-scan):`, result.missing,
    );
  }
  return result;
}
