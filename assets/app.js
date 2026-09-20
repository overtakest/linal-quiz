/* =====================================================================
   АиГ Тесты — Telegram Mini App
   Vanilla JS. Работает в Telegram и в обычном браузере (с моком).
   ===================================================================== */
(() => {
'use strict';
const DV = '?v=' + ((window.QUIZ_CONFIG && window.QUIZ_CONFIG.version) || '1');

/* ---------- Telegram bridge ---------- */
const TG = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (TG) { try { TG.ready(); TG.expand(); } catch(e){} }
const CFG = window.QUIZ_CONFIG || { adminIds: [], version: '1.0' };

/* ---------- Small helpers ---------- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle = a => { a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const normStr = s => String(s==null?'':s).toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').replace(/[.,;:!?"«»]/g,'').trim();
const normNum = s => { const m = String(s).replace(',','.').replace(/[^\d.\-]/g,''); return m===''?null:parseFloat(m); };
function haptic(kind){ try{ if(TG&&TG.HapticFeedback){ kind==='err'?TG.HapticFeedback.notificationOccurred('error'):kind==='ok'?TG.HapticFeedback.notificationOccurred('success'):TG.HapticFeedback.impactOccurred('light'); } }catch(e){} }
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); requestAnimationFrame(()=>t.classList.add('show')); clearTimeout(toastT); toastT=setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.classList.add('hidden'),300); },2200); }

/* =====================================================================
   STORAGE — CloudStorage (синхронизируется в Telegram) с фолбэком localStorage
   ===================================================================== */
const Store = {
  cloud: !!(TG && TG.CloudStorage && TG.isVersionAtLeast && TG.isVersionAtLeast('6.9')),
  get(key){
    return new Promise(res => {
      if (this.cloud){
        TG.CloudStorage.getItem(key, (err,val)=> res(err?null:(val||null)));
      } else {
        try{ res(localStorage.getItem('laq_'+key)); }catch(e){ res(null); }
      }
    });
  },
  set(key,val){
    return new Promise(res => {
      if (this.cloud){ TG.CloudStorage.setItem(key,val,()=>res()); }
      else { try{ localStorage.setItem('laq_'+key,val); }catch(e){} res(); }
    });
  },
  remove(key){
    if (this.cloud){ try{ TG.CloudStorage.removeItem(key,()=>{}); }catch(e){} }
    else { try{ localStorage.removeItem('laq_'+key); }catch(e){} }
  }
};
// local-only (мгновенно): тема + админ-оверрайды
const Local = {
  get(k){ try{ return localStorage.getItem('laq_'+k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem('laq_'+k,v); }catch(e){} },
  del(k){ try{ localStorage.removeItem('laq_'+k); }catch(e){} }
};

/* =====================================================================
   STATE
   ===================================================================== */
const App = {
  questions: [],           // рабочий массив (с учётом админ-оверрайдов)
  tips: {},                // {id: tip}
  byId: {},
  idToIdx: {},             // стабильный индекс для битсета выученного
  learnedBase: new Set(),  // индексы q-вопросов
  learnedCustom: new Set(),// id кастомных
  stats: { answered:0, correct:0 },
  examHistory: [],
  isAdmin: false,
  overrides: { edits:{}, added:[], deleted:[] },
};

function isLearned(q){ const m=/^q(\d+)$/.exec(q.id); return m ? App.learnedBase.has(+m[1]) : App.learnedCustom.has(q.id); }
function setLearned(q,val){
  const m=/^q(\d+)$/.exec(q.id);
  if (m){ val?App.learnedBase.add(+m[1]):App.learnedBase.delete(+m[1]); }
  else { val?App.learnedCustom.add(q.id):App.learnedCustom.delete(q.id); }
}
function learnedCount(){ return App.questions.reduce((n,q)=>n+(isLearned(q)?1:0),0); }

/* ---- bitset <-> base64 ---- */
function bitsetToB64(set){
  if(!set.size) return '';
  const max=Math.max(...set); const bytes=new Uint8Array((max>>3)+1);
  set.forEach(i=>{ bytes[i>>3]|=1<<(i&7); });
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin);
}
function b64ToBitset(str){
  const set=new Set(); if(!str) return set;
  try{ const bin=atob(str); for(let i=0;i<bin.length;i++){ const b=bin.charCodeAt(i); for(let k=0;k<8;k++) if(b&(1<<k)) set.add(i*8+k); } }catch(e){}
  return set;
}

async function loadProgress(){
  const [lb,lc,st,eh] = await Promise.all([Store.get('learnedB'),Store.get('learnedC'),Store.get('stats'),Store.get('exams')]);
  App.learnedBase = b64ToBitset(lb);
  App.learnedCustom = new Set(lc?JSON.parse(lc):[]);
  if(st){ try{ App.stats=JSON.parse(st); }catch(e){} }
  if(eh){ try{ App.examHistory=JSON.parse(eh); }catch(e){} }
  const ds=Local.get('deckSeed'), dp=Local.get('deckPos');
  if(ds){ const n=parseInt(ds,10); if(n) deck.seed=n; }
  if(dp) deck.currentId=dp;
  loadPractice();
}
let saveT;
function saveProgress(){
  clearTimeout(saveT);
  saveT=setTimeout(()=>{
    Store.set('learnedB', bitsetToB64(App.learnedBase));
    Store.set('learnedC', JSON.stringify([...App.learnedCustom]));
    Store.set('stats', JSON.stringify(App.stats));
  }, 400);
}
function saveExams(){ Store.set('exams', JSON.stringify(App.examHistory.slice(0,10))); }

/* =====================================================================
   DATA LOADING
   ===================================================================== */
async function loadData(){
  const [qs, tips] = await Promise.all([
    fetch('data/questions.json'+DV).then(r=>r.json()),
    fetch('data/tips.json'+DV).then(r=>r.json()).catch(()=>({}))
  ]);
  App.tips = tips || {};
  _baseQs = qs;
  // локальные подсказки админа поверх базовых
  try{ const to=Local.get('tipsOverride'); if(to) App.tips=Object.assign({}, App.tips, JSON.parse(to)); }catch(e){}
  // админ-оверрайды (локальные)
  try{ const ov=Local.get('overrides'); if(ov) App.overrides=JSON.parse(ov); }catch(e){}
  applyOverrides(qs);
}
function applyOverrides(baseQs){
  const ov=App.overrides;
  const del=new Set(ov.deleted||[]);
  let list=baseQs.filter(q=>!del.has(q.id));
  list=list.map(q => ov.edits[q.id] ? {...q, ...ov.edits[q.id]} : q);
  list=list.concat(ov.added||[]);
  App.questions=list;
  App.byId={}; App.idToIdx={};
  list.forEach((q,i)=>{ App.byId[q.id]=q; App.idToIdx[q.id]=i; });
}
function saveOverrides(){ Local.set('overrides', JSON.stringify(App.overrides)); }

/* =====================================================================
   THEME (светло/тёмная) + DESIGN (скины оформления)
   ===================================================================== */
const DESIGNS = [
  {id:'clinic',  name:'Клиника'},
  {id:'mono',    name:'Моно'},
  {id:'focus',   name:'Фокус'},
];
const DESIGN_IDS = DESIGNS.map(d=>d.id);
const DEFAULT_DESIGN = 'clinic';

function initTheme(){
  let t=Local.get('theme');
  if(!t){ t = (TG && TG.colorScheme==='dark') ? 'dark' : 'light'; }
  applyTheme(t);
}
function applyTheme(t){
  document.body.dataset.theme=t; Local.set('theme',t);
  updateChromeColor();
}
function toggleTheme(){ applyTheme(document.body.dataset.theme==='dark'?'light':'dark'); haptic(); }

function updateChromeColor(){
  let bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if(!/^#|rgb/.test(bg)) bg = document.body.dataset.theme==='dark' ? '#0d1119' : '#eaeef6';
  const meta=$('meta[name=theme-color]'); if(meta) meta.content=bg;
  try{ if(TG && TG.isVersionAtLeast && TG.isVersionAtLeast('6.1')){ TG.setHeaderColor(bg); TG.setBackgroundColor(bg); } }catch(e){}
}

function currentDesign(){ const d=Local.get('design'); return DESIGN_IDS.includes(d)?d:DEFAULT_DESIGN; }
function initDesign(){ const d=currentDesign(); if(Local.get('design')!==d) Local.set('design',d); applyDesign(d, false); }
function applyDesign(name, save=true){
  if(!DESIGN_IDS.includes(name)) name=DEFAULT_DESIGN;
  document.body.dataset.design=name;
  const link=document.getElementById('skin');
  const href='assets/skins/'+name+'.css'+DV;
  if(link && !link.getAttribute('href').endsWith(href)){
    link.addEventListener('load', updateChromeColor, {once:true});
    link.setAttribute('href', href);
  }
  if(save){ Local.set('design',name); Store.set('design',name); }
  $$('#designGrid .dp-card').forEach(c=>c.classList.toggle('active', c.dataset.design===name));
  updateChromeColor();
}

/* =====================================================================
   QUESTION CARD RENDERING (общий для практики и экзамена)
   mode: 'practice' | 'exam'
   ===================================================================== */
const TYPE_LABEL={multichoice:'Выбор',truefalse:'Верно/Неверно',match:'Соответствие',numerical:'Число',shortanswer:'Ответ словом'};

// answer store для практики: {id:{picked,done,correct,order,...}}
const practice = {};
let practiceT;
function savePractice(){
  clearTimeout(practiceT);
  practiceT=setTimeout(()=>{
    // храним только разобранные вопросы (done), чтобы не раздувать хранилище
    const slim={};
    for(const id in practice){ if(practice[id] && practice[id].done) slim[id]=practice[id]; }
    Local.set('practice', JSON.stringify(slim));
  }, 500);
}
function loadPractice(){
  try{ const raw=Local.get('practice'); if(raw){ const obj=JSON.parse(raw); for(const id in obj) practice[id]=obj[id]; } }catch(e){}
}
// принудительно сохранить всё при закрытии/сворачивании приложения (без потери последнего ответа)
function flushSaves(){
  try{
    clearTimeout(saveT); clearTimeout(practiceT);
    Store.set('learnedB', bitsetToB64(App.learnedBase));
    Store.set('learnedC', JSON.stringify([...App.learnedCustom]));
    Store.set('stats', JSON.stringify(App.stats));
    const slim={}; for(const id in practice){ if(practice[id] && practice[id].done) slim[id]=practice[id]; }
    Local.set('practice', JSON.stringify(slim));
    saveDeckMeta();
    if(exam.running) saveExamRun();
  }catch(e){}
}

function buildOptions(q){
  // возвращает перемешанный список опций (для choice/truefalse)
  if(q.type==='truefalse') return q.options.slice(); // порядок Верно/Неверно оставим осмысленным? перемешаем тоже
  return shuffle(q.options);
}

function renderCard(q, host, mode, stateObj){
  host.innerHTML='';
  const card=document.createElement('div');
  card.className='qcard';
  const learned=isLearned(q);
  let html=`<div class="qtype-tag ${learned&&mode==='practice'?'learned':''}">${learned&&mode==='practice'?'✓ ':''}${tagLabel(q)}</div>
            <div class="qtext">${esc(q.q)}</div>`;
  card.innerHTML=html;

  const body=document.createElement('div');
  card.appendChild(body);
  host.appendChild(card);

  if(q.type==='multichoice'||q.type==='truefalse') renderChoice(q,body,mode,stateObj,card);
  else if(q.type==='match') renderMatch(q,body,mode,stateObj,card);
  else renderText(q,body,mode,stateObj,card);
}

/* ---------- CHOICE (multichoice / truefalse) ---------- */
function renderChoice(q, body, mode, st, card){
  const multi = q.multi;
  if(multi){ const h=document.createElement('div'); h.className='qhint-multi'; h.textContent='Можно выбрать несколько вариантов'; card.insertBefore(h, body); }
  const shape = multi?'check':'radio';
  const opts = st.order || (st.order = buildOptions(q));
  const picked = new Set(st.picked||[]);
  const wrap=document.createElement('div'); wrap.className='opts';
  opts.forEach(text=>{
    const b=document.createElement('button');
    b.className='opt'; b.dataset.shape=shape; b.dataset.val=text;
    b.innerHTML=`<span class="opt-mark"></span><span>${esc(text)}</span>`;
    if(picked.has(text)) b.classList.add('picked');
    wrap.appendChild(b);
  });
  body.appendChild(wrap);

  const done = st.done;
  const checkBtn = document.createElement('button');
  checkBtn.className='btn primary check-btn'; checkBtn.textContent='Проверить ответ';

  const finish=()=>{
    const correct=new Set(q.correct);
    let ok = picked.size===correct.size && [...picked].every(p=>correct.has(p));
    st.picked=[...picked]; st.done=true; st.correct=ok;
    $$('.opt',wrap).forEach(o=>{ o.disabled=true; const v=o.dataset.val;
      if(correct.has(v)) o.classList.add('correct');
      else if(picked.has(v)) o.classList.add('wrong');
      else o.classList.add('reveal');
    });
    if(mode==='practice'){ afterPractice(q,ok,body,checkBtn); }
    haptic(ok?'ok':'err');
  };

  wrap.addEventListener('click', e=>{
    const b=e.target.closest('.opt'); if(!b||st.done) return;
    const v=b.dataset.val;
    if(multi){
      if(picked.has(v)){ picked.delete(v); b.classList.remove('picked'); }
      else { picked.add(v); b.classList.add('picked'); }
      st.picked=[...picked];
      if(mode==='exam') markExamAnswered(q.id, picked.size>0);
    } else {
      picked.clear(); picked.add(v);
      $$('.opt',wrap).forEach(o=>o.classList.remove('picked')); b.classList.add('picked');
      st.picked=[...picked];
      if(mode==='exam'){ markExamAnswered(q.id,true); }
      else finish(); // одиночный выбор в практике — сразу проверяем
    }
    haptic();
  });

  if(mode==='practice'){
    if(done){ // восстановить показанный результат
      const correct=new Set(q.correct);
      $$('.opt',wrap).forEach(o=>{ o.disabled=true; const v=o.dataset.val;
        if(correct.has(v)) o.classList.add('correct');
        else if(picked.has(v)) o.classList.add('wrong'); else o.classList.add('reveal'); });
      afterPractice(q, st.correct, body, null);
    } else if(multi){
      body.appendChild(checkBtn);
      checkBtn.addEventListener('click',()=>{ if(picked.size===0){toast('Выбери хотя бы один вариант');return;} checkBtn.remove(); finish(); });
    }
  }
}

/* ---------- MATCH ---------- */
function renderMatch(q, body, mode, st, card){
  const lefts = st.order || (st.order = shuffle(Object.keys(q.pairs)));
  const rights = st.rights || (st.rights = shuffle([...new Set(Object.values(q.pairs))]));
  st.sel = st.sel || {};
  const wrap=document.createElement('div');
  lefts.forEach(l=>{
    const row=document.createElement('div'); row.className='match-row';
    const opts = ['<option value="">—</option>'].concat(rights.map(r=>`<option value="${esc(r)}" ${st.sel[l]===r?'selected':''}>${esc(r)}</option>`)).join('');
    row.innerHTML=`<div class="match-left">${esc(l)}</div><select class="match-sel" data-left="${esc(l)}">${opts}</select>`;
    wrap.appendChild(row);
  });
  body.appendChild(wrap);

  wrap.addEventListener('change', e=>{
    const s=e.target.closest('.match-sel'); if(!s||st.done) return;
    st.sel[s.dataset.left]=s.value;
    if(mode==='exam') markExamAnswered(q.id, Object.values(st.sel).some(Boolean));
  });

  const finish=()=>{
    let ok=true;
    $$('.match-sel',wrap).forEach(s=>{ s.disabled=true; const l=s.dataset.left; const right=q.pairs[l];
      if(st.sel[l]===right) s.classList.add('correct'); else { s.classList.add('wrong'); ok=false; }
    });
    st.done=true; st.correct=ok;
    if(mode==='practice') afterPractice(q,ok,body,null);
    haptic(ok?'ok':'err');
  };

  if(mode==='practice'){
    if(st.done){ $$('.match-sel',wrap).forEach(s=>{ s.disabled=true; const l=s.dataset.left; if(st.sel[l]===q.pairs[l]) s.classList.add('correct'); else s.classList.add('wrong'); }); afterPractice(q,st.correct,body,null); }
    else { const cb=document.createElement('button'); cb.className='btn primary check-btn'; cb.textContent='Проверить ответ';
      cb.addEventListener('click',()=>{ if(Object.values(st.sel).filter(Boolean).length<lefts.length){toast('Заполни все соответствия');return;} cb.remove(); finish(); });
      body.appendChild(cb); }
  }
}

/* ---------- TEXT (numerical / shortanswer) ---------- */
function renderText(q, body, mode, st, card){
  const inp=document.createElement('input');
  inp.className='qinput'; inp.type = q.type==='numerical'?'text':'text';
  inp.setAttribute('inputmode', q.type==='numerical'?'decimal':'text');
  inp.placeholder = q.type==='numerical'?'Введите число…':'Введите ответ…';
  inp.value = st.picked||'';
  body.appendChild(inp);

  inp.addEventListener('input',()=>{ st.picked=inp.value; if(mode==='exam') markExamAnswered(q.id, inp.value.trim()!==''); });

  const check=()=>{
    st.picked=inp.value; inp.disabled=true;
    let ok;
    if(q.type==='numerical'){ const a=normNum(inp.value), b=normNum(q.answer); ok = a!==null && b!==null && Math.abs(a-b)<1e-6; }
    else { ok = normStr(inp.value)===normStr(q.answer); if(!ok){ // допускаем совпадение по нескольким допустимым (разделены /)
        ok = String(q.answer).split(/[\/;]/).some(v=>normStr(v)===normStr(inp.value)); } }
    st.done=true; st.correct=ok;
    inp.classList.add(ok?'correct':'wrong');
    if(mode==='practice') afterPractice(q,ok,body,cb);
    haptic(ok?'ok':'err');
  };

  if(mode==='practice'){
    if(st.done){ inp.disabled=true; inp.classList.add(st.correct?'correct':'wrong'); afterPractice(q,st.correct,body,null); return; }
    var cb=document.createElement('button'); cb.className='btn primary check-btn'; cb.textContent='Проверить ответ';
    cb.addEventListener('click',()=>{ if(!inp.value.trim()){toast('Введи ответ');return;} cb.remove(); check(); });
    body.appendChild(cb);
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'&&inp.value.trim()){ cb.remove(); check(); } });
  }
}

/* ---------- REVEAL + TIPS (только практика) ---------- */
function afterPractice(q, ok, body, btn){
  if(btn) btn.remove();
  // учёт статистики единожды
  if(!practice[q.id]._counted){ practice[q.id]._counted=true; App.stats.answered++; if(ok) App.stats.correct++; if(ok) setLearned(q,true); saveProgress(); }
  savePractice();  // сохраняем разобранный вопрос (ответ виден и при следующем запуске)
  const box=document.createElement('div'); box.className='reveal-box';
  const ansText = q.answerText || (q.type==='match'? Object.entries(q.pairs).map(([k,v])=>`${k} → ${v}`).join('  ·  ') : (q.correct?q.correct.join(', '):q.answer));
  const tip = App.tips[q.id];
  box.innerHTML =
    `<div class="reveal-head ${ok?'ok':'no'}">${ok?'✓ Верно!':'✕ Неверно'}</div>
     <div class="reveal-ans"><b>Правильный ответ:</b> ${esc(ansText)}</div>
     <div class="tips"><div class="tips-title">💡 Tips &amp; Tricks</div>${ tip? esc(tip) : '<span class="tips-loading">Мнемоническая подсказка появится после генерации базы советов.</span>' }</div>`;
  body.appendChild(box);
  // обновить кнопку «выучено» и счётчики на деке
  if(currentView==='all') syncLearnBtn();
  refreshDeckLearnedTag();
}

/* =====================================================================
   ALL QUESTIONS DECK
   ===================================================================== */
const deck = { list:[], pos:0, type:'all', topic:'all', status:'all', query:'', seed:0, currentId:null };

/* Детерминированный порядок по seed — храним один seed вместо сотен id (влезает в CloudStorage) */
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function seededShuffle(arr, seed){ const r=mulberry32(seed); arr=[...arr]; for(let i=arr.length-1;i>0;i--){ const j=Math.floor(r()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function orderedQuestions(){
  if(!deck.seed){ deck.seed=Math.floor(Math.random()*2e9)+1; saveDeckMeta(); }
  return interleave(seededShuffle(App.questions, deck.seed));
}
// позиция/порядок — сразу в localStorage (мгновенно, без потери при быстром закрытии)
function saveDeckMeta(){ Local.set('deckSeed', String(deck.seed)); Local.set('deckPos', deck.currentId||''); }

// reshuffle=true — только по кнопке 🔀: новый порядок + старт сначала.
// reshuffle=false — стабильный порядок, позиция восстанавливается (продолжаем где остановились).
function rebuildDeck(reshuffle=false){
  if(reshuffle){ deck.seed=Math.floor(Math.random()*2e9)+1; deck.currentId=null; saveDeckMeta(); }
  const ordered=orderedQuestions();
  const list=ordered.filter(q=>{
    if(deck.type!=='all' && q.type!==deck.type) return false;
    if(deck.topic!=='all' && q.topic!==deck.topic) return false;
    if(deck.status==='learned' && !isLearned(q)) return false;
    if(deck.status==='new' && isLearned(q)) return false;
    if(deck.query){ if(!(q.q.toLowerCase().includes(deck.query) || (q.answerText||'').toLowerCase().includes(deck.query))) return false; }
    return true;
  });
  deck.list=list;
  const idx = deck.currentId ? list.findIndex(q=>q.id===deck.currentId) : -1;
  deck.pos = idx>=0 ? idx : 0;
  renderDeck();
}
// лёгкое чередование типов, чтобы не шли подряд одинаковые
function interleave(list){
  const buckets={};
  list.forEach(q=>{ (buckets[q.type]=buckets[q.type]||[]).push(q); });
  const keys=Object.keys(buckets); const out=[]; let added=true;
  while(added){ added=false; for(const k of keys){ if(buckets[k].length){ out.push(buckets[k].shift()); added=true; } } }
  return out;
}

function renderDeck(){
  const host=$('#cardHost');
  if(!deck.list.length){ host.innerHTML=`<div class="qcard"><div class="qtext" style="text-align:center;color:var(--muted)">Ничего не найдено 🔍<br><span style="font-size:14px;font-weight:400">Измени фильтр или поиск</span></div></div>`;
    $('#deckCounter').textContent='0 / 0'; $('#deckProgressBar').style.width='0%'; $('#prevBtn').disabled=$('#nextBtn').disabled=true; $('#learnBtn').style.visibility='hidden'; return; }
  $('#learnBtn').style.visibility='visible';
  const q=deck.list[deck.pos];
  deck.currentId=q.id; saveDeckMeta();   // запоминаем, где остановился
  practice[q.id]=practice[q.id]||{};
  renderCard(q, host, 'practice', practice[q.id]);
  $('#deckCounter').textContent=`${deck.pos+1} / ${deck.list.length}`;
  $('#deckProgressBar').style.width=((deck.pos+1)/deck.list.length*100)+'%';
  $('#prevBtn').disabled=deck.pos===0;
  $('#nextBtn').disabled=deck.pos===deck.list.length-1;
  syncLearnBtn();
}
function deckGo(dir){
  const np=deck.pos+dir; if(np<0||np>=deck.list.length) return;
  deck.pos=np;
  const host=$('#cardHost'); renderDeck();
  const card=$('.qcard',host); if(card) card.classList.add(dir>0?'swap-left':'swap-right');
}
function syncLearnBtn(){
  const q=deck.list[deck.pos]; if(!q) return;
  const b=$('#learnBtn'); const on=isLearned(q);
  b.classList.toggle('on',on); b.textContent=on?'✓ Выучено':'Отметить выученным';
}
function refreshDeckLearnedTag(){ /* tag обновляется при следующем рендере карты */ }

function toggleLearn(){
  const q=deck.list[deck.pos]; if(!q) return;
  setLearned(q,!isLearned(q)); saveProgress(); syncLearnBtn(); haptic();
  // обновить тег на карточке
  const tag=$('.qtype-tag'); const on=isLearned(q);
  if(tag){ tag.classList.toggle('learned',on); tag.innerHTML=(on?'✓ ':'')+tagLabel(q); }
}

/* =====================================================================
   EXAM ENGINE
   ===================================================================== */
const EX_COUNT=40, EX_SECONDS=25*60, EX_PASS=0.6;
const exam = { list:[], pos:0, answers:{}, state:{}, answered:{}, timer:null, left:0, running:false };

function startExam(){
  const pool = App.questions.length<=EX_COUNT ? App.questions.slice() : App.questions;
  exam.list = interleave(shuffle(pool)).slice(0, Math.min(EX_COUNT, App.questions.length));
  exam.pos=0; exam.answers={}; exam.state={}; exam.answered={};
  exam.left=EX_SECONDS; exam.running=true;
  exam.endTs=Date.now()+EX_SECONDS*1000;
  $('#examIntro').classList.add('hidden'); $('#examResult').classList.add('hidden'); $('#examRun').classList.remove('hidden');
  buildDots(); renderExamCard(); tickStart(); saveExamRun();
  haptic();
}

/* ---- сохранение незавершённой попытки: случайный выход не убивает экзамен ---- */
function saveExamRun(){
  if(!exam.running) return;
  try{ Local.set('examRun', JSON.stringify({ ids:exam.list.map(q=>q.id), state:exam.state, answered:exam.answered, pos:exam.pos, endTs:exam.endTs })); }catch(e){}
}
function tryResumeExam(){
  let run; try{ run=JSON.parse(Local.get('examRun')||'null'); }catch(e){}
  if(!run || !run.ids || !run.ids.length) return false;
  const qs=run.ids.map(id=>App.byId[id]).filter(Boolean);
  if(qs.length<2){ Local.del('examRun'); return false; }
  exam.list=qs; exam.state=run.state||{}; exam.answered=run.answered||{};
  exam.pos=Math.min(run.pos||0, qs.length-1);
  exam.endTs=run.endTs||Date.now();
  exam.left=Math.max(0, Math.floor((exam.endTs-Date.now())/1000));
  exam.running=true;
  $('#examIntro').classList.add('hidden'); $('#examResult').classList.add('hidden');
  if(exam.left<=0){ finishExam(true); toast('Время вышло — вот результат ⏱'); return true; }
  $('#examRun').classList.remove('hidden');
  buildDots(); renderExamCard(); tickStart();
  toast('Экзамен продолжен ⏱');
  return true;
}
function tickStart(){
  clearInterval(exam.timer); updateTimer();
  exam.timer=setInterval(()=>{ exam.left--; updateTimer(); if(exam.left<=0){ finishExam(true); } },1000);
}
function updateTimer(){
  const m=Math.floor(exam.left/60), s=exam.left%60;
  const el=$('#examTimer'); el.textContent=`${m}:${String(s).padStart(2,'0')}`;
  el.classList.toggle('warn', exam.left<=120 && exam.left>30);
  el.classList.toggle('crit', exam.left<=30);
}
function buildDots(){
  const host=$('#examDots'); host.innerHTML='';
  exam.list.forEach((q,i)=>{ const d=document.createElement('button'); d.className='edot'; d.dataset.i=i; host.appendChild(d); });
  host.onclick=e=>{ const d=e.target.closest('.edot'); if(d){ exam.pos=+d.dataset.i; renderExamCard(); } };
}
function updateDots(){
  $$('#examDots .edot').forEach((d,i)=>{ d.classList.toggle('answered', !!exam.answered[exam.list[i].id]); d.classList.toggle('current', i===exam.pos); });
}
function markExamAnswered(id, yes){ exam.answered[id]=yes; updateDots(); saveExamRun(); }
function renderExamCard(){
  const q=exam.list[exam.pos];
  exam.state[q.id]=exam.state[q.id]||{};
  renderCard(q, $('#examCardHost'), 'exam', exam.state[q.id]);
  $('#examCount').textContent=`${exam.pos+1} / ${exam.list.length}`;
  $('#examProgressBar').style.width=((exam.pos+1)/exam.list.length*100)+'%';
  $('#examPrev').disabled=exam.pos===0; $('#examNext').disabled=exam.pos===exam.list.length-1;
  updateDots();
}
function examGo(dir){ const np=exam.pos+dir; if(np<0||np>=exam.list.length) return; exam.pos=np; renderExamCard(); saveExamRun(); const c=$('.qcard',$('#examCardHost')); if(c) c.classList.add(dir>0?'swap-left':'swap-right'); }

function evalExamQuestion(q, st){
  if(!st||st.picked==null || (Array.isArray(st.picked)&&!st.picked.length) || (typeof st.picked==='string'&&!st.picked.trim())){
    if(q.type==='match'){ if(!st||!st.sel||!Object.values(st.sel).some(Boolean)) return {ok:false,empty:true}; }
    else return {ok:false, empty:true};
  }
  if(q.type==='multichoice'||q.type==='truefalse'){
    const picked=new Set(st.picked||[]); const cor=new Set(q.correct);
    return {ok: picked.size===cor.size && [...picked].every(p=>cor.has(p))};
  }
  if(q.type==='match'){ const ok=Object.keys(q.pairs).every(l=>(st.sel||{})[l]===q.pairs[l]); return {ok}; }
  if(q.type==='numerical'){ const a=normNum(st.picked),b=normNum(q.answer); return {ok:a!==null&&b!==null&&Math.abs(a-b)<1e-6}; }
  return {ok: normStr(st.picked)===normStr(q.answer) || String(q.answer).split(/[\/;]/).some(v=>normStr(v)===normStr(st.picked))};
}

function finishExam(auto){
  if(!exam.running) return;
  if(!auto){ const un=exam.list.filter(q=>!exam.answered[q.id]).length; if(un>0 && !confirm(`Осталось без ответа: ${un}. Завершить экзамен?`)) return; }
  exam.running=false; clearInterval(exam.timer); Local.del('examRun');
  let correct=0; const items=[];
  exam.list.forEach(q=>{ const r=evalExamQuestion(q, exam.state[q.id]); if(r.ok) correct++;
    items.push({q, ok:!!r.ok, empty:!!r.empty, ua:describeAnswer(q, exam.state[q.id])});
    App.stats.answered++; if(r.ok){ App.stats.correct++; setLearned(q,true); } });
  saveProgress();
  const total=exam.list.length; const pct=Math.round(correct/total*100); const passed=correct/total>=EX_PASS;
  const timeUsed=EX_SECONDS-exam.left;
  const ts=Date.now();
  App.examHistory.unshift({ score:pct, correct, total, timeUsed, ts });
  const dropped=App.examHistory.slice(10);          // попытки, вытесненные из истории (>10)
  App.examHistory=App.examHistory.slice(0,10); saveExams();
  dropped.forEach(h=>{ Local.del('exd'+h.ts); Store.remove('exd'+h.ts); });
  // компактный разбор: свой ответ храним только для неверных (экономия места в CloudStorage)
  saveExamDetail(ts, items.map(it=>{ const d={id:it.q.id, ok:it.ok?1:0, e:it.empty?1:0}; if(!it.ok && !it.empty) d.ua=String(it.ua).slice(0,90); return d; }));
  renderExamResult({correct,total,pct,passed,timeUsed,items});
  haptic(passed?'ok':'err');
}

/* ---- разбор попыток: CloudStorage (синхронизация между устройствами) + локальное зеркало ---- */
function saveExamDetail(ts, detail){
  const json=JSON.stringify(detail);
  Local.set('exd'+ts, json);   // мгновенно на устройстве
  Store.set('exd'+ts, json);   // в облако Telegram
}
async function getExamDetail(ts){
  const local=Local.get('exd'+ts);
  if(local){ try{ return JSON.parse(local); }catch(e){} }
  const cloud=await Store.get('exd'+ts);
  if(cloud){ try{ const d=JSON.parse(cloud); Local.set('exd'+ts, cloud); return d; }catch(e){} }
  return null;
}
async function openStoredReview(h){
  const detail=await getExamDetail(h.ts);
  if(!detail || !detail.length){ toast('Разбор этой попытки не сохранён (сдана до обновления)'); return; }
  const items=detail.map(d=>({q:App.byId[d.id], ok:!!d.ok, empty:!!d.e, ua:d.ua||''})).filter(it=>it.q);
  if(!items.length){ toast('Разбор недоступен'); return; }
  $('#examIntro').classList.add('hidden');
  renderExamResult({correct:h.correct, total:h.total, pct:h.score, passed:h.correct/h.total>=EX_PASS, timeUsed:h.timeUsed, items});
}

function fmtTime(s){ const m=Math.floor(s/60); return `${m}:${String(s%60).padStart(2,'0')}`; }
function renderExamResult({correct,total,pct,passed,timeUsed,items}){
  $('#examRun').classList.add('hidden');
  const host=$('#examResult'); host.classList.remove('hidden');
  let html=`<div class="result-hero ${passed?'pass':'fail'}">
      <div class="result-score">${pct}%</div>
      <div class="result-sub">${passed?'Экзамен сдан! 🎉':'Есть над чем поработать'}</div>
      <div class="result-meta"><span>✅ ${correct} из ${total}</span><span>⏱ ${fmtTime(timeUsed)}</span></div>
    </div>
    <div class="arow" style="margin-bottom:16px">
      <button class="btn primary" id="examAgain">Новый вариант</button>
      <button class="btn ghost" id="examBack">К началу</button>
    </div>
    <h4 style="color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin:0 0 10px">Разбор</h4>`;
  items.forEach(({q,ok,empty,ua},i)=>{
    const rightAns = q.answerText || (q.type==='match'? Object.entries(q.pairs).map(([k,v])=>`${k} → ${v}`).join(', ') : (q.correct?q.correct.join(', '):q.answer));
    const tip=App.tips[q.id];
    html+=`<div class="review-item ${ok?'ok':'no'}">
      <div class="review-q">${i+1}. ${esc(q.q)}</div>
      <div class="review-a">${ ok? `<span class="good">✓ ${esc(rightAns)}</span>` :
         `${empty?'<i>нет ответа</i>':`<span class="bad">${esc(ua)}</span>`} &nbsp;→&nbsp; <span class="good">${esc(rightAns)}</span>` }</div>
      ${ (!ok && tip)? `<div class="tips" style="margin-top:8px"><div class="tips-title">💡 Tips</div>${esc(tip)}</div>`:'' }
    </div>`;
  });
  host.innerHTML=html;
  $('#examAgain').onclick=startExam;
  $('#examBack').onclick=()=>{ host.classList.add('hidden'); $('#examIntro').classList.remove('hidden'); renderExamHistory(); };
  host.scrollTop=0;
}
function describeAnswer(q, st){
  if(!st) return '';
  if(q.type==='match') return Object.entries(st.sel||{}).filter(([,v])=>v).map(([k,v])=>`${k}→${v}`).join(', ');
  if(Array.isArray(st.picked)) return st.picked.join(', ');
  return st.picked||'';
}
function renderExamHistory(){
  const host=$('#examHistoryHost');
  if(!App.examHistory.length){ host.innerHTML=''; return; }
  let html='<h4>История экзаменов · нажми — разбор</h4>';
  App.examHistory.forEach((h,i)=>{
    const passed=h.correct/h.total>=EX_PASS;
    html+=`<div class="hist-row clickable" data-i="${i}" role="button">
      <span>${h.correct}/${h.total} · ⏱ ${fmtTime(h.timeUsed)} <span class="hist-more">›</span></span>
      <span class="hist-score ${passed?'pass':'fail'}">${h.score}%</span></div>`;
  });
  host.innerHTML=html;
  host.onclick=e=>{
    const row=e.target.closest('.hist-row.clickable'); if(!row) return;
    const h=App.examHistory[+row.dataset.i]; if(h) { openStoredReview(h); haptic(); }
  };
}

/* =====================================================================
   PROFILE
   ===================================================================== */
function inTelegram(){ return !!(TG && ((TG.platform && TG.platform!=='unknown') || (TG.initData && TG.initData.length))); }
function tgUser(){
  let u = TG && TG.initDataUnsafe && TG.initDataUnsafe.user;
  if(u && u.id) return u;
  // запасной разбор строки initData (иногда initDataUnsafe пуст, а строка есть)
  try{
    if(TG && TG.initData){
      const p=new URLSearchParams(TG.initData); const raw=p.get('user');
      if(raw){ const parsed=JSON.parse(raw); if(parsed && parsed.id) return parsed; }
    }
  }catch(e){}
  return null;
}
function renderProfile(){
  const u = tgUser();
  const name = u ? [u.first_name,u.last_name].filter(Boolean).join(' ') : (inTelegram()?'Пользователь':'Гость');
  $('#profName').textContent=name||'Пользователь';
  let sub;
  if(u && u.username) sub='@'+u.username;
  else if(u) sub='ID: '+u.id;
  else if(inTelegram()) sub='Telegram · '+(TG.platform||'?')+' v'+(TG.version||'?'); // диагностика
  else sub='Демо-режим (браузер)';
  $('#profUser').textContent = sub;
  const av=$('#profAvatar');
  if(u&&u.photo_url){ av.style.backgroundImage=`url(${u.photo_url})`; av.textContent=''; }
  else { av.style.backgroundImage=''; av.textContent=(name||'?').trim().charAt(0).toUpperCase()||'?'; }
  $('#adminBadge').classList.toggle('hidden', !App.isAdmin);
  $('#adminOpenBtn').style.display = App.isAdmin?'block':'none';

  const total=App.questions.length, learned=learnedCount(), left=total-learned;
  const pct = total? Math.round(learned/total*100):0;
  $('#stLearned').textContent=learned; $('#stLeft').textContent=left; $('#stTotal').textContent=total;
  $('#stExams').textContent=App.examHistory.length;
  const best = App.examHistory.length? Math.max(...App.examHistory.map(h=>h.score))+'%':'—';
  $('#stBest').textContent=best;
  $('#stAcc').textContent = App.stats.answered? Math.round(App.stats.correct/App.stats.answered*100)+'%':'—';
  // ring
  const circ=2*Math.PI*52;
  const fg=$('#ringFg'); fg.style.strokeDasharray=circ; fg.style.strokeDashoffset=circ*(1-pct/100);
  $('#ringPct').textContent=pct+'%';
  $('#verTag').textContent='v'+(CFG.version||'1.0');
  const fc=$('#footCount'); if(fc) fc.textContent=total+' вопросов';
}

/* =====================================================================
   ADMIN PANEL
   ===================================================================== */
function detectAdmin(){
  Local.del('adminUnlock'); // чистим старый небезопасный флаг 7-нажатий
  const u = tgUser();
  App.isAdmin = !!(u && (CFG.adminIds||[]).includes(u.id));
}
function openAdmin(){ $('#adminModal').classList.remove('hidden'); adminTab('dash'); }
function closeAdmin(){ $('#adminModal').classList.add('hidden'); }
let curAtab='dash';
function adminTab(t){ curAtab=t; $$('.atab').forEach(b=>b.classList.toggle('active',b.dataset.atab===t)); renderAdmin(); }

function renderAdmin(){
  const host=$('#adminBody');
  if(curAtab==='dash') return renderAdminDash(host);
  if(curAtab==='manage') return renderAdminManage(host);
  if(curAtab==='data') return renderAdminData(host);
  if(curAtab==='users'){ host.onclick=null; if(window.Study && Study.renderAdminUsers) return Study.renderAdminUsers(host);
    host.innerHTML='<div class="data-note">Модуль не загружен</div>'; return; }
}
function renderAdminDash(host){
  const total=App.questions.length, learned=learnedCount();
  const byType={}; App.questions.forEach(q=>byType[q.type]=(byType[q.type]||0)+1);
  let bars=''; Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([t,n])=>{
    bars+=`<div class="abar"><div class="abar-lbl"><span>${TYPE_LABEL[t]||t}</span><span>${n}</span></div><div class="abar-track"><div class="abar-fill" style="width:${n/total*100}%"></div></div></div>`;
  });
  const acc=App.stats.answered?Math.round(App.stats.correct/App.stats.answered*100):0;
  host.innerHTML=`
    <div class="adash">
      <div class="stat"><div class="stat-num">${total}</div><div class="stat-lbl">Вопросов</div></div>
      <div class="stat"><div class="stat-num">${learned}</div><div class="stat-lbl">Выучено</div></div>
      <div class="stat"><div class="stat-num">${App.examHistory.length}</div><div class="stat-lbl">Экзаменов</div></div>
      <div class="stat"><div class="stat-num">${acc}%</div><div class="stat-lbl">Точность</div></div>
      <div class="stat"><div class="stat-num">${App.overrides.added.length}</div><div class="stat-lbl">Добавлено</div></div>
      <div class="stat"><div class="stat-num">${App.overrides.deleted.length}</div><div class="stat-lbl">Удалено</div></div>
    </div>
    <div class="filter-title" style="margin-top:6px">Распределение по типам</div>
    ${bars}`;
}
let manageQuery='';
function renderAdminManage(host){
  host.innerHTML=`
    <div class="search-wrap" style="margin-bottom:12px">
      <svg class="search-i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
      <input id="admSearch" class="search" placeholder="Поиск вопроса…" value="${esc(manageQuery)}">
    </div>
    <button class="btn primary" id="admAdd" style="width:100%;margin-bottom:12px">＋ Добавить вопрос</button>
    <div class="aq-list" id="admList"></div>`;
  const listEl=$('#admList');
  const draw=()=>{
    const q=manageQuery.toLowerCase();
    const items=App.questions.filter(x=>!q||x.q.toLowerCase().includes(q)).slice(0,80);
    listEl.innerHTML = items.map(x=>`<div class="aq-item" data-id="${x.id}"><div class="aq-type">${TYPE_LABEL[x.type]||x.type}</div><div class="aq-q">${esc(x.q)}</div></div>`).join('') || '<div class="data-note">Ничего не найдено.</div>';
    if(App.questions.filter(x=>!q||x.q.toLowerCase().includes(q)).length>80) listEl.innerHTML+='<div class="data-note">Показаны первые 80. Уточни поиск.</div>';
  };
  draw();
  $('#admSearch').addEventListener('input',e=>{ manageQuery=e.target.value; draw(); });
  $('#admAdd').onclick=()=>editQuestion(null);
  listEl.onclick=e=>{ const it=e.target.closest('.aq-item'); if(it) editQuestion(it.dataset.id); };
}

function editQuestion(id){
  const host=$('#adminBody');
  const q = id? App.byId[id] : { id:'c'+Date.now(), type:'multichoice', q:'', options:['',''], correct:[], answerText:'' };
  const isNew=!id;
  const tip=App.tips[q.id]||'';
  const optText = q.type==='match'
    ? Object.entries(q.pairs||{}).map(([k,v])=>`${k} :: ${v}`).join('\n')
    : (q.options||[]).join('\n');
  host.innerHTML=`
    <button class="btn ghost small" id="admBack" style="margin-bottom:12px">‹ Назад к списку</button>
    <div class="field"><label>Тип</label>
      <select id="fType">${['multichoice','truefalse','match','numerical','shortanswer'].map(t=>`<option value="${t}" ${q.type===t?'selected':''}>${TYPE_LABEL[t]}</option>`).join('')}</select></div>
    <div class="field"><label>Текст вопроса</label><textarea id="fQ">${esc(q.q)}</textarea></div>
    <div class="field" id="fOptsWrap"><label id="fOptsLbl"></label><textarea id="fOpts" placeholder="">${esc(optText)}</textarea><div class="data-note" id="fOptsHint"></div></div>
    <div class="field" id="fCorrectWrap"><label>Правильный ответ(ы)</label><input id="fCorrect" value="${esc((q.correct||[]).join(' | ')|| q.answer || '')}"><div class="data-note" id="fCorrectHint"></div></div>
    <div class="field"><label>💡 Tips &amp; Tricks (подсказка для запоминания)</label><textarea id="fTip">${esc(tip)}</textarea></div>
    <div class="arow">
      <button class="btn primary" id="fSave">Сохранить</button>
      ${!isNew?'<button class="btn danger" id="fDel">Удалить</button>':''}
    </div>`;
  const refreshHints=()=>{
    const t=$('#fType').value;
    const lbl=$('#fOptsLbl'), hint=$('#fOptsHint'), cwrap=$('#fCorrectWrap'), owrap=$('#fOptsWrap'), chint=$('#fCorrectHint');
    if(t==='match'){ owrap.style.display=''; cwrap.style.display='none'; lbl.textContent='Пары (по строке)'; hint.textContent='Формат: левое :: правильное соответствие'; }
    else if(t==='numerical'||t==='shortanswer'){ owrap.style.display='none'; cwrap.style.display=''; lbl.textContent=''; chint.textContent = t==='numerical'?'Число. Несколько вариантов — через /':'Слово/фраза. Несколько вариантов — через /'; }
    else { owrap.style.display=''; cwrap.style.display=''; lbl.textContent='Варианты (по строке)'; hint.textContent='Каждый вариант — с новой строки'; chint.textContent='Правильные варианты — точным текстом, разделяй « | »'; }
  };
  refreshHints();
  $('#fType').onchange=refreshHints;
  $('#admBack').onclick=()=>adminTab('manage');
  if(!isNew) $('#fDel').onclick=()=>{ if(confirm('Удалить вопрос?')){ deleteQuestion(q.id); adminTab('manage'); toast('Удалено'); } };
  $('#fSave').onclick=()=>{
    const t=$('#fType').value; const obj={ id:q.id, type:t, q:$('#fQ').value.trim() };
    if(!obj.q){ toast('Введи текст вопроса'); return; }
    if(t==='match'){
      const pairs={}; $('#fOpts').value.split('\n').forEach(l=>{ const m=l.split('::'); if(m.length>=2&&m[0].trim()) pairs[m[0].trim()]=m.slice(1).join('::').trim(); });
      if(Object.keys(pairs).length<2){ toast('Нужно ≥2 пары'); return; }
      obj.pairs=pairs; obj.answerText=Object.entries(pairs).map(([k,v])=>`${k} → ${v}`).join('  |  ');
    } else if(t==='numerical'||t==='shortanswer'){
      const a=$('#fCorrect').value.trim(); if(!a){ toast('Введи ответ'); return; } obj.answer=a; obj.answerText=a;
    } else {
      const opts=$('#fOpts').value.split('\n').map(s=>s.trim()).filter(Boolean);
      const correct=$('#fCorrect').value.split('|').map(s=>s.trim()).filter(Boolean);
      if(opts.length<2){ toast('Нужно ≥2 варианта'); return; }
      if(!correct.length||!correct.every(c=>opts.includes(c))){ toast('Правильные должны быть среди вариантов'); return; }
      obj.options=opts; obj.correct=correct; obj.multi=t==='multichoice'&&correct.length>1; obj.answerText=correct.join(', ');
    }
    upsertQuestion(obj, isNew);
    const tipVal=$('#fTip').value.trim();
    if(tipVal) App.tips[obj.id]=tipVal; else delete App.tips[obj.id];
    Local.set('tipsOverride', JSON.stringify(App.tips)); // сохраняем и подсказки локально
    toast(isNew?'Добавлено ✓':'Сохранено ✓'); adminTab('manage');
  };
}
function upsertQuestion(obj, isNew){
  if(isNew){ App.overrides.added.push(obj); }
  else {
    const baseAdded=App.overrides.added.findIndex(a=>a.id===obj.id);
    if(baseAdded>=0) App.overrides.added[baseAdded]=obj;
    else App.overrides.edits[obj.id]=obj;
  }
  saveOverrides(); applyOverrides(getBaseQs()); postDataChange();
}
function deleteQuestion(id){
  const addedIdx=App.overrides.added.findIndex(a=>a.id===id);
  if(addedIdx>=0) App.overrides.added.splice(addedIdx,1);
  else { App.overrides.deleted.push(id); delete App.overrides.edits[id]; }
  saveOverrides(); applyOverrides(getBaseQs()); postDataChange();
}
let _baseQs=[];
function getBaseQs(){ return _baseQs; }
function postDataChange(){ rebuildDeck(false); renderProfile(); }

function renderAdminData(host){
  host.innerHTML=`
    <div class="data-note">
      <b>Как обновить базу для всех пользователей:</b><br>
      1. Отредактируй вопросы во вкладке «Вопросы».<br>
      2. Нажми «Экспорт базы» — скачается <code>questions.json</code> и <code>tips.json</code>.<br>
      3. Замени ими файлы в папке <code>data/</code> репозитория и перезалей на GitHub Pages.<br>
      <i>Правки хранятся локально на этом устройстве, пока не выгружены в репозиторий.</i>
    </div>
    <button class="btn primary" id="expQ" style="width:100%;margin-bottom:10px">⬇ Экспорт questions.json</button>
    <button class="btn ghost" id="expT" style="width:100%;margin-bottom:10px">⬇ Экспорт tips.json</button>
    <button class="btn ghost" id="impBtn" style="width:100%;margin-bottom:18px">⬆ Импорт questions.json</button>
    <input type="file" id="impFile" accept="application/json" style="display:none">
    <button class="btn danger-ghost" id="clrOv" style="width:100%">Сбросить локальные правки</button>`;
  $('#expQ').onclick=()=>download('questions.json', JSON.stringify(App.questions));
  $('#expT').onclick=()=>download('tips.json', JSON.stringify(App.tips,null,0));
  $('#impBtn').onclick=()=>$('#impFile').click();
  $('#impFile').onchange=e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader();
    r.onload=()=>{ try{ const data=JSON.parse(r.result); if(!Array.isArray(data)) throw 0;
      _baseQs=data; App.overrides={edits:{},added:[],deleted:[]}; saveOverrides(); applyOverrides(_baseQs); postDataChange(); toast('База импортирована ✓'); adminTab('dash');
    }catch(err){ toast('Ошибка: неверный файл'); } };
    r.readAsText(f); };
  $('#clrOv').onclick=()=>{ if(confirm('Сбросить все локальные правки базы?')){ App.overrides={edits:{},added:[],deleted:[]}; saveOverrides(); applyOverrides(_baseQs); postDataChange(); toast('Правки сброшены'); adminTab('dash'); } };
}
function download(name, text){
  const blob=new Blob([text],{type:'application/json'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* =====================================================================
   NAVIGATION / TABS
   ===================================================================== */
let currentView='theory';
const VIEW_TITLE={theory:'Теория',all:'Отработка',entry:'Входной контроль',exam:'Экзамен',profile:'Профиль'};
function switchView(v){
  currentView=v;
  $$('.view').forEach(el=>el.classList.add('hidden'));
  $('#view-'+v).classList.remove('hidden');
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  $('#topbarTitle').textContent=VIEW_TITLE[v];
  if(v==='profile') renderProfile();
  if(v==='exam' && !exam.running){ if(!tryResumeExam()) renderExamHistory(); }
  document.dispatchEvent(new CustomEvent('quiz:view',{detail:v}));
  haptic();
}

/* =====================================================================
   FILTER SHEET
   ===================================================================== */
const topicNum = t => (String(t).match(/^(\d+)/)||[])[1]||'';
function tagLabel(q){ const n=q.topic?topicNum(q.topic):''; return esc(TYPE_LABEL[q.type]||q.type)+(n?' · Билет '+n:''); }
function buildTopicSelect(){
  const sel=$('#topicSel'); if(!sel) return;
  const topics=[...new Set(App.questions.map(q=>q.topic).filter(Boolean))].sort((a,b)=>(+topicNum(a))-(+topicNum(b)));
  sel.innerHTML='<option value="all">Все билеты</option>'+topics.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value=deck.topic; sel.onchange=()=>{ deck.topic=sel.value; };
}
function buildTypeChips(){
  buildTopicSelect();
  const host=$('#typeChips');
  const types=['all',...new Set(App.questions.map(q=>q.type))];
  host.innerHTML=types.map(t=>`<button class="fchip ${t==='all'?'active':''}" data-type="${t}">${t==='all'?'Все':TYPE_LABEL[t]||t}</button>`).join('');
  host.onclick=e=>{ const b=e.target.closest('.fchip'); if(!b) return; $$('.fchip',host).forEach(x=>x.classList.remove('active')); b.classList.add('active'); deck.type=b.dataset.type; };
  $('#statusChips').onclick=e=>{ const b=e.target.closest('.fchip'); if(!b) return; $$('#statusChips .fchip').forEach(x=>x.classList.remove('active')); b.classList.add('active'); deck.status=b.dataset.status; };
}
function updateFilterLabel(){
  const parts=[]; if(deck.topic!=='all') parts.push('билет '+topicNum(deck.topic)); if(deck.type!=='all') parts.push(TYPE_LABEL[deck.type]||deck.type); if(deck.status!=='all') parts.push(deck.status==='learned'?'выученные':'новые');
  $('#filterLabel').textContent = parts.length?parts.join(', '):'Фильтр';
}

/* =====================================================================
   WIRE UP
   ===================================================================== */
function wire(){
  $$('.tab').forEach(t=>t.addEventListener('click',()=>switchView(t.dataset.view)));
  $('#themeToggle').onclick=toggleTheme;
  $('#themeBtn2').onclick=toggleTheme;
  $('#designGrid').addEventListener('click', e=>{
    const c=e.target.closest('.dp-card'); if(!c) return;
    applyDesign(c.dataset.design); haptic();
    toast('Дизайн: '+c.querySelector('.dp-name').textContent);
  });
  $('#prevBtn').onclick=()=>deckGo(-1);
  $('#nextBtn').onclick=()=>deckGo(1);
  $('#learnBtn').onclick=toggleLearn;

  // search
  const si=$('#searchInput');
  let sT; si.addEventListener('input',()=>{ $('#searchClear').classList.toggle('hidden',!si.value); clearTimeout(sT); sT=setTimeout(()=>{ deck.query=si.value.trim().toLowerCase(); rebuildDeck(false); },250); });
  $('#searchClear').onclick=()=>{ si.value=''; $('#searchClear').classList.add('hidden'); deck.query=''; rebuildDeck(false); };

  // filter sheet
  $('#filterBtn').onclick=()=>$('#filterSheet').classList.toggle('hidden');
  $('#applyFilter').onclick=()=>{ $('#filterSheet').classList.add('hidden'); updateFilterLabel(); rebuildDeck(false); };
  $('#shuffleBtn').onclick=()=>{ rebuildDeck(true); toast('Перемешано 🔀'); };

  // exam
  $('#startExamBtn').onclick=startExam;
  $('#examPrev').onclick=()=>examGo(-1);
  $('#examNext').onclick=()=>examGo(1);
  $('#finishExamBtn').onclick=()=>finishExam(false);

  // profile
  $('#resetBtn').onclick=()=>{ if(confirm('Сбросить весь прогресс (выученное, статистику, экзамены, позицию в вопросах)?')){ App.learnedBase.clear(); App.learnedCustom.clear(); App.stats={answered:0,correct:0}; App.examHistory.forEach(h=>{ Local.del('exd'+h.ts); Store.remove('exd'+h.ts); }); App.examHistory=[]; saveProgress(); saveExams(); Local.del('examRun'); for(const k in practice) delete practice[k]; Local.set('practice','{}'); deck.currentId=null; deck.pos=0; saveDeckMeta(); renderProfile(); rebuildDeck(false); renderExamHistory(); toast('Прогресс сброшен'); } };
  $('#adminOpenBtn').onclick=openAdmin;

  // admin modal
  $('#adminClose').onclick=closeAdmin;
  $('#adminModal').addEventListener('click',e=>{ if(e.target.id==='adminModal') closeAdmin(); });
  $$('.atab').forEach(b=>b.addEventListener('click',()=>adminTab(b.dataset.atab)));

  // keyboard (ПК)
  document.addEventListener('keydown',e=>{
    if(document.activeElement && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
    if(currentView==='all' && !(window.Study&&Study.writingActive())){ if(e.key==='ArrowRight') deckGo(1); if(e.key==='ArrowLeft') deckGo(-1); if(e.key.toLowerCase()==='l'||e.key.toLowerCase()==='в') toggleLearn(); }
    if(currentView==='exam'&&exam.running){ if(e.key==='ArrowRight') examGo(1); if(e.key==='ArrowLeft') examGo(-1); }
  });

  // сохранить прогресс при закрытии/сворачивании
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) flushSaves(); });
  window.addEventListener('pagehide', flushSaves);
}

/* =====================================================================
   BOOT
   ===================================================================== */
async function boot(){
  initTheme();
  initDesign();
  try{
    await loadData();
    await loadProgress();
  }catch(err){
    $('#splashSub').textContent='Ошибка загрузки базы 😔';
    console.error(err); return;
  }
  // Быстрая синхронизация прогресса в чат бота (кнопка «Профиль» → sendData → закрытие)
  const params = new URLSearchParams(location.search);
  if(params.get('sync')==='1' && TG && TG.sendData){
    const total=App.questions.length, learned=learnedCount();
    const acc=App.stats.answered?Math.round(App.stats.correct/App.stats.answered*100):0;
    const best=App.examHistory.length?Math.max(...App.examHistory.map(h=>h.score)):null;
    const extra=(window.Study&&Study.progressSummary)?Study.progressSummary():{};
    try{ TG.sendData(JSON.stringify(Object.assign({t:'progress',learned,total,acc,exams:App.examHistory.length,best},extra))); }catch(e){}
    return; // Telegram закроет приложение после sendData
  }
  detectAdmin();
  buildTypeChips(); updateFilterLabel();
  wire();
  window.QuizCore={ App, Store, Local, TG, CFG, esc, shuffle, toast, haptic, renderCard, evalExamQuestion, describeAnswer, interleave, switchView, tgUser, setLearned, saveProgress, deck, rebuildDeck, updateFilterLabel, buildTopicSelect, topicNum, get currentView(){ return currentView; } };
  if(window.Study) await Study.init(window.QuizCore);
  rebuildDeck(false);   // стабильный порядок + продолжаем с сохранённой позиции
  renderProfile();
  // синхронизация выбранного дизайна между устройствами (CloudStorage)
  Store.get('design').then(d=>{ if(d && DESIGN_IDS.includes(d) && d!==currentDesign()) applyDesign(d); });
  // deep-link на вкладку: ?tab=exam|profile|all  или  start_param
  let startTab = params.get('tab');
  const sp0 = TG && TG.initDataUnsafe && TG.initDataUnsafe.start_param;
  if(sp0 && ['theory','all','entry','exam','profile'].includes(sp0)) startTab = sp0;
  switchView(['theory','all','entry','exam','profile'].includes(startTab) ? startTab : 'theory');
  // hide splash
  const sp=$('#splash'); sp.classList.add('fade'); setTimeout(()=>sp.classList.add('hidden'),500);
  $('#app').classList.remove('hidden');
  if(TG){ try{ TG.MainButton && TG.MainButton.hide(); }catch(e){} }
}

document.addEventListener('DOMContentLoaded',boot);
})();
