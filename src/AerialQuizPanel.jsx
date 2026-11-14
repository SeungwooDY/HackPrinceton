import React from 'react';
import { gradeTagAnswer } from './tagStorage.js';

export default function AerialQuizPanel({ point, imported = false, selectedIndex, onAnswer, onRetry, onClose, onPlace }) {
  const correct = gradeTagAnswer(point, imported = false, selectedIndex);
  return <section className="aerial-hotspot-editor aerial-quiz-panel" aria-label={`${point.label} quiz`}>
    <div className="aerial-quiz-heading"><strong>{point.label}</strong><button type="button" onClick={onClose} aria-label="Close aerial quiz">×</button></div>
    <span className="aerial-quiz-kind">{imported ? 'Imported quiz checkpoint' : 'Preset training checkpoint'}</span>
    <p>{point.description}</p>
    {point.placementStatus === 'candidate' && <p className="aerial-location-status">Detected feature candidate — review its location in the image.</p>}
    {point.placementStatus === 'unlocated' && <p className="aerial-location-status">No feature location is set. This task has no map pin.</p>}
    {onPlace && <button type="button" onClick={onPlace}>{point.east === null ? 'Place on image' : 'Move marker'}</button>}
    <h3>{point.quiz.question}</h3>
    <div className="aerial-quiz-options" role="group" aria-label="Answer choices">
      {point.quiz.options.map((option, index) => <button key={index} type="button" disabled={correct !== null}
        className={correct !== null && index === point.quiz.correctIndex ? 'is-correct' : correct === false && selectedIndex === index ? 'is-incorrect' : ''}
        onClick={() => onAnswer(index)}>{option}{correct !== null && index === point.quiz.correctIndex && <span> — Correct answer</span>}{correct === false && selectedIndex === index && <span> — Your answer</span>}</button>)}
    </div>
    {correct !== null && <div className="aerial-quiz-feedback" role="status"><strong>{correct ? 'Correct!' : 'Not quite.'}</strong><p>{point.explanation}</p><button type="button" onClick={onRetry}>Try again</button></div>}
    {point.evidence?.length > 0 && <details className="aerial-quiz-evidence"><summary>CoStar evidence ({point.evidence.length})</summary><ul>{point.evidence.map((source, index) => <li key={index}><strong>{String(source.value)}</strong><span>{source.dataset} · record {source.recordId}</span><code>{source.path}</code>{source.origin && <span>Source: {source.origin}</span>}</li>)}</ul></details>}
    <p>{point.placementNote || (imported ? 'Position imported from JSON, relative to the property center.' : 'Training position relative to the property center; not a verified feature location.')}</p>
  </section>;
}
