import React, { useEffect, useState } from 'react';
import { normalizeQuiz } from './tagStorage.js';

function Question({ task, onAnswer, onReview }) {
  const quiz = normalizeQuiz(task.quiz);
  const [choice, setChoice] = useState(null);
  const answered = task.quizResult === 'answered';
  return <>
    <p className="sweep-task-title">{task.label}</p>
    {quiz ? <><p className="sweep-question-text">{quiz.question}</p><div className="sweep-answer-options">{quiz.options.map((option, index) => <button key={index} type="button" disabled={answered} aria-pressed={choice === index} className={choice === index ? 'answer-selected' : ''} onClick={() => setChoice(index)}><span>{String.fromCharCode(65+index)}</span>{option}</button>)}</div>{answered ? <p className="sweep-feedback" role="status">Answer recorded.</p> : <button className="sweep-confirm-button" type="button" disabled={choice === null} onClick={() => onAnswer(task, choice)}>Confirm</button>}</> : <><p className="sweep-question-text">{task.description || 'Review this training checkpoint.'}</p><button className="sweep-review-button" disabled={task.reviewed} onClick={() => onReview(task)}>{task.reviewed ? 'Reviewed' : 'Mark reviewed'}</button></>}
    <details className="sweep-source"><summary>Task source & location</summary><p>Imported training scenario. Floor, suite, and physical fixture mapping are unverified.</p><p>{task.importedTask.fileName}<br/><code>{task.importedTask.taskPath}</code></p><p>Assigned sweep: <code>{task.importedTask.sweepId}</code></p>{task.importedTask.evidence?.map((item,index) => <p key={index}><code>{item.path}</code>: {String(item.value)}</p>)}</details>
  </>;
}

export default function SweepQuestions({ tasks, request, onAnswer, onReview, onReset }) {
  const [selectedId, setSelectedId] = useState(() => tasks.find(task => !task.reviewed)?.id || tasks[0]?.id);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (request && tasks.some(task => task.id === request.id)) {setSelectedId(request.id);setDismissed(false);}
  }, [request]);
  const selected = tasks.find(task => task.id === selectedId) || tasks.find(task => !task.reviewed) || tasks[0];
  if (!selected || dismissed) return null;
  const index = tasks.findIndex(task => task.id === selected.id);
  return <section className="sweep-question-panel" aria-label="Question at current viewpoint">
    <div className="sweep-question-heading"><span>Question at this viewpoint{tasks.length > 1 ? ` · ${index+1} of ${tasks.length}` : ''}</span><button type="button" aria-label="Dismiss question until returning to this sweep" onClick={() => setDismissed(true)}>×</button></div>
    {tasks.length > 1 && <label className="sweep-task-select">Task<select value={selected.id} onChange={event => setSelectedId(event.target.value)}>{tasks.map(task => <option value={task.id} key={task.id}>{task.label}{task.importedTask.floorId != null ? ` (source floor ${task.importedTask.floorId})` : ''}</option>)}</select></label>}
    <Question key={selected.id} task={selected} onAnswer={onAnswer} onReview={onReview} onReset={onReset}/>
    {tasks.length > 1 && <div className="sweep-question-navigation"><button disabled={index === 0} onClick={() => setSelectedId(tasks[index-1].id)}>Previous</button><button disabled={index === tasks.length-1} onClick={() => setSelectedId(tasks[index+1].id)}>Next question</button></div>}
  </section>;
}
