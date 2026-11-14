import { normalizeQuiz } from './tagStorage.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function createTagWidget(tag) {
  const quiz = normalizeQuiz(tag.quiz);
  const completed = tag.quizResult === 'correct';
  const content = quiz ? `
    <p class="task-label">Practice question</p>
    <p class="question">${escapeHtml(quiz.question)}</p>
    <div class="answers">${quiz.options.map((option, index) => `<button type="button" class="answer" data-index="${index}" ${completed ? 'disabled' : ''}><span>${String.fromCharCode(65 + index)}</span>${escapeHtml(option)}</button>`).join('')}</div>
    <p id="feedback" class="feedback ${completed ? 'correct' : ''}" role="status">${completed ? 'Correct. This checkpoint is complete.' : 'Choose an answer.'}</p>
    <button id="reset" class="text-button" type="button">Reset question</button>` : `
    <p class="task-label">Training checkpoint</p>
    <p class="question">Review this location.</p>
    <p id="feedback" class="feedback ${tag.reviewed ? 'correct' : ''}" role="status">${tag.reviewed ? 'This checkpoint has been reviewed.' : 'When you are ready, mark this checkpoint reviewed.'}</p>
    <button id="review" class="primary" type="button">${tag.reviewed ? 'Reviewed' : 'Mark reviewed'}</button>`;

  // User-authored text is escaped above and never inserted into executable JavaScript.
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><style>
    :root{color-scheme:light;font:14px/1.5 system-ui,sans-serif;color:#292524;background:#faf8f5}
    *{box-sizing:border-box}body{margin:0;padding:16px;border-top:3px solid #b47746}
    p{margin:0}.task-label{color:#785b42;margin-bottom:8px;font-size:13px}
    .question{font-size:16px;font-weight:600;margin-bottom:16px;overflow-wrap:anywhere}
    button{font:inherit;cursor:pointer;border-radius:4px}button:focus-visible{outline:2px solid #785b42;outline-offset:2px}
    .answers{display:grid;gap:8px}.answer{display:flex;align-items:baseline;gap:12px;text-align:left;padding:10px 12px;border:1px solid #d6cdc0;background:#fffdf9;color:#433a32;overflow-wrap:anywhere}
    .answer>span{color:#8a7763;font-size:12px}.answer:hover:not(:disabled){background:#f1e9df;border-color:#a38b70}
    .answer.correct{border-color:#78916c;background:#e8efdf;color:#365032}.answer.incorrect{border-color:#c3996c;background:#f7ead8;color:#8b562c}
    .answer:disabled{cursor:default}.feedback{padding:10px 12px;margin-top:16px;background:#eee8df;border-left:2px solid #b9a58c;color:#6e5d4c;font-size:13px}
    .feedback.correct{background:#e8efdf;border-color:#78916c;color:#365032}.feedback.incorrect{background:#f7ead8;border-color:#c3996c;color:#8b562c}
    .primary{margin-top:16px;padding:9px 12px;border:1px solid #8b633e;background:#986b42;color:#fffdf8}
    .primary:hover{background:#825735}.text-button{padding:8px 0;margin-top:4px;background:none;border:0;color:#785b42;text-decoration:underline}
    @media(prefers-reduced-motion:reduce){*{transition:none}}
    </style></head><body>${content}<script>
    var feedback=document.getElementById('feedback');
    var buttons=Array.from(document.querySelectorAll('.answer'));
    var correctIndex=${quiz ? quiz.correctIndex : -1};
    buttons.forEach(function(button){button.addEventListener('click',function(){
      var index=Number(button.dataset.index);
      var correct=index===correctIndex;
      buttons.forEach(function(item){item.classList.remove('incorrect','correct');});
      button.classList.add(correct?'correct':'incorrect');
      feedback.className='feedback '+(correct?'correct':'incorrect');
      feedback.textContent=correct?'Correct. This checkpoint is complete.':'Not quite. Look around and try again.';
      if(correct)buttons.forEach(function(item){item.disabled=true;});
      window.send('answer',{selectedIndex:index});
    });});
    var reset=document.getElementById('reset');
    if(reset)reset.addEventListener('click',function(){buttons.forEach(function(item){item.disabled=false;item.classList.remove('incorrect','correct');});feedback.className='feedback';feedback.textContent='Choose an answer.';window.send('resetQuiz');});
    var review=document.getElementById('review');
    if(review)review.addEventListener('click',function(){feedback.className='feedback correct';feedback.textContent='This checkpoint has been reviewed.';review.textContent='Reviewed';window.send('review');});
    </script></body></html>`;
}
