/* =====================================================================
   АиГ — Теория · Письменная отработка · Экзамен по билетам
   Подключается к ядру тестов (app.js) через window.QuizCore.
   ===================================================================== */
(() => {
'use strict';

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const LS = { // прямой доступ к localStorage (нужен до init — для progressSummary)
  get(k){ try{ return localStorage.getItem('laq_'+k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem('laq_'+k,v); }catch(e){} },
  del(k){ try{ localStorage.removeItem('laq_'+k); }catch(e){} },
};

let C = null;               // ядро (QuizCore)
let T = [];                 // билеты теории
const cardById = {};        // id → {card, ticket}
const done = new Set();     // изученные карточки
const wrBest = {};          // id → лучший балл письменной отработки
let tixHist = [];           // история экзаменов по билетам
let run = null;             // текущий экзамен по билетам
let runPhotos = [];         // фото текущего экзамена (только в памяти)
const wrPhotos = {};        // cardId → фото для отработки
let clockT = null;
let access = null;            // {allowed, pending, admin} — доступ к проверке ИИ (вайтлист)

const CHAPTERS = [
  { from:1,  to:11, name:'Линейные пространства' },
  { from:12, to:21, name:'Евклидовы и унитарные пространства' },
  { from:22, to:32, name:'Линейные операторы' },
  { from:33, to:40, name:'Билинейные и квадратичные формы' },
  { from:41, to:49, name:'Операторы в евклидовых и унитарных пространствах' },
  { from:50, to:56, name:'Основы тензорной алгебры' },
];
const KIND_CLASS = { 'Определение':'k-def', 'Теорема':'k-thm', 'Свойство':'k-prop', 'Следствие':'k-cor', 'Пример':'k-ex', 'Алгоритм':'k-alg', 'Формула':'k-form', 'Замечание':'k-note' };
const GRADE_NAME = { 5:'Отлично', 4:'Хорошо', 3:'Удовлетворительно', 2:'Неудовлетворительно' };

const EXC = () => Object.assign({ tickets:2, theoryMinutes:45, testsPerTicket:6, testMinutes:12, theoryWeight:0.6, minTicketTheory:30, grade5:85, grade4:70, grade3:50 }, (C && C.CFG.exam) || {});
const apiOn = () => !!(C && C.CFG.apiUrl);
const aiOn = () => apiOn() && !!(access && access.allowed);
const e = s => C.esc(s);
const stripNum = t => String(t).replace(/^\d+\.\s*/, '');
const ticketByN = n => T.find(t => t.n === +n);
const pad = n => String(n).padStart(2, '0');
const fmtClock = s => `${pad(Math.floor(s/60))}:${pad(Math.floor(s%60))}`;

/* =====================================================================
   PROGRESS
   ===================================================================== */
function saveDone(){ const v=[...done].join(','); LS.set('thDone', v); C.Store.set('thDone', v); }
function saveWr(){ const v=Object.entries(wrBest).map(([k,s])=>k+':'+s).join(','); LS.set('wrBest', v); C.Store.set('wrBest', v); }
function saveHist(){ const v=JSON.stringify(tixHist.slice(0,10)); LS.set('tixHist', v); C.Store.set('tixHist', v); }
function parseDone(v, into){ String(v||'').split(',').filter(Boolean).forEach(id=>into.add(id)); }
function parseWr(v, into){ String(v||'').split(',').forEach(p=>{ const [k,s]=p.split(':'); if(k && s!=null){ into[k]=Math.max(into[k]||0, +s||0); } }); }

async function loadStudyProgress(){
  parseDone(LS.get('thDone'), done); parseWr(LS.get('wrBest'), wrBest);
  try{ tixHist = JSON.parse(LS.get('tixHist')||'[]'); }catch(err){ tixHist=[]; }
  try{ run = JSON.parse(LS.get('tixRun')||'null'); }catch(err){ run=null; }
  // облако Telegram: объединяем с локальным
  const [cd, cw, ch] = await Promise.all([C.Store.get('thDone'), C.Store.get('wrBest'), C.Store.get('tixHist')]);
  const before = done.size;
  parseDone(cd, done); parseWr(cw, wrBest);
  if(ch){ try{ const h=JSON.parse(ch); if(Array.isArray(h) && h.length>tixHist.length) tixHist=h; }catch(err){} }
  if(done.size!==before) LS.set('thDone', [...done].join(','));
}

function ticketStats(t){
  const total=t.cards.length, d=t.cards.filter(c=>done.has(c.id)).length;
  const ws=t.cards.map(c=>wrBest[c.id]).filter(v=>v!=null);
  return { total, done:d, wr: ws.length ? Math.round(ws.reduce((a,b)=>a+b,0)/ws.length) : null };
}

/* =====================================================================
   THEORY — список билетов
   ===================================================================== */
let thQuery = '';
function renderTheoryList(){
  const host=$('#thList');
  if(!T.length){ host.innerHTML='<div class="data-note">Не удалось загрузить теорию (data/theory.json).</div>'; return; }
  const total=Object.keys(cardById).length, d=[...done].filter(id=>cardById[id]).length;
  const pct = total ? Math.round(d/total*100) : 0;
  host.innerHTML = `
    <div class="th-head">
      <div class="th-head-top">
        <div><div class="th-h1">Теория по билетам</div>
        <div class="th-sub">Учите карточки → отработка письменно и тестами → экзамен</div></div>
        <div class="th-pct">${pct}%</div>
      </div>
      <div class="th-bar"><i style="width:${pct}%"></i></div>
      <div class="th-meta">Изучено ${d} из ${total} карточек · ${T.length} билетов</div>
    </div>
    <div class="search-wrap th-search">
      <svg class="search-i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
      <input id="thSearch" class="search" type="text" placeholder="Поиск по билетам и теоремам…" autocomplete="off" value="${e(thQuery)}">
    </div>
    <div id="thRows"></div>`;
  const inp=$('#thSearch');
  inp.addEventListener('input', ()=>{ thQuery=inp.value; renderTheoryRows(); });
  renderTheoryRows();
}
function renderTheoryRows(){
  const q=thQuery.trim().toLowerCase();
  const match = t => !q || t.title.toLowerCase().includes(q) || String(t.n)===q ||
    t.cards.some(c => (c.title+' '+c.text).toLowerCase().includes(q));
  let html='';
  CHAPTERS.forEach(ch=>{
    const list=T.filter(t=>t.n>=ch.from && t.n<=ch.to && match(t));
    if(!list.length) return;
    html+=`<div class="th-chapter">${e(ch.name)} <span>${ch.from}–${ch.to}</span></div>`;
    list.forEach(t=>{
      const s=ticketStats(t); const p=s.total?Math.round(s.done/s.total*100):0;
      html+=`<button class="th-row ${s.done===s.total?'complete':''}" data-n="${t.n}">
        <span class="th-num">${t.n}</span>
        <span class="th-row-main">
          <span class="th-row-title">${e(stripNum(t.title))}</span>
          <span class="th-row-meta">${s.total} карт. · изучено ${s.done}${s.wr!=null?` · письменно ${s.wr}%`:''}</span>
          <span class="th-mini"><i style="width:${p}%"></i></span>
        </span>
        <span class="th-go">›</span></button>`;
    });
  });
  const rows=$('#thRows');
  rows.innerHTML = html || '<div class="data-note">Ничего не найдено.</div>';
  rows.onclick = ev => { const b=ev.target.closest('.th-row'); if(b){ openTicket(+b.dataset.n); C.haptic(); } };
}

/* =====================================================================
   THEORY — страница билета
   ===================================================================== */
function cardHtml(c, opts={}){
  const isDone=done.has(c.id);
  return `<article class="th-card ${isDone?'done':''}" id="thc-${e(c.id)}" data-id="${e(c.id)}">
    <div class="th-card-head">
      <span class="th-kind ${KIND_CLASS[c.kind]||''}">${e(c.kind)}</span>
      <span class="th-card-title">${e(c.title)}</span>
      <span class="th-check">${isDone?'✓':''}</span>
    </div>
    <div class="th-body">
      <div class="th-text">${e(c.text)}</div>
      ${c.proof ? `<details class="th-proof" ${opts.openProof?'open':''}><summary>Доказательство</summary><div class="th-text">${e(c.proof)}</div></details>` : ''}
      ${(c.keyPoints||[]).length ? `<div class="th-keys"><div class="th-keys-title">Что обязательно написать</div><ul>${c.keyPoints.map(k=>`<li>${e(k)}</li>`).join('')}</ul></div>` : ''}
      ${c.note ? `<div class="th-note">ℹ️ ${e(c.note)}</div>` : ''}
    </div>
    ${opts.foot===false ? '' : `<div class="th-card-foot">
      ${wrBest[c.id]!=null ? `<span class="th-wr">✍️ ${wrBest[c.id]}%</span>` : '<span></span>'}
      <button class="btn small ${isDone?'ghost':'primary'} th-done-btn" data-id="${e(c.id)}">${isDone?'✓ Изучено':'Отметить изученным'}</button>
    </div>`}
  </article>`;
}

function openTicket(n, cardId){
  const t=ticketByN(n); if(!t) return;
  const s=ticketStats(t);
  const qCount=C.App.questions.filter(q=>+C.topicNum(q.topic)===t.n).length;
  const host=$('#thTicket');
  const idx=T.indexOf(t), prev=T[idx-1], next=T[idx+1];
  host.innerHTML = `
    <button class="th-back" data-act="back">‹ Все билеты</button>
    <div class="th-ticket-head">
      <span class="th-num big">${t.n}</span>
      <div><div class="th-ticket-title">${e(stripNum(t.title))}</div>
      <div class="th-sub">${s.total} карточек · изучено ${s.done}</div></div>
    </div>
    <div class="th-actions">
      <button class="btn ghost small" data-act="recall">🙈 Проверить себя</button>
      <button class="btn ghost small" data-act="write">✍️ Письменно</button>
      <button class="btn ghost small" data-act="tests">🧩 Тесты (${qCount})</button>
    </div>
    <div class="th-recall-hint hidden">Тексты скрыты: вспомните формулировку и доказательство, затем нажмите на карточку, чтобы проверить себя.</div>
    <div class="th-cards">${t.cards.map(c=>cardHtml(c)).join('')}</div>
    <div class="th-pager">
      ${prev?`<button class="btn ghost small" data-go="${prev.n}">‹ Билет ${prev.n}</button>`:'<span></span>'}
      ${next?`<button class="btn ghost small" data-go="${next.n}">Билет ${next.n} ›</button>`:'<span></span>'}
    </div>`;
  $('#thList').classList.add('hidden'); host.classList.remove('hidden');
  host.onclick = ev => {
    const act=ev.target.closest('[data-act]'); const go=ev.target.closest('[data-go]');
    const doneBtn=ev.target.closest('.th-done-btn');
    if(doneBtn){ toggleDone(doneBtn.dataset.id); return; }
    if(go){ openTicket(+go.dataset.go); return; }
    if(act){
      const a=act.dataset.act;
      if(a==='back'){ closeTicket(); }
      else if(a==='recall'){ const on=host.classList.toggle('recall'); $('.th-recall-hint',host).classList.toggle('hidden',!on); act.textContent=on?'👁 Показать всё':'🙈 Проверить себя'; $$('.th-card',host).forEach(c=>c.classList.remove('reveal')); }
      else if(a==='write'){ openWriting(t.n); }
      else if(a==='tests'){ openTests(t.n); }
      C.haptic(); return;
    }
    const card=ev.target.closest('.th-card');
    if(card && host.classList.contains('recall') && !ev.target.closest('details')) card.classList.toggle('reveal');
  };
  scrollViewTop(host);
  if(cardId){ const el=document.getElementById('thc-'+cardId); if(el) setTimeout(()=>el.scrollIntoView({block:'start', behavior:'smooth'}), 60); }
}
function closeTicket(){ $('#thTicket').classList.add('hidden'); $('#thTicket').classList.remove('recall'); $('#thList').classList.remove('hidden'); renderTheoryList(); }
function toggleDone(id){
  if(done.has(id)) done.delete(id); else done.add(id);
  saveDone(); C.haptic(done.has(id)?'ok':undefined);
  const el=document.getElementById('thc-'+id);
  const info=cardById[id];
  if(el && info){ el.outerHTML=cardHtml(info.card); }
  const t=info && info.ticket; if(t){ const s=ticketStats(t); const sub=$('#thTicket .th-sub'); if(sub) sub.textContent=`${s.total} карточек · изучено ${s.done}`; }
}
function scrollViewTop(el){ const v=el.closest('.view'); if(v) v.scrollTop=0; }

/* =====================================================================
   PRACTICE — переключатель «Тесты / Письменно»
   ===================================================================== */
let seg='tests';
function setSeg(s){
  seg=s; LS.set('prSeg', s);
  $$('#prSeg .seg-btn').forEach(b=>b.classList.toggle('active', b.dataset.seg===s));
  $('#prTests').classList.toggle('hidden', s!=='tests');
  $('#prWrite').classList.toggle('hidden', s!=='write');
  if(s==='write') renderWriting();
}
function openTests(n){
  C.switchView('all'); setSeg('tests');
  const q=C.App.questions.find(x=>+C.topicNum(x.topic)===+n);
  C.deck.topic = q ? q.topic : 'all';
  const sel=$('#topicSel'); if(sel) sel.value=C.deck.topic;
  C.updateFilterLabel(); C.rebuildDeck(false);
}
function openWriting(n){ if(n) LS.set('wrTicket', String(n)); C.switchView('all'); setSeg('write'); }

/* =====================================================================
   PRACTICE — письменная отработка
   ===================================================================== */
function renderWriting(){
  const host=$('#prWrite');
  if(!T.length){ host.innerHTML='<div class="data-note">Теория не загружена.</div>'; return; }
  let n=+(LS.get('wrTicket')||T[0].n); if(!ticketByN(n)) n=T[0].n;
  const t=ticketByN(n);
  host.innerHTML = `
    <div class="wr-top">
      <select class="match-sel" id="wrSel">${T.map(x=>`<option value="${x.n}" ${x.n===n?'selected':''}>${e(x.title)}</option>`).join('')}</select>
    </div>
    <div class="wr-hint">Напишите ответ по памяти — текстом здесь или от руки на листке (📷 фото). Затем сверьтесь с эталоном${aiOn()?' или отдайте на проверку ИИ':''}.</div>
    ${accessBanner()}
    <div class="wr-cards">${t.cards.map(c=>wrCardHtml(c)).join('')}</div>
    <div class="th-pager"><button class="btn ghost small" data-open-theory="${t.n}">📖 Теория билета ${t.n}</button><span></span></div>`;
  $('#wrSel').onchange = ev => { LS.set('wrTicket', ev.target.value); renderWriting(); scrollViewTop(host); };
  host.onclick = onWritingClick;
  host.oninput = ev => { const ta=ev.target.closest('.wr-input'); if(ta) LS.set('wd_'+ta.dataset.id, ta.value); };
  host.onchange = async ev => {
    const inp=ev.target.closest('input[type=file][data-photo-for]'); if(!inp) return;
    const id=inp.dataset.photoFor; const files=[...inp.files]; inp.value='';
    wrPhotos[id]=wrPhotos[id]||[];
    for(const f of files){ try{ wrPhotos[id].push(await compressImage(f)); }catch(err){ C.toast('Не удалось прочитать фото'); } }
    renderThumbs($(`.wr-card[data-id="${cssq(id)}"] .wr-thumbs`), wrPhotos[id]);
  };
}
function wrCardHtml(c){
  const best=wrBest[c.id];
  return `<div class="wr-card" data-id="${e(c.id)}">
    <div class="wr-prompt"><span class="th-kind ${KIND_CLASS[c.kind]||''}">${e(c.kind)}</span>${best!=null?`<span class="wr-best">лучший ${best}%</span>`:''}</div>
    <div class="wr-q">${e(c.prompt || c.title)}</div>
    <textarea class="wr-input" data-id="${e(c.id)}" rows="5" placeholder="Ваш ответ…">${e(LS.get('wd_'+c.id)||'')}</textarea>
    <div class="wr-thumbs"></div>
    <div class="wr-btns">
      <label class="btn ghost small">📷 Фото<input type="file" accept="image/*" multiple hidden data-photo-for="${e(c.id)}"></label>
      <button class="btn ghost small" data-act="ref" data-id="${e(c.id)}">Сверить с эталоном</button>
      ${aiOn()?`<button class="btn primary small" data-act="ai" data-id="${e(c.id)}">🤖 Проверить ИИ</button>`:''}
    </div>
    <div class="wr-result"></div>
  </div>`;
}
function cssq(s){ return String(s).replace(/"/g,'\\"'); }

async function onWritingClick(ev){
  const ot=ev.target.closest('[data-open-theory]');
  if(ot){ C.switchView('theory'); openTicket(+ot.dataset.openTheory); return; }
  const rm=ev.target.closest('[data-rm]');
  if(rm){ const box=rm.closest('.wr-card'); const id=box.dataset.id; wrPhotos[id].splice(+rm.dataset.rm,1); renderThumbs($('.wr-thumbs',box), wrPhotos[id]); return; }
  const b=ev.target.closest('[data-act]'); if(!b) return;
  const id=b.dataset.id; const info=cardById[id]; if(!info) return;
  const box=b.closest('.wr-card'); const out=$('.wr-result', box);
  if(b.dataset.act==='ref'){
    const c=info.card;
    out.innerHTML = `<div class="wr-ref">
      <div class="wr-ref-title">Эталон</div>
      <div class="th-text">${e(c.text)}</div>
      ${c.proof?`<details class="th-proof"><summary>Доказательство</summary><div class="th-text">${e(c.proof)}</div></details>`:''}
      <div class="wr-ref-title" style="margin-top:12px">Отметьте, что есть в вашем ответе</div>
      <div class="kp-list">${(c.keyPoints||[]).map((k,i)=>`<label class="kp"><input type="checkbox" data-kp="${i}"><span>${e(k)}</span></label>`).join('')}</div>
      <button class="btn primary small" data-act="selfscore" data-id="${e(id)}">Засчитать</button>
    </div>`;
    C.haptic(); return;
  }
  if(b.dataset.act==='selfscore'){
    const kps=$$('input[data-kp]', box); const n=kps.filter(x=>x.checked).length;
    const score=kps.length?Math.round(n/kps.length*100):0;
    setBest(id, score);
    out.innerHTML = resultHtml({ score, missing: kps.filter(x=>!x.checked).map(x=>x.nextElementSibling.textContent), errors:[], comment:'Самопроверка по ключевым пунктам.' });
    refreshBest(box, id); C.haptic(score>=70?'ok':'err'); return;
  }
  if(b.dataset.act==='ai'){
    const ta=$('.wr-input', box); const photos=wrPhotos[id]||[];
    if(!ta.value.trim() && !photos.length){ C.toast('Напишите ответ или добавьте фото'); return; }
    b.disabled=true; out.innerHTML=''; out.appendChild(loadingEl(['Читаю ответ…','Сверяю с лекцией…','Проверяю формулировки…']));
    try{
      const res=await gradeApi({ mode:'practice', cards:[id], text:ta.value, images:photos.map(p=>({media_type:p.media_type, data:p.data})) });
      const t=(res.tickets||[])[0] || { score:0, missing:[], errors:[], comment:res.summary };
      if(res.legible===false){ out.innerHTML=`<div class="wr-err">📷 ${e(res.summary||'Не удалось прочитать ответ')}</div>`; }
      else { setBest(id, t.score); out.innerHTML=resultHtml(t); refreshBest(box, id); C.haptic(t.score>=70?'ok':'err'); }
    }catch(err){ out.innerHTML=`<div class="wr-err">⚠️ ${e(err.message)}</div>`; }
    b.disabled=false;
  }
}
function setBest(id, score){ wrBest[id]=Math.max(wrBest[id]||0, score); saveWr(); }
function refreshBest(box, id){ const p=$('.wr-prompt', box); let s=$('.wr-best', p); if(!s){ s=document.createElement('span'); s.className='wr-best'; p.appendChild(s); } s.textContent=`лучший ${wrBest[id]}%`; }
function scoreClass(s){ return s>=85?'s-hi':s>=60?'s-mid':'s-lo'; }
function resultHtml(t){
  return `<div class="wr-res">
    <div class="wr-score ${scoreClass(t.score)}">${t.score}%</div>
    ${t.comment?`<div class="wr-comment">${e(t.comment)}</div>`:''}
    ${(t.missing||[]).length?`<div class="wr-list miss"><b>Не хватает:</b><ul>${t.missing.map(m=>`<li>${e(m)}</li>`).join('')}</ul></div>`:''}
    ${(t.errors||[]).length?`<div class="wr-list err"><b>Ошибки:</b><ul>${t.errors.map(m=>`<li>${e(m)}</li>`).join('')}</ul></div>`:''}
  </div>`;
}

/* =====================================================================
   PHOTOS + API
   ===================================================================== */
async function compressImage(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; });
    const max=1600; const k=Math.min(1, max/Math.max(img.naturalWidth, img.naturalHeight));
    const w=Math.round(img.naturalWidth*k), h=Math.round(img.naturalHeight*k);
    const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
    const ctx=cv.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h); ctx.drawImage(img,0,0,w,h);
    const dataUrl=cv.toDataURL('image/jpeg', 0.82);
    return { media_type:'image/jpeg', data:dataUrl.split(',')[1], url:dataUrl };
  } finally { URL.revokeObjectURL(url); }
}
function renderThumbs(host, list){
  if(!host) return;
  host.innerHTML = (list||[]).map((p,i)=>`<div class="thumb"><img src="${p.url}" alt="лист ${i+1}"><button data-rm="${i}" aria-label="Удалить">✕</button><span>${i+1}</span></div>`).join('');
}
async function gradeApi(payload){
  const url=String(C.CFG.apiUrl||'').replace(/\/+$/,'')+'/api/grade';
  const body=JSON.stringify(Object.assign({ initData:(C.TG && C.TG.initData)||'' }, payload));
  let r;
  try{ r=await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body }); }
  catch(err){ throw new Error('Нет связи с сервером проверки'); }
  let j=null; try{ j=await r.json(); }catch(err){}
  if(!r.ok || !j){
    const er=new Error((j && j.error) || `Ошибка сервера проверки (${r.status})`); er.code=j && j.code;
    if(er.code==='no_access' && access){ access.allowed=false; setTimeout(refreshAccessUi, 50); }
    throw er;
  }
  return j;
}
function loadingEl(msgs){
  const el=document.createElement('div'); el.className='ai-loading';
  el.innerHTML='<span class="spinner"></span><span class="ai-msg"></span>';
  let i=0; const m=$('.ai-msg',el); m.textContent=msgs[0];
  const t=setInterval(()=>{ if(!el.isConnected){ clearInterval(t); return; } i=(i+1)%msgs.length; m.textContent=msgs[i]; }, 3500);
  return el;
}

/* =====================================================================
   EXAM BY TICKETS
   ===================================================================== */
function saveRun(){ if(run) LS.set('tixRun', JSON.stringify(run)); else LS.del('tixRun'); }

function renderTixIntro(){
  const host=$('#tixIntro'); if(!host) return;
  const X=EXC(); const wT=Math.round(X.theoryWeight*100);
  host.innerHTML = `
    <div class="exam-hero">
      <div class="exam-hero-icon">🎓</div>
      <h2>Экзамен по билетам</h2>
      <p>${X.tickets} билета · теория письменно · тесты · оценка</p>
    </div>
    <ol class="tix-steps">
      <li><b>Билеты.</b> Выпадает ${X.tickets} случайных билета из ${T.length}.</li>
      <li><b>Теория.</b> Пишете ответы на листке (ориентир ${X.theoryMinutes} мин), фотографируете и отправляете${aiOn()?' — ИИ проверяет как экзаменатор':' — сверяете с эталоном'}.</li>
      <li><b>Тесты.</b> По ${X.testsPerTicket} вопросов на билет, ${X.testMinutes} минут.</li>
      <li><b>Оценка.</b> ${wT}% теория + ${100-wT}% тесты → «2»–«5».</li>
    </ol>
    ${apiOn()?accessBanner():'<div class="tix-warn">Проверка ИИ не подключена (apiUrl в assets/config.js) — теория оценивается самопроверкой.</div>'}
    <button class="btn primary big" id="tixStartBtn">Вытянуть билеты</button>
    <details class="tix-manual">
      <summary>Выбрать билеты вручную</summary>
      <div class="tix-manual-body">
        ${Array.from({length:X.tickets},(_,i)=>`<select class="match-sel tix-pick">${T.map(t=>`<option value="${t.n}">${e(t.title)}</option>`).join('')}</select>`).join('')}
        <button class="btn ghost" id="tixManualBtn">Начать с этими билетами</button>
      </div>
    </details>
    <div id="tixHistHost" class="exam-history"></div>`;
  $('#tixStartBtn').onclick=()=>{ const pool=C.shuffle(T.map(t=>t.n)); startTix(pool.slice(0, X.tickets)); };
  $('#tixManualBtn').onclick=()=>{ const ns=[...new Set($$('.tix-pick').map(s=>+s.value))]; if(ns.length<X.tickets){ C.toast('Выберите разные билеты'); return; } startTix(ns); };
  renderTixHistory();
}
function renderTixHistory(){
  const host=$('#tixHistHost'); if(!host) return;
  if(!tixHist.length){ host.innerHTML=''; return; }
  host.innerHTML = '<h4>Экзамены по билетам · нажми — разбор</h4>' + tixHist.map((h,i)=>`
    <div class="hist-row clickable" data-i="${i}" role="button">
      <span>Билеты ${h.t.join(', ')} · теория ${h.th}% · тесты ${h.te}% <span class="hist-more">›</span></span>
      <span class="hist-score ${h.g>=3?'pass':'fail'}">${h.g}</span>
    </div>`).join('');
  host.onclick = ev => {
    const row=ev.target.closest('.hist-row'); if(!row) return;
    const h=tixHist[+row.dataset.i]; let d=null; try{ d=JSON.parse(LS.get('tixd'+h.ts)||'null'); }catch(err){}
    if(!d){ C.toast('Подробный разбор хранится только на устройстве, где сдавался экзамен'); return; }
    showRunPane(); renderTixResult(d); C.haptic();
  };
}

function startTix(nums){
  run = { ts:Date.now(), tickets:nums, stage:'theory', theoryStart:Date.now(), theory:null, tests:null };
  runPhotos=[]; saveRun(); showRunPane(); renderRun(); C.haptic();
}
function showRunPane(){
  $('#examIntro').classList.add('hidden'); $('#examRun').classList.add('hidden'); $('#examResult').classList.add('hidden');
  $('#tixRun').classList.remove('hidden'); scrollViewTop($('#tixRun'));
}
function showIntroPane(){
  clearInterval(clockT);
  $('#tixRun').classList.add('hidden'); $('#examIntro').classList.remove('hidden');
  renderTixIntro(); scrollViewTop($('#examIntro'));
}
function abortTix(){ if(!confirm('Прервать экзамен? Результат не сохранится.')) return; run=null; runPhotos=[]; saveRun(); showIntroPane(); }

function renderRun(){
  clearInterval(clockT);
  if(!run){ showIntroPane(); return; }
  if(run.stage==='theory') return renderTheoryStage();
  if(run.stage==='tests') return renderTestsStage();
}

/* ---- шаг 1: теория ---- */
function renderTheoryStage(){
  const X=EXC(); const host=$('#tixRun');
  const tickets=run.tickets.map(ticketByN).filter(Boolean);
  host.innerHTML = `
    <div class="tix-bar">
      <span class="tix-stage">Шаг 1 из 2 · Теория</span>
      <span class="tix-clock" id="tixClock">00:00</span>
      <button class="btn danger-ghost small" data-act="abort">Прервать</button>
    </div>
    ${tickets.map(t=>`<div class="tix-ticket">
      <div class="tix-ticket-n">Билет № ${t.n}</div>
      <div class="tix-ticket-title">${e(stripNum(t.title))}</div>
      <ul class="tix-points">${t.cards.map(c=>`<li>${e(c.kind)}: ${e(c.title)}</li>`).join('')}</ul>
    </div>`).join('')}
    ${run.theory ? '' : `
    <div class="tix-photo-box">
      <div class="tix-photo-title">📷 Фото листков с ответом</div>
      <div class="data-note">Пишите разборчиво, в начале ответа укажите номер билета. Можно несколько листов (до 8).</div>
      <div class="wr-thumbs" id="tixThumbs"></div>
      <label class="btn ghost">＋ Добавить фото<input type="file" accept="image/*" multiple hidden id="tixFile"></label>
    </div>
    <div class="tix-send">
      ${aiOn()?'<button class="btn primary big" data-act="send">🤖 Отправить на проверку</button>':accessBanner()}
      <button class="btn ${aiOn()?'ghost':'primary'} big" data-act="self">Самопроверка по эталону</button>
    </div>`}
    <div id="tixTheoryOut"></div>`;
  renderThumbs($('#tixThumbs'), runPhotos);
  const clock=$('#tixClock'); const limit=X.theoryMinutes*60;
  const tick=()=>{ const s=(Date.now()-run.theoryStart)/1000; clock.textContent=`${fmtClock(s)} / ${fmtClock(limit)}`; clock.classList.toggle('warn', s>limit); };
  tick(); clockT=setInterval(tick, 1000);
  if(run.theory) renderTheoryVerdict();

  host.onchange = async ev => {
    if(ev.target.id!=='tixFile') return;
    const files=[...ev.target.files]; ev.target.value='';
    for(const f of files){ if(runPhotos.length>=8) break; try{ runPhotos.push(await compressImage(f)); }catch(err){ C.toast('Не удалось прочитать фото'); } }
    renderThumbs($('#tixThumbs'), runPhotos);
  };
  host.onclick = async ev => {
    const rm=ev.target.closest('[data-rm]'); if(rm){ runPhotos.splice(+rm.dataset.rm,1); renderThumbs($('#tixThumbs'), runPhotos); return; }
    const b=ev.target.closest('[data-act]'); if(!b) return;
    const a=b.dataset.act;
    if(a==='abort') return abortTix();
    if(a==='send') return sendTheory(b);
    if(a==='self') return renderSelfCheck();
    if(a==='selfdone') return finishSelfCheck();
    if(a==='totests') return startTestsStage();
    if(a==='retry'){ run.theory=null; saveRun(); renderTheoryStage(); return; }
  };
}
async function sendTheory(btn){
  if(!runPhotos.length){ C.toast('Добавьте фото листков с ответом'); return; }
  const out=$('#tixTheoryOut'); $$('.tix-send button').forEach(x=>x.disabled=true);
  out.innerHTML=''; out.appendChild(loadingEl(['Загружаю листы…','Читаю почерк…','Сверяю с лекциями…','Проверяю доказательства…','Считаю баллы…']));
  out.scrollIntoView({block:'center', behavior:'smooth'});
  try{
    const res=await gradeApi({ mode:'exam', tickets:run.tickets, images:runPhotos.map(p=>({media_type:p.media_type, data:p.data})) });
    if(res.legible===false){
      out.innerHTML=`<div class="wr-err">📷 ${e(res.summary||'Не удалось прочитать ответ. Переснимите листы при хорошем освещении.')}</div>`;
      $$('.tix-send button').forEach(x=>x.disabled=false); return;
    }
    run.theory = { src:'ai', summary:res.summary||'', tickets:res.tickets.map(t=>({ n:t.n, score:t.score, cards:t.cards||[], missing:t.missing||[], errors:t.errors||[], comment:t.comment||'' })) };
    saveRun(); renderTheoryStage(); C.haptic('ok');
  }catch(err){
    out.innerHTML=`<div class="wr-err">⚠️ ${e(err.message)}<br>Можно попробовать ещё раз или выбрать самопроверку.</div>`;
    $$('.tix-send button').forEach(x=>x.disabled=false);
  }
}
function renderSelfCheck(){
  const out=$('#tixTheoryOut');
  const tickets=run.tickets.map(ticketByN).filter(Boolean);
  out.innerHTML = `<div class="tix-self-note">Сравните свой листок с эталоном и честно отметьте пункты, которые у вас есть.</div>` +
    tickets.map(t=>`<div class="tix-self" data-n="${t.n}">
      <div class="tix-ticket-n">Билет № ${t.n}</div>
      ${t.cards.map(c=>`<div class="tix-self-card">
        <details><summary><span class="th-kind ${KIND_CLASS[c.kind]||''}">${e(c.kind)}</span> ${e(c.title)}</summary>
          <div class="th-text">${e(c.text)}</div>${c.proof?`<div class="wr-ref-title">Доказательство</div><div class="th-text">${e(c.proof)}</div>`:''}
        </details>
        <div class="kp-list">${(c.keyPoints||[]).map(k=>`<label class="kp"><input type="checkbox" data-n="${t.n}" data-card="${e(c.id)}"><span>${e(k)}</span></label>`).join('')}</div>
      </div>`).join('')}
    </div>`).join('') +
    `<button class="btn primary big" data-act="selfdone">Подтвердить самооценку</button>`;
  out.scrollIntoView({block:'start', behavior:'smooth'});
}
function finishSelfCheck(){
  run.theory = { src:'self', summary:'Самопроверка по ключевым пунктам.', tickets: run.tickets.map(n=>{
    const boxes=$$(`#tixTheoryOut input[data-n="${n}"]`);
    const got=boxes.filter(b=>b.checked).length;
    const t=ticketByN(n);
    const cards=t.cards.map(c=>{ const bs=boxes.filter(b=>b.dataset.card===c.id); const k=bs.filter(b=>b.checked).length;
      return { id:c.id, status: !bs.length ? 'missing' : k===bs.length ? 'full' : k>0 ? 'partial' : 'missing' }; });
    return { n, score: boxes.length?Math.round(got/boxes.length*100):0, cards, missing: boxes.filter(b=>!b.checked).map(b=>b.nextElementSibling.textContent), errors:[], comment:'' };
  }) };
  saveRun(); renderTheoryStage();
}
function renderTheoryVerdict(){
  const out=$('#tixTheoryOut');
  out.innerHTML = `<div class="tix-verdict">
    <div class="wr-ref-title">${run.theory.src==='ai'?'🤖 Проверка теории':'Самопроверка теории'}</div>
    ${run.theory.summary?`<div class="wr-comment">${e(run.theory.summary)}</div>`:''}
    ${run.theory.tickets.map(ticketFeedbackHtml).join('')}
    <button class="btn primary big" data-act="totests">Перейти к тестам →</button>
    ${run.theory.src==='ai'?'<button class="btn ghost big" data-act="retry">Переснять и проверить заново</button>':''}
  </div>`;
}
function ticketFeedbackHtml(t){
  const tk=ticketByN(t.n);
  const title=cid=>{ const info=cardById[cid]; return info?info.card.title:cid; };
  const icon={full:'✓', partial:'◐', missing:'✕'};
  return `<div class="review-item ${t.score>=60?'ok':'no'}">
    <div class="tix-fb-head"><span>Билет № ${t.n}. ${e(tk?stripNum(tk.title):'')}</span><span class="wr-score ${scoreClass(t.score)}">${t.score}%</span></div>
    ${(t.cards||[]).length?`<div class="tix-chips">${t.cards.map(c=>`<span class="tix-chip st-${e(c.status)}">${icon[c.status]||''} ${e(title(c.id))}</span>`).join('')}</div>`:''}
    ${t.comment?`<div class="wr-comment">${e(t.comment)}</div>`:''}
    ${(t.missing||[]).length?`<div class="wr-list miss"><b>Не хватает:</b><ul>${t.missing.map(m=>`<li>${e(m)}</li>`).join('')}</ul></div>`:''}
    ${(t.errors||[]).length?`<div class="wr-list err"><b>Ошибки:</b><ul>${t.errors.map(m=>`<li>${e(m)}</li>`).join('')}</ul></div>`:''}
    <button class="btn ghost small" data-theory-link="${t.n}">📖 Теория билета ${t.n}</button>
  </div>`;
}

/* ---- шаг 2: тесты ---- */
function startTestsStage(){
  const X=EXC(); const ids=[];
  run.tickets.forEach(n=>{
    const pool=C.App.questions.filter(q=>+C.topicNum(q.topic)===+n);
    C.shuffle(pool).slice(0, X.testsPerTicket).forEach(q=>ids.push(q.id));
  });
  run.stage='tests';
  run.tests={ ids: C.shuffle(ids), state:{}, pos:0, endTs: Date.now()+X.testMinutes*60*1000 };
  saveRun(); renderRun(); scrollViewTop($('#tixRun'));
}
function renderTestsStage(){
  const host=$('#tixRun'); const tt=run.tests;
  const qs=tt.ids.map(id=>C.App.byId[id]).filter(Boolean);
  if(!qs.length){ finishTests(true); return; }
  host.innerHTML = `
    <div class="tix-bar">
      <span class="tix-stage">Шаг 2 из 2 · Тесты</span>
      <span class="tix-clock" id="tixClock">00:00</span>
      <button class="btn danger small" data-act="finish">Завершить</button>
    </div>
    <div class="exam-progress"><div id="tixProg" class="exam-progress-bar"></div></div>
    <div id="tixCardHost" class="card-host"></div>
    <div class="deck-nav">
      <button class="nav-btn" data-act="prev"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div class="exam-dots" id="tixDots">${qs.map((q,i)=>`<button class="edot" data-i="${i}"></button>`).join('')}</div>
      <button class="nav-btn" data-act="next"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>
    </div>`;
  const clock=$('#tixClock');
  const tick=()=>{ const left=Math.max(0, Math.round((tt.endTs-Date.now())/1000)); clock.textContent=fmtClock(left); clock.classList.toggle('warn', left<=120 && left>30); clock.classList.toggle('crit', left<=30); if(left<=0) finishTests(true); };
  tick(); clockT=setInterval(tick, 1000);
  const show=()=>{
    const q=qs[tt.pos]; tt.state[q.id]=tt.state[q.id]||{};
    C.renderCard(q, $('#tixCardHost'), 'exam', tt.state[q.id]);
    $('#tixProg').style.width=((tt.pos+1)/qs.length*100)+'%';
    dots();
  };
  const dots=()=>$$('#tixDots .edot').forEach((d,i)=>{ const q=qs[i]; d.classList.toggle('current', i===tt.pos); d.classList.toggle('answered', !C.evalExamQuestion(q, tt.state[q.id]||{}).empty); });
  const go=dir=>{ const np=tt.pos+dir; if(np<0||np>=qs.length) return; tt.pos=np; show(); saveRun(); };
  host.onclick = ev => {
    const d=ev.target.closest('.edot'); if(d){ tt.pos=+d.dataset.i; show(); saveRun(); return; }
    const b=ev.target.closest('[data-act]');
    if(b){ if(b.dataset.act==='prev') go(-1); else if(b.dataset.act==='next') go(1); else if(b.dataset.act==='finish') finishTests(false); return; }
    setTimeout(()=>{ dots(); saveRun(); }, 0);
  };
  host.oninput = host.onchange = () => setTimeout(()=>{ dots(); saveRun(); }, 0);
  show();
}
function finishTests(auto){
  if(!run || run.stage!=='tests') return;
  const tt=run.tests; const qs=tt.ids.map(id=>C.App.byId[id]).filter(Boolean);
  if(!auto){ const un=qs.filter(q=>C.evalExamQuestion(q, tt.state[q.id]||{}).empty).length; if(un>0 && !confirm(`Без ответа: ${un}. Завершить тесты?`)) return; }
  clearInterval(clockT);
  let correct=0; const items=[];
  qs.forEach(q=>{ const st=tt.state[q.id]||{}; const r=C.evalExamQuestion(q, st); if(r.ok) correct++;
    items.push({ id:q.id, ok:r.ok?1:0, e:r.empty?1:0, ua: r.ok||r.empty ? '' : String(C.describeAnswer(q, st)).slice(0,120) });
    C.App.stats.answered++; if(r.ok){ C.App.stats.correct++; C.setLearned(q,true); } });
  C.saveProgress();

  const X=EXC();
  const th=run.theory ? run.theory.tickets : run.tickets.map(n=>({n, score:0, cards:[], missing:[], errors:[], comment:''}));
  const theoryPct=Math.round(th.reduce((a,t)=>a+t.score,0)/Math.max(1,th.length));
  const testsPct=qs.length?Math.round(correct/qs.length*100):0;
  const finalPct=Math.round(X.theoryWeight*theoryPct + (1-X.theoryWeight)*testsPct);
  const failTicket=th.find(t=>t.score<X.minTicketTheory);
  let grade = finalPct>=X.grade5?5 : finalPct>=X.grade4?4 : finalPct>=X.grade3?3 : 2;
  if(failTicket) grade=2;
  const detail={ ts:run.ts, tickets:run.tickets, theory:run.theory || {src:'none', tickets:th}, items, correct, total:qs.length, theoryPct, testsPct, finalPct, grade, failTicket: failTicket?failTicket.n:null, src: run.theory?run.theory.src:'none' };
  LS.set('tixd'+run.ts, JSON.stringify(detail));
  tixHist.unshift({ ts:run.ts, t:run.tickets, th:theoryPct, te:testsPct, f:finalPct, g:grade, src:detail.src });
  tixHist.slice(10).forEach(h=>LS.del('tixd'+h.ts));
  tixHist=tixHist.slice(0,10); saveHist();
  run=null; runPhotos=[]; saveRun();
  renderTixResult(detail); C.haptic(grade>=3?'ok':'err');
}

/* ---- результат ---- */
function renderTixResult(d){
  clearInterval(clockT);
  const host=$('#tixRun'); const X=EXC();
  const wT=Math.round(X.theoryWeight*100);
  const items=d.items.map(it=>({...it, q:C.App.byId[it.id]})).filter(it=>it.q);
  host.innerHTML = `
    <div class="result-hero ${d.grade>=3?'pass':'fail'}">
      <div class="result-score">${d.grade}</div>
      <div class="result-sub">${GRADE_NAME[d.grade]} · билеты ${d.tickets.join(' и ')}</div>
      <div class="result-meta"><span>📝 Теория ${d.theoryPct}%</span><span>🧩 Тесты ${d.correct}/${d.total}</span><span>Σ ${d.finalPct}%</span></div>
    </div>
    <div class="tix-formula">Итог = ${wT}% × теория + ${100-wT}% × тесты. «5» от ${X.grade5}%, «4» от ${X.grade4}%, «3» от ${X.grade3}%.${d.failTicket?` <b>Билет № ${d.failTicket} раскрыт меньше чем на ${X.minTicketTheory}% — оценка «2».</b>`:''}${d.src==='self'?' Теория оценена самопроверкой.':''}</div>
    <div class="arow" style="margin-bottom:16px">
      <button class="btn primary" data-act="again">Новый экзамен</button>
      <button class="btn ghost" data-act="home">К началу</button>
    </div>
    <h4 class="tix-h4">Теория</h4>
    ${(d.theory.tickets||[]).map(ticketFeedbackHtml).join('')}
    <h4 class="tix-h4">Тесты</h4>
    ${items.map((it,i)=>{ const q=it.q; const right=q.answerText||''; const tip=C.App.tips[q.id];
      return `<div class="review-item ${it.ok?'ok':'no'}">
        <div class="review-q">${i+1}. ${e(q.q)}</div>
        <div class="review-a">${it.ok?`<span class="good">✓ ${e(right)}</span>`:`${it.e?'<i>нет ответа</i>':`<span class="bad">${e(it.ua)}</span>`} &nbsp;→&nbsp; <span class="good">${e(right)}</span>`}</div>
        ${!it.ok&&tip?`<div class="tips" style="margin-top:8px"><div class="tips-title">💡 Tips</div>${e(tip)}</div>`:''}
      </div>`; }).join('')}`;
  host.onclick = ev => {
    const b=ev.target.closest('[data-act]');
    if(b){ if(b.dataset.act==='again'){ showIntroPane(); $('#tixStartBtn').click(); } else showIntroPane(); return; }
    const tl=ev.target.closest('[data-theory-link]'); if(tl){ C.switchView('theory'); openTicket(+tl.dataset.theoryLink); }
  };
  scrollViewTop(host);
}

/* =====================================================================
   PROFILE
   ===================================================================== */
function renderStudyStats(){
  const host=$('#studyStats'); if(!host) return;
  const total=Object.keys(cardById).length, d=[...done].filter(id=>cardById[id]).length;
  const ws=Object.values(wrBest); const wAvg=ws.length?Math.round(ws.reduce((a,b)=>a+b,0)/ws.length)+'%':'—';
  const last=tixHist[0]; const avg=tixHist.length?(tixHist.reduce((a,h)=>a+h.g,0)/tixHist.length).toFixed(1):'—';
  host.innerHTML = `<div class="dp-title">📚 Подготовка по билетам</div>
    <div class="stat-grid">
      <div class="stat"><div class="stat-num">${total?Math.round(d/total*100):0}%</div><div class="stat-lbl">Теория изучена</div></div>
      <div class="stat"><div class="stat-num">${d}</div><div class="stat-lbl">Карточек из ${total}</div></div>
      <div class="stat"><div class="stat-num">${wAvg}</div><div class="stat-lbl">Письменно, ср.</div></div>
      <div class="stat"><div class="stat-num">${tixHist.length}</div><div class="stat-lbl">Экзаменов</div></div>
      <div class="stat"><div class="stat-num">${last?last.g:'—'}</div><div class="stat-lbl">Последняя оценка</div></div>
      <div class="stat"><div class="stat-num">${avg}</div><div class="stat-lbl">Средняя оценка</div></div>
    </div>
    ${apiOn() && access ? `<div class="data-note">🔑 Проверка ИИ: ${access.admin?'вы админ — управление доступом в боте: /whitelist, /allow &lt;id&gt;, /revoke &lt;id&gt;':access.allowed?'доступ выдан':access.pending?'заявка на рассмотрении':'нет доступа'}</div>` : ''}`;
}

/* =====================================================================
   ACCESS (вайтлист проверки ИИ)
   ===================================================================== */
async function apiPost(path, payload){
  const url=String(C.CFG.apiUrl||'').replace(/\/+$/,'')+path;
  const r=await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(Object.assign({ initData:(C.TG && C.TG.initData)||'' }, payload||{})) });
  let j=null; try{ j=await r.json(); }catch(err){}
  if(!r.ok || !j) throw new Error((j && j.error) || ('HTTP '+r.status));
  return j;
}
async function loadAccess(){
  if(!apiOn()) return;
  try{ access=await apiPost('/api/access'); }
  catch(err){ access={ allowed:false, pending:false, error:err.message }; }
}
function accessBanner(){
  if(!apiOn() || !access || access.allowed) return '';
  if(access.error) return `<div class="tix-warn access-banner">🔑 Проверка ИИ недоступна: ${e(access.error)}</div>`;
  if(access.pending) return '<div class="tix-warn access-banner">⏳ Заявка на доступ к проверке ИИ отправлена — бот напишет, когда доступ выдадут. Пока доступна самопроверка.</div>';
  return `<div class="tix-warn access-banner">🔑 Проверка ответов ИИ — по доступу. Пока доступна самопроверка по эталону.
    <button class="btn primary small" data-access-request>Запросить доступ</button></div>`;
}
async function requestAccessClick(btn){
  btn.disabled=true;
  try{
    const r=await apiPost('/api/request-access');
    if(r.allowed){ access.allowed=true; C.toast('Доступ уже есть ✅'); }
    else { access.pending=true; C.toast('Заявка отправлена админу 📨'); }
    C.haptic('ok');
  }catch(err){ C.toast(err.message); btn.disabled=false; return; }
  refreshAccessUi();
}
function refreshAccessUi(){
  renderTixIntro();
  if(seg==='write' && !$('#prWrite').classList.contains('hidden')) renderWriting();
  if(run && run.stage==='theory' && !run.theory) renderTheoryStage();
  renderStudyStats();
}

/* =====================================================================
   PUBLIC
   ===================================================================== */
const Study = window.Study = {
  async init(core){
    C=core;
    try{ T=await fetch('data/theory.json').then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); }); }catch(err){ T=[]; console.error('theory.json', err); }
    T.sort((a,b)=>a.n-b.n);
    T.forEach(t=>t.cards.forEach(c=>{ cardById[c.id]={card:c, ticket:t}; }));
    LS.set('cardsTotal', String(Object.keys(cardById).length));
    await loadStudyProgress();
    await loadAccess();
    renderTheoryList();
    renderTixIntro();
    $('#prSeg').onclick = ev => { const b=ev.target.closest('.seg-btn'); if(b){ setSeg(b.dataset.seg); C.haptic(); } };
    setSeg(LS.get('prSeg')==='write' ? 'write' : 'tests');
    $('#studyStats') && renderStudyStats();
    document.addEventListener('click', ev => { const b=ev.target.closest('[data-access-request]'); if(b) requestAccessClick(b); });
    $('#tixRun').addEventListener('click', ev => { const tl=ev.target.closest('[data-theory-link]'); if(tl && run){ C.switchView('theory'); openTicket(+tl.dataset.theoryLink); } });
    document.addEventListener('quiz:view', ev => {
      const v=ev.detail;
      if(v==='profile') renderStudyStats();
      if(v==='theory' && $('#thTicket').classList.contains('hidden')) renderTheoryList();
      if(v==='exam'){
        if(run){ showRunPane(); renderRun(); }
        else if(!$('#tixRun').classList.contains('hidden')){ /* открыт разбор — оставляем */ }
        else renderTixHistory();
      }
    });
  },
  progressSummary(){
    const d=String(LS.get('thDone')||'').split(',').filter(Boolean).length;
    let h=[]; try{ h=JSON.parse(LS.get('tixHist')||'[]'); }catch(err){}
    return { cardsDone:d, cardsTotal:+(LS.get('cardsTotal')||0), tix:h.length, lastGrade:h[0]?h[0].g:null };
  },
  writingActive(){ return seg==='write'; },
  openTicket(n){ C.switchView('theory'); openTicket(n); },
};
})();
