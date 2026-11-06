/* Облачный режим EduLOG: вход, общие данные и раздел администратора.
   Работает поверх Supabase (Auth + REST/PostgREST) обычными fetch-запросами,
   без сторонних библиотек. Включается, только если в config.js заданы
   supabaseUrl и supabaseAnonKey; иначе приложение работает локально, как раньше. */
(function(){
'use strict';
const A=window.EduLOG;
if(!A||!A.CLOUD) return;
const $=s=>document.querySelector(s);
const esc=A.esc;
// Допускается полный адрес (https://<ref>.supabase.co) или только идентификатор проекта.
const BASE=(u=>/^[a-z0-9]{10,40}$/i.test(u)?`https://${u}.supabase.co`:/^[a-z]+:\/\//i.test(u)?u:'https://'+u)(A.CFG.supabaseUrl.trim()).replace(/\/+$/,'');
const KEY=A.CFG.supabaseAnonKey;
const SKEY='edulog-auth';

const ROLES={pending:'Ожидает',viewer:'Просмотр',editor:'Редактор',admin:'Администратор',blocked:'Заблокирован'};
const ROLE_HINT={
  pending:'зарегистрировался, данных не видит',
  viewer:'видит план, расписание и зачёты',
  editor:'публикует файлы и отмечает зачёты',
  admin:'всё, плюс пользователи и журнал',
  blocked:'доступ закрыт',
};

/* ---------- Сессия и запросы ---------- */
let S=null;      // {access_token, refresh_token, expires_at, user}
let ME=null;     // строка из profiles
try{S=JSON.parse(localStorage.getItem(SKEY)||'null')}catch(e){}
function keep(sess){
  S=sess?{access_token:sess.access_token,refresh_token:sess.refresh_token,
    expires_at:sess.expires_at||Math.floor(Date.now()/1000)+(+sess.expires_in||3600),user:sess.user||(S&&S.user)||null}:null;
  try{S?localStorage.setItem(SKEY,JSON.stringify(S)):localStorage.removeItem(SKEY)}catch(e){}
}
function errText(j,status){
  const m=j&&(j.msg||j.message||j.error_description||j.error)||'';
  const map=[
    [/invalid login credentials/i,'Неверный email или пароль.'],
    [/email not confirmed/i,'Email не подтверждён: откройте ссылку из письма.'],
    [/user already registered/i,'Этот email уже зарегистрирован. Войдите или восстановите пароль.'],
    [/password should be at least/i,'Пароль слишком короткий (минимум 6 символов).'],
    [/rate limit|too many/i,'Слишком много попыток. Подождите минуту и повторите.'],
    [/row-level security|permission denied/i,'Недостаточно прав для этого действия.'],
    [/jwt expired/i,'Сессия истекла, войдите снова.'],
    [/signups not allowed/i,'Регистрация отключена администратором.'],
  ];
  for(const [re,t] of map) if(re.test(m)) return t;
  return m||('Ошибка сервера ('+status+').');
}
async function raw(path,opt){
  opt=opt||{};
  const h=Object.assign({apikey:KEY,'Content-Type':'application/json'},opt.headers||{});
  h.Authorization='Bearer '+(opt.anon||!S?KEY:S.access_token);
  let r;
  try{r=await fetch(BASE+path,{method:opt.method||'GET',headers:h,body:opt.body==null?undefined:JSON.stringify(opt.body)})}
  catch(e){throw new Error('Нет связи с сервером. Проверьте интернет.')}
  const txt=await r.text();let j=null;
  try{j=txt?JSON.parse(txt):null}catch(e){j=null}
  if(!r.ok){const e=new Error(errText(j,r.status));e.status=r.status;e.body=j;throw e}
  return j;
}
let refreshing=null;
async function refresh(){
  if(!S||!S.refresh_token) throw Object.assign(new Error('Сессия истекла, войдите снова.'),{status:401});
  if(!refreshing) refreshing=raw('/auth/v1/token?grant_type=refresh_token',{method:'POST',anon:true,body:{refresh_token:S.refresh_token}})
    .then(j=>{keep(j);return j}).finally(()=>{refreshing=null});
  return refreshing;
}
async function api(path,opt){
  if(S&&S.expires_at-60<Date.now()/1000){try{await refresh()}catch(e){if(e.status&&e.status<500){signedOut();throw e}}}
  try{return await raw(path,opt)}
  catch(e){
    if(e.status===401&&S){
      try{await refresh()}catch(e2){signedOut();throw e2}
      return raw(path,opt);
    }
    throw e;
  }
}
const q=v=>encodeURIComponent(v);
const redirectTo=()=>location.href.split('#')[0];

/* ---------- Данные ---------- */
let META={};     // kind -> {name, updated_at, author, size}; для расписания ещё ver (номер последней загрузки) и weeks
let SCHED_DB=true; // false — в базе ещё нет таблиц sched_weeks / sched_uploads (не выполнена новая версия schema.sql)
const SCHEMA_HINT='В базе нет таблиц расписания по неделям: администратору нужно ещё раз выполнить supabase/schema.sql в Supabase → SQL Editor.';
const missingTable=e=>e&&(e.status===404||/PGRST205|does not exist|schema cache/i.test((e.body&&(e.body.code+' '+e.body.message))||e.message||''));
async function fetchSched(){
  try{
    const [rows,ups]=await Promise.all([
      api('/rest/v1/sched_weeks?select=wkey,content'),
      api('/rest/v1/sched_uploads?select=id,at,author,file,summary&order=id.desc&limit=60'),
    ]);
    SCHED_DB=true;return {rows:rows||[],ups:ups||[]};
  }catch(e){if(missingTable(e)){SCHED_DB=false;return null}throw e}
}
function schedMeta(rows,ups){
  const u=ups[0];
  return {name:(ups.find(x=>x.file)||{}).file||'',updated_at:u.at,author:u.author,ver:u.id,weeks:rows.length,size:rows.reduce((a,r)=>a+(r.content||'').length,0)};
}
async function loadData(){
  const [ds,zs,sd]=await Promise.all([
    api('/rest/v1/datasets?select=kind,name,content,author,updated_at,size'),
    api('/rest/v1/zachety?select=grp,code'),
    fetchSched(),
  ]);
  A.clear();META={};
  for(const d of ds||[]){
    META[d.kind]={name:d.name,updated_at:d.updated_at,author:d.author,size:d.size,legacy:d.kind==='sched'};
    try{A.load(d.kind,d.content,d.name,META[d.kind])}catch(e){A.toast(e.message,true)}
  }
  // Расписание по неделям: если загрузки уже были, база — таблица sched_weeks,
  // иначе — расписание, опубликованное раньше одним файлом (перенесётся при первой публикации).
  if(sd&&sd.ups.length){META.sched=schedMeta(sd.rows,sd.ups);A.loadSchedDB(sd.rows,sd.ups,META.sched)}
  A.setFlags(zs||[]);
  A.refresh();
  if(!SCHED_DB&&canEdit()) A.toast(SCHEMA_HINT,true);
}
// Тихо подтянуть изменения, если кто-то опубликовал новое или поменял зачёты.
let lastCheck=0;
async function checkUpdates(){
  if(!canRead()||Date.now()-lastCheck<15000) return;
  lastCheck=Date.now();
  try{
    const [ds,zs,top]=await Promise.all([
      api('/rest/v1/datasets?select=kind,name,author,updated_at,size'),
      api('/rest/v1/zachety?select=grp,code'),
      // спрашиваем всегда: если таблиц не было, а schema.sql уже выполнили, расписание подтянется без перезагрузки
      api('/rest/v1/sched_uploads?select=id&order=id.desc&limit=1').then(r=>{SCHED_DB=true;return r},e=>{if(missingTable(e)) SCHED_DB=false;return null}),
    ]);
    let changed=false;
    const schedLocal=A.sched&&A.sched.local;
    const ver=top&&top[0]?top[0].id:null;
    if(ver!=null&&!(META.sched&&META.sched.ver===ver)&&!schedLocal){
      const sd=await fetchSched();
      if(sd&&sd.ups.length){META.sched=schedMeta(sd.rows,sd.ups);A.loadSchedDB(sd.rows,sd.ups,META.sched);changed=true}
    }
    const hasDB=!!(META.sched&&META.sched.ver!=null);
    for(const d of ds||[]){
      if(d.kind==='sched'&&hasDB) continue;
      const m=META[d.kind];const cur=d.kind==='plan'?A.plan:A.sched;
      if((!m||m.updated_at!==d.updated_at)&&!(cur&&cur.local)){
        const full=await api('/rest/v1/datasets?select=content&kind=eq.'+q(d.kind));
        if(full&&full[0]){META[d.kind]={name:d.name,updated_at:d.updated_at,author:d.author,size:d.size,legacy:d.kind==='sched'};A.load(d.kind,full[0].content,d.name,META[d.kind]);changed=true}
      }
    }
    for(const k of Object.keys(META)){
      if(k==='sched'&&hasDB) continue;
      if(!(ds||[]).some(d=>d.kind===k)){delete META[k];const cur=k==='plan'?A.plan:A.sched;if(cur&&!cur.local){A.clear(k);changed=true}}
    }
    if(!flagBusy) A.setFlags(zs||[]);
    if(changed) A.toast('Загружена новая версия опубликованных данных');
    A.refresh();
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden) checkUpdates()});
addEventListener('focus',checkUpdates);
// и раз в минуту, пока вкладка открыта на экране: чужие публикации и отметки зачётов видны без перезагрузки
setInterval(()=>{if(!document.hidden) checkUpdates()},60000);
// неопубликованные загрузки хранятся только в этой вкладке — предупреждаем перед закрытием
addEventListener('beforeunload',e=>{if(canEdit()&&[A.plan,A.sched].some(o=>o&&o.local)){e.preventDefault();e.returnValue=''}});

let flagBusy=0; // отметки зачётов, ещё не дошедшие до базы: пока они в пути, фоновое обновление их не перезаписывает
/* pairs — [[группы, код], …]: одна отметка или сразу все строки таблицы */
async function saveFlags(pairs,on){
  flagBusy++;
  try{await writeFlags(pairs,on)}finally{flagBusy--}
}
async function writeFlags(pairs,on){
  if(on){
    const rows=[],seen=new Set();
    for(const [gs,code] of pairs) for(const g of gs){const k=g+'\n'+code;if(!seen.has(k)){seen.add(k);rows.push({grp:g,code})}}
    await api('/rest/v1/zachety?on_conflict=grp,code',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:rows});
    return;
  }
  const by=new Map();for(const [gs,code] of pairs) for(const g of gs) (by.get(g)||by.set(g,new Set()).get(g)).add(code);
  await Promise.all([...by].map(([g,cs])=>api('/rest/v1/zachety?grp=eq.'+q(g)+'&code=in.'+q(inList([...cs])),{method:'DELETE',headers:{Prefer:'return=minimal'}})));
}
const saveFlag=(groups,code,on)=>saveFlags([[groups,code]],on);
/* Одна загрузка расписания: недели сравниваются с тем, что сейчас в базе на сервере
   (а не с тем, что было открыто), поэтому журнал верен, даже если кто-то успел опубликовать раньше. */
const inList=keys=>'('+keys.map(k=>'"'+String(k).replace(/["\\]/g,'')+'"').join(',')+')';
async function applySchedOp(op){
  const keys=[...op.put.map(w=>w.k),...op.del];
  const rows=keys.length?await api('/rest/v1/sched_weeks?select=wkey,content&wkey=in.'+q(inList(keys))):[];
  const base=new Map();for(const r of rows||[]){try{const c=JSON.parse(r.content);c.k=r.wkey;base.set(r.wkey,c)}catch(e){}}
  const {entry}=A.computeUpload(base,op);
  if(!entry.weeks.length) return;
  await api('/rest/v1/rpc/sched_apply',{method:'POST',body:{
    p_file:op.file||'',
    p_put:op.put.map(w=>({wkey:w.k,week:w.week,date_start:w.start,date_end:w.end,lessons:w.l.length,content:JSON.stringify(w)})),
    p_del:op.del,
    p_summary:{weeks:entry.weeks,ch:entry.ch,migrate:!!op.migrate},
  }});
}
async function publishSched(){
  if(!SCHED_DB) throw new Error(SCHEMA_HINT);
  // Загрузки отправляются по одной; отправленная сразу убирается из очереди,
  // чтобы после сбоя на середине повторная публикация не записала её второй раз.
  let op;
  while((op=A.schedPending()[0])){await applySchedOp(op);A.schedSent()}
  // старую запись «расписание одним файлом» больше не используем
  if(META.sched&&META.sched.legacy) await api('/rest/v1/datasets?kind=eq.sched',{method:'DELETE',headers:{Prefer:'return=minimal'}}).catch(()=>{});
  // после публикации показываем ровно то, что лежит в базе
  const sd=await fetchSched();
  if(sd&&sd.ups.length){META.sched=schedMeta(sd.rows,sd.ups);A.loadSchedDB(sd.rows,sd.ups,META.sched)}
  else{delete META.sched;A.clear('sched')}
}
async function publish(){
  const items=[['plan',A.plan],['sched',A.sched]].filter(([,o])=>o&&o.local);
  if(!items.length) return;
  const btn=$('#pubBtn');btn.disabled=true;btn.textContent='Публикую…';
  try{
    for(const [kind,o] of items){
      if(kind==='sched'){await publishSched();continue}
      const rows=await api('/rest/v1/datasets',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},
        body:{kind,name:o.file||o.name,content:o.raw}});
      const r=rows&&rows[0]||{};
      META[kind]={name:r.name,updated_at:r.updated_at,author:r.author,size:r.size};
      A.markPublished(kind,META[kind]);
    }
    A.toast(items.length>1?'План и расписание опубликованы для всех':(items[0][0]==='plan'?'План опубликован для всех':'Изменения расписания опубликованы для всех'));
  }catch(e){A.toast(e.message,true)}
  finally{btn.disabled=false;btn.textContent='Опубликовать';A.refresh()}
}
async function revert(){
  try{await loadData();A.toast('Показаны опубликованные данные')}catch(e){A.toast(e.message,true)}
}

/* ---------- Права ---------- */
const role=()=>ME?ME.role:'anon';
const canRead=()=>['viewer','editor','admin'].includes(role());
const canEdit=()=>['editor','admin'].includes(role());
const isAdmin=()=>role()==='admin';

/* ---------- Экран входа ---------- */
const gate=document.createElement('div');
gate.className='gate';gate.id='gate';gate.hidden=true;
document.body.appendChild(gate);
let gateMode='in';
function field(id,label,type,extra){return `<label class="fld"><span>${label}</span><input id="${id}" type="${type}" ${extra||''}></label>`}
function showGate(mode,note,isErr){
  gateMode=mode||gateMode;
  document.body.classList.add('gated');gate.hidden=false;
  const msg=note?`<p class="gmsg${isErr?' err':''}" role="${isErr?'alert':'status'}">${esc(note)}</p>`:'';
  const brand=`<p class="brand">План и расписание</p>`;
  let body='';
  if(gateMode==='in'||gateMode==='up'){
    body=`<div class="gtabs" role="tablist">
        <button type="button" role="tab" data-gm="in" aria-selected="${gateMode==='in'}">Вход</button>
        <button type="button" role="tab" data-gm="up" aria-selected="${gateMode==='up'}">Регистрация</button></div>
      <form id="gform" novalidate>
        ${gateMode==='up'?field('gName','Имя и фамилия','text','autocomplete="name" maxlength="200" required'):''}
        ${field('gEmail','Email','email','autocomplete="email" required')}
        ${field('gPass','Пароль','password',`autocomplete="${gateMode==='up'?'new-password':'current-password'}" minlength="6" required`)}
        ${msg}
        <button class="btn wide" type="submit">${gateMode==='up'?'Зарегистрироваться':'Войти'}</button>
        ${gateMode==='in'?'<button type="button" class="link sm" data-gm="reset">Забыли пароль?</button>':'<p class="gnote">После регистрации администратор должен одобрить доступ.</p>'}
      </form>`;
  }else if(gateMode==='reset'){
    body=`<h2>Восстановление пароля</h2><form id="gform" novalidate>
        ${field('gEmail','Email','email','autocomplete="email" required')}${msg}
        <button class="btn wide" type="submit">Прислать ссылку</button>
        <button type="button" class="link sm" data-gm="in">Назад ко входу</button></form>`;
  }else if(gateMode==='newpass'){
    body=`<h2>Новый пароль</h2><form id="gform" novalidate>
        ${field('gPass','Новый пароль','password','autocomplete="new-password" minlength="6" required')}${msg}
        <button class="btn wide" type="submit">Сохранить</button></form>`;
  }else if(gateMode==='pending'||gateMode==='blocked'){
    const pend=gateMode==='pending';
    body=`<h2>${pend?'Заявка на доступ отправлена':'Доступ закрыт'}</h2>
      <p class="gnote">${pend?'Администратор должен одобрить вашу учётную запись. После этого обновите страницу.':'Администратор закрыл доступ для этой учётной записи.'}</p>
      <p class="gnote">Вы вошли как <b>${esc(ME&&ME.email||'')}</b></p>${msg}
      <div class="grow">${pend?'<button class="btn" type="button" data-gact="recheck">Проверить снова</button>':''}
      <button class="btn ghost" type="button" data-gact="out">Выйти</button></div>`;
  }else if(gateMode==='loading'){
    body=`<p class="gnote">Загрузка…</p>${msg}`;
  }
  gate.innerHTML=`<section class="gate-p" aria-labelledby="gateTitle"><div id="gateTitle">${brand}</div>${body}</section>`;
  const f=gate.querySelector('input');if(f) f.focus();
}
function hideGate(){gate.hidden=true;document.body.classList.remove('gated')}
gate.addEventListener('click',e=>{
  const m=e.target.closest('[data-gm]');if(m){showGate(m.dataset.gm);return}
  const a=e.target.closest('[data-gact]');if(!a) return;
  if(a.dataset.gact==='out') signOut();
  if(a.dataset.gact==='recheck') boot();
});
gate.addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=gate.querySelector('button[type=submit]');
  const v=id=>{const el=$('#'+id);return el?el.value.trim():''};
  const email=v('gEmail'),pass=$('#gPass')?$('#gPass').value:'',name=v('gName');
  if((gateMode==='in'||gateMode==='up'||gateMode==='reset')&&!/^\S+@\S+\.\S+$/.test(email)) return showGate(null,'Введите корректный email.',true),($('#gEmail').value=email);
  if((gateMode!=='reset')&&pass.length<6){const keepE=email,keepN=name;showGate(null,'Пароль должен быть не короче 6 символов.',true);if($('#gEmail')) $('#gEmail').value=keepE;if($('#gName')) $('#gName').value=keepN;return}
  if(gateMode==='up'&&!name){showGate(null,'Укажите имя — так администратор поймёт, кто вы.',true);$('#gEmail').value=email;return}
  btn.disabled=true;
  try{
    if(gateMode==='in'){
      keep(await raw('/auth/v1/token?grant_type=password',{method:'POST',anon:true,body:{email,password:pass}}));
      await boot();
    }else if(gateMode==='up'){
      const j=await raw('/auth/v1/signup?redirect_to='+q(redirectTo()),{method:'POST',anon:true,body:{email,password:pass,data:{full_name:name}}});
      if(j&&j.access_token){keep(j);await boot()}
      else showGate('in','Мы отправили письмо на '+email+'. Откройте ссылку из него, чтобы подтвердить email, затем войдите.');
    }else if(gateMode==='reset'){
      await raw('/auth/v1/recover?redirect_to='+q(redirectTo()),{method:'POST',anon:true,body:{email}});
      showGate('in','Если такой email зарегистрирован, на него придёт ссылка для смены пароля.');
    }else if(gateMode==='newpass'){
      await api('/auth/v1/user',{method:'PUT',body:{password:pass}});
      A.toast('Пароль изменён');await boot();
    }
  }catch(err){
    showGate(null,err.message,true);
    if($('#gEmail')) $('#gEmail').value=email;if($('#gName')) $('#gName').value=name;
  }finally{if(btn.isConnected) btn.disabled=false}
});

/* ---------- Шапка: пользователь, публикация, админка ---------- */
const files=$('.files');
const pub=document.createElement('span');pub.className='pub';pub.hidden=true;
pub.innerHTML='<button class="btn" id="pubBtn" type="button">Опубликовать</button><button class="btn ghost" id="revBtn" type="button" title="Отказаться от открытых файлов и показать опубликованные">Вернуть опубликованное</button>';
files.insertBefore(pub,files.querySelector('.pmenu'));
$('#pubBtn').addEventListener('click',publish);
$('#revBtn').addEventListener('click',revert);
const me=document.createElement('div');me.className='me';me.hidden=true;
$('.top').appendChild(me);
me.addEventListener('click',e=>{if(e.target.closest('[data-out]')) signOut()});
const adminTab=document.createElement('button');
adminTab.setAttribute('role','tab');adminTab.dataset.view='admin';adminTab.id='view-admin';adminTab.textContent='Администрирование';adminTab.hidden=true;
$('.seg').appendChild(adminTab);

function onSources(){
  const local=[A.plan,A.sched].some(o=>o&&o.local);
  pub.hidden=!local||!canRead();
  $('#pubBtn').hidden=!canEdit();
}
function renderMe(){
  if(!ME){me.hidden=true;adminTab.hidden=true;return}
  me.hidden=false;adminTab.hidden=!isAdmin();
  me.innerHTML=`<span class="who" title="${esc(ME.email)}">${esc(ME.full_name||ME.email)}</span><span class="pill mute">${esc(ROLES[ME.role]||ME.role)}</span><button class="btn ghost sm" type="button" data-out>Выйти</button>`;
}

/* ---------- Вход / выход ---------- */
function signedOut(note){
  keep(null);ME=null;META={};A.clear();A.setFlags([]);A.setCanFlag(false);renderMe();
  if(A.view==='admin') A.setView('plan');else A.refresh();
  showGate('in',note);
}
async function signOut(){
  try{if(S) await raw('/auth/v1/logout',{method:'POST'})}catch(e){}
  signedOut();
}
async function loadMe(){
  const uid=S&&S.user&&S.user.id;
  if(!uid){const u=await api('/auth/v1/user');S.user=u;keep(S)}
  const rows=await api('/rest/v1/profiles?select=*&id=eq.'+q(S.user.id));
  ME=rows&&rows[0]||null;
  if(!ME) throw new Error('Профиль не найден. Проверьте, что SQL-скрипт supabase/schema.sql выполнен.');
}
async function boot(){
  if(!S){signedOut();return}
  showGate('loading');
  try{
    await loadMe();
  }catch(e){
    if(e.status===401||e.status===403){signedOut('Сессия истекла, войдите снова.');return}
    showGate('loading',e.message,true);
    gate.querySelector('.gate-p').insertAdjacentHTML('beforeend','<div class="grow"><button class="btn" type="button" data-gact="recheck">Повторить</button><button class="btn ghost" type="button" data-gact="out">Выйти</button></div>');
    return;
  }
  renderMe();
  if(ME.role==='pending'||ME.role==='blocked'){showGate(ME.role);return}
  A.setCanFlag(canEdit());
  try{await loadData()}catch(e){A.toast(e.message,true)}
  lastCheck=Date.now();
  hideGate();
}

// Возврат по ссылке из письма: #access_token=…&refresh_token=…&type=signup|recovery
function fromHash(){
  const h=location.hash.replace(/^#/,'');
  if(!/access_token=|error=/.test(h)) return null;
  const p=new URLSearchParams(h);
  history.replaceState(null,'',location.pathname+location.search);
  if(p.get('error')) return {error:(p.get('error_description')||p.get('error')).replace(/\+/g,' ')};
  keep({access_token:p.get('access_token'),refresh_token:p.get('refresh_token'),expires_in:+p.get('expires_in')||3600,expires_at:+p.get('expires_at')||0,user:null});
  return {type:p.get('type')};
}

/* ---------- Раздел администратора ---------- */
let ADM={users:[],log:[],tab:'users',loading:false,err:''};
const ACT={
  'dataset.publish':d=>`опубликовал(а) ${d.kind==='plan'?'план':'расписание'} «${d.name}»`,
  'dataset.delete':d=>`снял(а) с публикации ${d.kind==='plan'?'план':'расписание'} «${d.name}»`,
  'sched.upload':d=>d.file?`загрузил(а) расписание «${d.file}»: ${schedWeeksText(d.weeks||[])}`:`удалил(а) из расписания ${schedWeeksText(d.weeks||[])}`,
  'zachet.on':d=>`отметил(а) зачёт ${d.code} у группы ${d.group}`,
  'zachet.off':d=>`снял(а) зачёт ${d.code} у группы ${d.group}`,
  'user.register':d=>`регистрация ${d.email}${d.role==='admin'?' (первый пользователь — администратор)':''}`,
  'user.role':d=>`${d.email}: ${ROLES[d.from]||d.from} → ${ROLES[d.to]||d.to}`,
  'user.delete':d=>`удалён пользователь ${d.email}`,
};
function schedWeeksText(ws){
  const T={new:'новая',upd:'обновлена',same:'без изменений',del:'удалена'};
  return ws.map(w=>`нед. ${w.week||w.k} — ${T[w.st]||w.st}`).join(', ')||'без изменений';
}
async function loadAdmin(){
  ADM.loading=true;ADM.err='';
  try{
    const [u,l]=await Promise.all([
      api('/rest/v1/profiles?select=*&order=created_at.desc'),
      api('/rest/v1/audit_log?select=*&order=id.desc&limit=300'),
    ]);
    ADM.users=u||[];ADM.log=l||[];
  }catch(e){ADM.err=e.message}
  ADM.loading=false;
}
const fmt=iso=>A.fmtStamp(iso);
function roleSelect(u){
  const self=u.id===ME.id;
  return `<select class="rsel" data-uid="${esc(u.id)}" aria-label="Роль: ${esc(u.email)}"${self?' disabled title="Свою роль поменять нельзя"':''}>`+
    Object.keys(ROLES).map(r=>`<option value="${r}"${r===u.role?' selected':''}>${ROLES[r]}</option>`).join('')+'</select>';
}
function renderAdmin(main){
  if(!ADM.loaded&&!ADM.loading){ADM.loaded=true;loadAdmin().then(()=>{if(A.view==='admin') renderAdmin($('#main'))});}
  const pend=ADM.users.filter(u=>u.role==='pending');
  const counts={};for(const u of ADM.users) counts[u.role]=(counts[u.role]||0)+1;
  const tabs=[['users','Пользователи'+(pend.length?` <span class="pill warn">${pend.length}</span>`:'')],['data','Данные'],['log','Журнал']];
  let body='';
  if(ADM.loading&&!ADM.users.length) body='<div class="panel msg"><p>Загрузка…</p></div>';
  else if(ADM.err) body=`<div class="panel msg"><h2>Не удалось загрузить</h2><p>${esc(ADM.err)}</p><button class="btn" data-adm="reload">Повторить</button></div>`;
  else if(ADM.tab==='users'){
    const pendHtml=pend.length?`<section class="panel"><h2>Заявки на доступ · ${pend.length}</h2><div class="reqs">`+pend.map(u=>`
      <div class="req"><div><b>${esc(u.full_name||'Без имени')}</b><div class="sub">${esc(u.email)} · ${esc(fmt(u.created_at))}</div></div>
      <span class="sp"></span>
      <button class="btn sm" data-set="viewer" data-uid="${esc(u.id)}">Одобрить: просмотр</button>
      <button class="btn ghost sm" data-set="editor" data-uid="${esc(u.id)}">Редактор</button>
      <button class="btn ghost sm danger" data-set="blocked" data-uid="${esc(u.id)}">Отклонить</button></div>`).join('')+'</div></section>':'';
    body=pendHtml+`<section class="panel"><h2>Все пользователи · ${ADM.users.length}
        <span class="legend">${Object.keys(ROLES).filter(r=>counts[r]).map(r=>`${ROLES[r]}: ${counts[r]}`).join(' · ')}</span></h2>
      <div class="tbl-wrap"><table class="adm"><thead><tr><th>Пользователь</th><th>Email</th><th class="opt">Зарегистрирован</th><th>Роль</th></tr></thead><tbody>`+
      ADM.users.map(u=>`<tr${u.role==='blocked'?' class="off"':''}><td>${esc(u.full_name||'—')}${u.id===ME.id?' <span class="pill mute">вы</span>':''}</td><td>${esc(u.email)}</td><td class="num opt">${esc(fmt(u.created_at))}</td><td>${roleSelect(u)}</td></tr>`).join('')+
      `</tbody></table></div>
      <p class="note">${Object.keys(ROLES).map(r=>`<b>${ROLES[r]}</b> — ${ROLE_HINT[r]}`).join('; ')}. Чтобы удалить аккаунт полностью, используйте Supabase → Authentication → Users.</p></section>`;
  }else if(ADM.tab==='data'){
    const row=(kind,title)=>{const m=META[kind];return `<tr><td>${title}</td>${m?`<td>${esc(m.name)}${m.weeks!=null?`<div class="sub">${m.weeks} нед. в базе</div>`:''}</td><td class="num">${(m.size/1024).toFixed(0)} КБ</td><td>${esc(m.author||'—')}</td><td class="num">${esc(fmt(m.updated_at))}</td><td><button class="btn ghost sm danger" data-unpub="${kind}">Снять с публикации</button></td>`:'<td colspan="5" class="sub">не опубликовано</td>'}</tr>`};
    body=`<section class="panel"><h2>Опубликованные файлы</h2><div class="tbl-wrap"><table class="adm"><thead><tr><th></th><th>Файл</th><th>Размер</th><th>Опубликовал(а)</th><th>Когда</th><th></th></tr></thead><tbody>
      ${row('plan','План')}${row('sched','Расписание')}</tbody></table></div>
      ${SCHED_DB?'':`<p class="note err">${esc(SCHEMA_HINT)}</p>`}
      <p class="note">Новую версию публикует редактор или администратор: «Открыть файлы…» в шапке, затем «Опубликовать». Все пользователи увидят её при следующем открытии вкладки.</p></section>`;
  }else{
    body=`<section class="panel"><h2>Журнал действий <span class="legend">последние ${ADM.log.length}</span></h2>`+
      (ADM.log.length?`<div class="tbl-wrap"><table class="adm"><thead><tr><th>Когда</th><th>Кто</th><th>Что</th></tr></thead><tbody>`+
      ADM.log.map(l=>`<tr><td class="num">${esc(fmt(l.at))}</td><td>${esc(l.email||'—')}</td><td>${esc((ACT[l.action]||(()=>l.action))(l.details||{}))}</td></tr>`).join('')+
      '</tbody></table></div>':'<p class="note">Записей пока нет.</p>')+'</section>';
  }
  main.innerHTML=`<section class="head"><div class="head-l"><span class="eyebrow">Администрирование</span><h1>Доступ и данные</h1></div>
      <span class="sp"></span><button class="btn ghost sm" data-adm="reload">Обновить</button></section>
    <div class="gtabs adm-tabs" role="tablist">${tabs.map(([k,t])=>`<button type="button" role="tab" data-atab="${k}" aria-selected="${ADM.tab===k}">${t}</button>`).join('')}</div>
    <div class="adm-body">${body}</div>`;
}
async function setRole(uid,r){
  const u=ADM.users.find(x=>x.id===uid);if(!u) return;
  try{
    const rows=await api('/rest/v1/profiles?id=eq.'+q(uid),{method:'PATCH',headers:{Prefer:'return=representation'},body:{role:r}});
    if(!rows||!rows.length) throw new Error('Недостаточно прав для этого действия.');
    Object.assign(u,rows[0]);
    A.toast(`${u.full_name||u.email}: ${ROLES[r]}`);
  }catch(e){A.toast(e.message,true)}
  await loadAdmin();if(A.view==='admin') renderAdmin($('#main'));
}
document.addEventListener('click',async e=>{
  if(A.view!=='admin') return;
  const t=e.target.closest('[data-atab]');if(t){ADM.tab=t.dataset.atab;renderAdmin($('#main'));return}
  const s=e.target.closest('[data-set]');if(s){s.disabled=true;setRole(s.dataset.uid,s.dataset.set);return}
  if(e.target.closest('[data-adm="reload"]')){await Promise.all([loadAdmin(),loadData().catch(err=>A.toast(err.message,true))]);renderAdmin($('#main'));return}
  const up=e.target.closest('[data-unpub]');
  if(up){
    const kind=up.dataset.unpub;
    if(up.dataset.sure!=='1'){up.dataset.sure='1';up.textContent='Точно снять?';setTimeout(()=>{if(up.isConnected){up.dataset.sure='';up.textContent='Снять с публикации'}},4000);return}
    try{
      if(kind==='sched'&&META.sched&&META.sched.ver!=null){
        const ks=await api('/rest/v1/sched_weeks?select=wkey,week,date_start,date_end,lessons');
        await api('/rest/v1/rpc/sched_apply',{method:'POST',body:{p_file:'',p_put:[],p_del:(ks||[]).map(r=>r.wkey),
          p_summary:{weeks:(ks||[]).map(r=>({k:r.wkey,week:r.week,start:r.date_start,end:r.date_end,st:'del',n:r.lessons})),ch:{}}}});
      }
      await api('/rest/v1/datasets?kind=eq.'+q(kind),{method:'DELETE',headers:{Prefer:'return=minimal'}});
      A.toast('Снято с публикации');await loadData()}catch(err){A.toast(err.message,true)}
    await loadAdmin();A.setView('admin');
  }
});
document.addEventListener('change',e=>{
  const s=e.target.closest('.rsel');if(!s||A.view!=='admin') return;
  setRole(s.dataset.uid,s.value);
});

/* ---------- Экспорт для app.js ---------- */
window.EduLOGCloud={saveFlag,saveFlags,isAdmin,renderAdmin,onSources};

/* ---------- Старт ---------- */
(async()=>{
  const h=fromHash();
  if(h&&h.error){signedOut('Ссылка недействительна или устарела: '+h.error);return}
  if(h&&h.type==='recovery'){try{await loadMe();renderMe()}catch(e){}showGate('newpass');return}
  await boot();
  if(h&&h.type==='signup'&&ME&&ME.role==='pending') A.toast('Email подтверждён');
})();
})();
