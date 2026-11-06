(function(){
'use strict';
// Облачный режим включается, если в config.js заданы адрес и ключ Supabase (см. cloud.js).
const CFG=window.EDULOG_CONFIG||{};
const CLOUD=!!(CFG.supabaseUrl&&CFG.supabaseAnonKey);
let CAN_FLAG=!CLOUD;
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const plural=(n,a,b,c)=>{const m=n%10,h=n%100;return m===1&&h!==11?a:(m>=2&&m<=4&&(h<10||h>=20)?b:c)};
const coll=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
const DAYS=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const DEFAULT_TIMES={1:['08:30','10:00'],2:['10:10','11:40'],3:['12:10','13:40'],4:['13:50','15:20'],5:['15:50','17:20'],6:['17:30','19:00'],7:['19:10','20:40'],8:['20:50','22:20']};

/* ---------- Преподаватели: единый ключ для плана и расписания ----------
   «Михайличенко С.» (обрезано в плане) и «Михайличенко С.В.» — один человек: ключ по фамилии и первой букве инициалов.
   Суффикс «-2» — отдельная запись (в расписании «Мещеряков А.А.» и «Мещеряков А.А-2» ведут занятия одновременно). */
function tparse(raw){
  raw=String(raw||'').trim(); if(!raw) return null;
  if(/^вакант/i.test(raw)) return {raw,base:'ВАКАНТ',variant:'',bkey:'вакант',key:'вакант'};
  const vm=raw.match(/-(\d+)$/); const variant=vm?'-'+vm[1]:'';
  let base=raw.replace(/-\d+$/,'').trim();
  if(/[А-ЯЁA-Z]$/.test(base)) base+='.';
  const m=base.match(/^(\S+)\s+([А-ЯЁA-Z])/);
  const bkey=(m?m[1]+' '+m[2]:base).toLowerCase().replace(/ё/g,'е');
  return {raw,base,variant,bkey,key:bkey+variant};
}

/* ---------- Разбор плана (.txt, фиксированные колонки) ---------- */
const ROW=/^\s*[¦|│║]/;
const TAIL=/^\s*(по\s*\d+)?\s*(ВАКАНТ|[А-ЯЁA-Z][А-Яа-яЁёA-Za-z\-]*\s+[А-ЯЁA-Z]\.(?:\s?[А-ЯЁA-Z]\.?)?(?:-\d+)?)?\s*(\d\s*-?\s*я\s*п\/г|Поток|\(П\/П\))?\s*(.*?)\s*$/;
function parseHeader(line){
  const kak=line.indexOf('Как?'); const w=line.indexOf('--1');
  const seg=line.slice(w<0?0:w,kak<0?undefined:kak);
  return {kak,weeks:(seg.match(/\d+/g)||[]).length||30};
}
function parsePlan(text){
  text=text.replace(/^﻿/,'');
  const groups=[];let g=null,H=null;
  for(const raw of text.split(/\r?\n/)){
    const gm=raw.match(/Группа:\s*(\S+)\s+Студентов:\s*(\d+)/);
    if(gm){g={name:gm[1],students:+gm[2],rows:[],status:'',plan:null,totals:null};groups.push(g);H=null;continue}
    if(!g) continue;
    if(raw.includes('Дисциплина')&&raw.includes('Часы')){H=parseHeader(raw);continue}
    if(!H||!ROW.test(raw)) continue;
    const eq=raw.indexOf('=');if(eq<0) continue;
    const label=raw.slice(0,eq).replace(ROW,'').trim(); if(!label) continue;
    const end=H.kak>eq?H.kak:raw.length;
    const tok=raw.slice(eq+1,end).trim().split(/\s+/);
    const hm=(tok[0]||'').match(/^(\d+)(>?)$/);if(!hm) continue;
    const weeks=[];for(let i=0;i<H.weeks;i++){const t=tok[i+1];weeks.push(t&&/^\d+$/.test(t)?+t:0)}
    if(/^ИТОГО/i.test(label)){g.status=label.replace(/^ИТОГО:?\s*/i,'').trim();g.plan=+hm[1];g.totals=weeks;continue}
    const tail=raw.slice(end).replace(/[¦|│║]\s*$/,'');
    const tm=tail.match(TAIL)||[];
    const osob=(tm[3]||'').replace(/\s+/g,' ');
    const pre=label.match(/^([12])-\s?/);
    const sub=/^1/.test(osob)?'1 п/г':/^2/.test(osob)?'2 п/г':osob==='Поток'?'Поток':osob==='(П/П)'?'П/П':(pre?pre[1]+' п/г':'');
    g.rows.push({disc:label,hours:+hm[1],over:!!hm[2],weeks,kak:(tm[1]||'').replace(/\s+/g,' '),
      t:tparse(tm[2]),sub,stream:osob==='Поток',room:(tm[4]||'').trim()});
  }
  return groups.filter(x=>x.rows.length);
}

/* ---------- Разбор расписания (.json, раздел timetable) ---------- */
function ddmm(s){const m=String(s||'').match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/);return m?{d:+m[1],m:+m[2],y:+m[3]}:null}
const fmtD=o=>o?String(o.d).padStart(2,'0')+'.'+String(o.m).padStart(2,'0'):'';
function inferTimes(recs,maxP){
  const cnt={};recs.forEach(r=>{if(!r.start) return;const k=r.start+'|'+r.end;(cnt[r.period]||(cnt[r.period]={}))[k]=(cnt[r.period][k]||0)+1});
  const out={};for(let p=1;p<=maxP;p++){const o=Object.entries(cnt[p]||{}).sort((a,b)=>b[1]-a[1]);out[p]=o.length?o[0][0].split('|'):(DEFAULT_TIMES[p]||['',''])}
  return out;
}
/* ---------- База расписания по неделям ----------
   Файл расписания содержит одну или несколько целых недель. Загрузка заменяет в базе
   только эти недели, остальные остаются. Неделя хранится компактно: справочник строк
   и занятия массивами индексов. Ключ недели — дата её понедельника (ГГГГ-ММ-ДД),
   если дат нет — номер недели («n12»). */
const isoOf=o=>o.y+'-'+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0');
const dmyOf=o=>String(o.d).padStart(2,'0')+'-'+String(o.m).padStart(2,'0')+'-'+o.y;
function shiftD(o,n){const d=new Date(o.y,o.m-1,o.d+n);return {d:d.getDate(),m:d.getMonth()+1,y:d.getFullYear()}}
const mondayOf=o=>shiftD(o,-((new Date(o.y,o.m-1,o.d).getDay()+6)%7));
function packWeek(s){
  const S=[],ix=new Map();
  const I=v=>{v=String(v==null?'':v).trim();let i=ix.get(v);if(i==null){i=S.length;S.push(v);ix.set(v,i)}return i};
  const L=[],courses={};let minD=null;
  (s.groups||[]).forEach(g=>{
    const gn=String(g.group_name||'').trim();if(!gn) return;const c=+g.course||0;if(c) courses[gn]=c;
    (g.days||[]).forEach(d=>(d.lessons||[]).forEach(l=>{
      const p=+l.time;if(!(p>=1&&p<=8)) return;
      const dt=ddmm(String(l.date||'').trim());if(dt&&(!minD||isoOf(dt)<isoOf(minD))) minD=dt;
      L.push([I(gn),+d.weekday,p,I(l.time_start),I(l.time_end),I(l.date),I(String(l.subject||'').trim()||'Без названия'),+l.subgroup||0,
        (l.teachers||[]).map(t=>String(t&&t.teacher_name||'').trim()).filter(Boolean).map(I),
        (l.auditories||[]).map(a=>String(a&&a.auditory_name||'').trim()).filter(Boolean).map(I)]);
    }));
  });
  const week=+s.week_number||null;
  let st0=ddmm(s.date_start),en=ddmm(s.date_end);
  if(!st0&&minD) st0=mondayOf(minD);
  if(st0&&!en) en=shiftD(mondayOf(st0),5);
  const k=st0?isoOf(mondayOf(st0)):(week?'n'+week:'');
  return {k,week,start:st0?dmyOf(st0):'',end:en?dmyOf(en):'',courses,s:S,l:L};
}
/* одна неделя из базы → занятия для отображения */
const XCACHE=new WeakMap();
function expandWeek(c){
  if(XCACHE.has(c)) return XCACHE.get(c);
  const S=c.s;
  const recs=c.l.map(x=>({group:S[x[0]],day:x[1],period:x[2],start:S[x[3]],end:S[x[4]],date:S[x[5]],subject:S[x[6]],subgroup:x[7],
    teachers:x[8].map(i=>tparse(S[i])).filter(Boolean),rooms:x[9].map(i=>S[i])}));
  const maxP=Math.max(6,...recs.map(r=>r.period));
  const st0=ddmm(c.start);const dates={};
  for(let d=1;d<=6;d++){const r=recs.find(x=>x.day===d&&x.date);
    if(r) dates[d]=fmtD(ddmm(r.date));
    else if(st0){const dt=new Date(st0.y,st0.m-1,st0.d+d-1);dates[d]=fmtD({d:dt.getDate(),m:dt.getMonth()+1})}}
  const w={key:c.k,week:c.week,start:c.start,end:c.end,recs,courses:c.courses||{},maxP,times:inferTimes(recs,maxP),dates};
  XCACHE.set(c,w);return w;
}
/* разбор файла расписания (.json, раздел timetable) → недели в компактном виде */
function parseSched(root){
  const roots=Array.isArray(root)?root:[root];const list=[];
  roots.forEach(it=>{if(!it) return;if(Array.isArray(it.timetable)) list.push(...it.timetable);else if(it.groups) list.push(it)});
  if(!list.length) throw new Error('В файле нет раздела timetable с расписанием.');
  const by=new Map();
  for(const s of list){const c=packWeek(s);if(!c.k) throw new Error('В файле есть неделя без номера и без дат — её не к чему привязать.');by.set(c.k,c)}
  return [...by.values()];
}
const wkOrder=(a,b)=>(a.start&&b.start?coll.compare(isoOf(ddmm(a.start)),isoOf(ddmm(b.start))):0)||(a.week||0)-(b.week||0)||coll.compare(a.k||a.key,b.k||b.key);

/* ---------- Сравнение недель ----------
   Занятия сопоставляются по группе, дню, паре и подгруппе. Изменение — {g,d,p,sg,dt,b:[было],a:[стало]},
   элемент — {s: дисциплина, t: [преподаватели], r: [аудитории], tm: время}. */
function lessonsOf(c){
  const S=c.s;return c.l.map(x=>({g:S[x[0]],d:x[1],p:x[2],sg:x[7],dt:S[x[5]],it:{s:S[x[6]],t:x[8].map(i=>S[i]),r:x[9].map(i=>S[i]),tm:S[x[3]]&&S[x[4]]?S[x[3]]+'–'+S[x[4]]:''}}));
}
const sigOf=it=>[it.s,it.t.join(','),it.r.join(','),it.tm].join('|');
function diffWeek(oldC,newC){
  const M=new Map();
  const put=(ls,side)=>ls.forEach(x=>{const k=[x.g,x.d,x.p,x.sg].join('|');let e=M.get(k);if(!e){e={g:x.g,d:x.d,p:x.p,sg:x.sg,dt:x.dt,b:[],a:[]};M.set(k,e)}e[side].push(x.it);if(side==='a'&&x.dt) e.dt=x.dt});
  put(lessonsOf(oldC),'b');put(lessonsOf(newC),'a');
  const out=[];
  for(const e of M.values()){
    const bs=e.b.map(sigOf).sort(),as=e.a.map(sigOf).sort();
    if(bs.join('\n')===as.join('\n')) continue;
    // одинаковые занятия по обе стороны не показываем
    const keep=(xs,other)=>{const o=other.map(sigOf);return xs.filter(it=>{const i=o.indexOf(sigOf(it));if(i<0) return true;o.splice(i,1);return false})};
    const b=keep(e.b,e.a),a=keep(e.a,e.b);
    out.push({...e,b,a});
  }
  return out.sort((x,y)=>coll.compare(x.g,y.g)||x.d-y.d||x.p-y.p||x.sg-y.sg);
}
const wkMeta=c=>({k:c.k,week:c.week,start:c.start,end:c.end});
/* применить загрузку к базе: put — недели из файла, del — ключи удаляемых недель */
function computeUpload(base,op){
  const store=new Map(base);
  const entry={id:'local-'+Date.now(),at:new Date().toISOString(),author:'',file:op.file||'',weeks:[],ch:{}};
  for(const k of op.del||[]){const o=store.get(k);if(!o) continue;store.delete(k);entry.weeks.push({...wkMeta(o),st:'del',n:o.l.length})}
  for(const c of op.put||[]){
    const o=store.get(c.k);
    if(!o) entry.weeks.push({...wkMeta(c),st:'new',n:c.l.length});
    else{const ch=diffWeek(o,c);
      entry.weeks.push({...wkMeta(c),st:ch.length?'upd':'same',n:c.l.length,
        add:ch.filter(x=>!x.b.length).length,del:ch.filter(x=>!x.a.length).length,chg:ch.filter(x=>x.a.length&&x.b.length).length});
      if(ch.length) entry.ch[c.k]=ch}
    store.set(c.k,c);
  }
  entry.weeks.sort(wkOrder);
  return {store,entry};
}

/* ---------- Состояние ---------- */
let PLAN=null, SCHED=null;
const st={view:'plan',mode:'group',key:{group:null,teacher:null,room:null},q:'',wi:0,onlyMis:false,chOnly:false};
try{const s=JSON.parse(localStorage.getItem('plan-sched-view')||'null');if(s){if(s.view) st.view=s.view;if(s.mode) st.mode=s.mode;Object.assign(st.key,s.key||{})}}catch(e){}
function save(){try{localStorage.setItem('plan-sched-view',JSON.stringify({view:st.view,mode:st.mode,key:st.key}))}catch(e){}}
const W=()=>SCHED?SCHED.weeks[st.wi]:null;

/* ---------- База расписания: сборка, загрузка, сохранение ---------- */
const HIST_MAX=60;
function schedFrom(store,history,extra){
  SCHED=Object.assign({name:'',store,history:(history||[]).slice(0,HIST_MAX),pending:[]},extra);
  rebuildSched();
}
function rebuildSched(focusKey){
  if(!SCHED) return;
  const prev=focusKey||(SCHED.weeks&&SCHED.weeks[st.wi]&&SCHED.weeks[st.wi].key);
  SCHED.weeks=[...SCHED.store.values()].sort(wkOrder).map(expandWeek);
  const i=prev?SCHED.weeks.findIndex(w=>w.key===prev):-1;
  st.wi=i>=0?i:Math.max(0,Math.min(st.wi,SCHED.weeks.length-1));
  CHMEMO.clear();FVER++;
}
const SKEY_SCHED='edulog-sched';
function persistSched(){
  if(CLOUD) return;
  try{
    if(!SCHED||SCHED.sample){localStorage.removeItem(SKEY_SCHED);return}
    localStorage.setItem(SKEY_SCHED,JSON.stringify({edulog:'sched',v:1,name:SCHED.name,weeks:[...SCHED.store.values()],history:SCHED.history}));
  }catch(e){toast('Не удалось сохранить базу расписания в браузере: не хватает места.',true)}
}
/* загрузить файл с неделями (или удалить недели) — меняется только то, что в нём есть */
function uploadSched(file,put,del){
  const fresh=!SCHED||SCHED.sample;
  const r=computeUpload(fresh?new Map():SCHED.store,{file,put,del});
  r.entry.local=CLOUD;r.entry.author=CLOUD?'вы':'';
  if(fresh) schedFrom(r.store,[],{name:file||''});
  else{SCHED.store=r.store;if(file) SCHED.name=file}
  SCHED.history.unshift(r.entry);SCHED.history.length=Math.min(SCHED.history.length,HIST_MAX);
  if(CLOUD){SCHED.local=true;SCHED.pending.push({file:file||'',put:put||[],del:del||[]})}
  const first=(put||[]).slice().sort(wkOrder)[0];
  rebuildSched(first&&first.k);persistSched();
  return r.entry;
}
function uploadSummary(e){
  const by={new:[],upd:[],same:[],del:[]};e.weeks.forEach(w=>by[w.st].push(w.week||fmtRange(w)));
  const p=[];
  if(by.new.length) p.push((by.new.length>1?'новые недели ':'новая неделя ')+by.new.join(', '));
  if(by.upd.length) p.push((by.upd.length>1?'обновлены недели ':'обновлена неделя ')+by.upd.join(', '));
  if(by.same.length) p.push((by.same.length>1?'без изменений недели ':'без изменений неделя ')+by.same.join(', '));
  if(by.del.length) p.push((by.del.length>1?'удалены недели ':'удалена неделя ')+by.del.join(', '));
  return p.join('; ');
}
const fmtRange=w=>w.start||w.end?`${(w.start||'').slice(0,5).replace(/-/g,'.')}–${(w.end||'').slice(0,5).replace(/-/g,'.')}`:'';

/* ---------- Изменения, касающиеся группы, преподавателя или аудитории ----------
   Для каждого изменения считается, что оно значит для выбранного: «добавлено» (занятие появилось),
   «отменено» (занятие пропало) или «изменено». */
const CHMEMO=new Map();
function itemHas(mode,key,it){
  if(mode==='teacher') return it.t.some(n=>{const t=tparse(n);return t&&t.key===key});
  if(mode==='room') return it.r.includes(key);
  return true;
}
function relChange(c,mode,key){
  if(mode==='group'&&c.g!==key) return null;
  const b=c.b.filter(it=>itemHas(mode,key,it)),a=c.a.filter(it=>itemHas(mode,key,it));
  if(!b.length&&!a.length) return null;
  return {kind:!b.length?'add':!a.length?'del':'chg',b,a};
}
/* все изменения для выбранного по журналу загрузок, новые сверху */
function entityChanges(mode,key,onlyWeek){
  const out=[];if(!SCHED||key==null) return out;
  SCHED.history.forEach((e,ei)=>{
    for(const w of e.weeks){
      if(w.st!=='upd'||(onlyWeek&&w.k!==onlyWeek)) continue;
      for(const c of e.ch[w.k]||[]){const r=relChange(c,mode,key);if(r) out.push({e,ei,w,c,...r})}
    }
  });
  return out;
}
/* последнее изменение недели: подсветка карточек в расписании */
function weekLastUpload(k){
  if(!SCHED) return null;
  for(const e of SCHED.history){const w=e.weeks.find(x=>x.k===k);if(w) return w.st==='upd'?{e,w,ch:e.ch[k]||[]}:null}
  return null;
}
/* кто затронут: множества групп, преподавателей и аудиторий */
function touched(list){
  const T={group:new Set(),teacher:new Set(),room:new Set()};
  for(const c of list){T.group.add(c.g);for(const it of [...c.b,...c.a]){it.t.forEach(n=>{const t=tparse(n);if(t) T.teacher.add(t.key)});it.r.forEach(r=>T.room.add(r))}}
  return T;
}
function touchedFor(view){
  const k=view+'|'+st.wi;if(CHMEMO.has(k)) return CHMEMO.get(k);
  let list=[];
  if(SCHED&&SCHED.history.length){
    if(view==='sched'){const w=W();const u=w&&weekLastUpload(w.key);if(u) list=u.ch}
    else{const e=SCHED.history[0];for(const w of e.weeks) if(w.st==='upd') list=list.concat(e.ch[w.k]||[])}
  }
  const T=touched(list);CHMEMO.set(k,T);return T;
}


/* ---------- Справочник сущностей (общий для двух источников) ---------- */
const REG={teachers:new Map(),groups:[],rooms:[],courses:{}};
function noteT(t){if(!t) return;let e=REG.teachers.get(t.key);if(!e){e={key:t.key,base:t.base,variant:t.variant};REG.teachers.set(t.key,e)}
  if(t.base.replace(/[^А-Яа-яЁёA-Za-z]/g,'').length>e.base.replace(/[^А-Яа-яЁёA-Za-z]/g,'').length) e.base=t.base}
const tName=k=>{const e=REG.teachers.get(k);return e?e.base+e.variant:k};
function roomParts(v){
  let m=v.match(/^(\d+)\s*м\b\s*(.*)$/i);if(m) return {code:m[1]+'м',owner:m[2],b:1,n:+m[1]};
  m=v.match(/^(\d+)([а-яa-z]?)\s*(.*)$/i);if(m) return {code:m[1]+m[2],owner:m[3],b:0,n:+m[1]};
  if(v.startsWith('#')) return {code:'#',owner:v.slice(1).trim(),b:2,n:0};
  m=v.match(/^(\S+)\s*(.*)$/);return {code:m?m[1]:v,owner:m?m[2]:'',b:3,n:0};
}
function cmpRooms(a,b){const x=roomParts(a),y=roomParts(b);return x.b-y.b||x.n-y.n||coll.compare(x.code,y.code)||coll.compare(x.owner,y.owner)}
function buildRegistry(){
  REG.teachers=new Map();REG.courses={};const gs=new Set(),rs=new Set();
  if(PLAN) for(const g of PLAN.groups){gs.add(g.name);for(const r of g.rows){noteT(r.t);if(r.room) rs.add(r.room)}}
  if(SCHED) for(const w of SCHED.weeks){Object.assign(REG.courses,w.courses);for(const r of w.recs){gs.add(r.group);r.teachers.forEach(noteT);r.rooms.forEach(x=>rs.add(x))}}
  REG.groups=[...gs].sort(coll.compare);REG.rooms=[...rs].sort(cmpRooms);
}

/* ---------- Выборки по плану ---------- */
const planGroup=n=>PLAN&&PLAN.groups.find(x=>x.name===n);
const dist=r=>r.weeks.reduce((a,b)=>a+b,0)*2;
const tk=r=>r.t?r.t.key:'';
function collect(pred){
  const out=[],map=new Map();if(!PLAN) return out;
  for(const g of PLAN.groups) for(const r of g.rows){
    if(!pred(r)) continue;
    if(r.stream){const k=[r.disc,tk(r),r.room,r.weeks.join(',')].join('|');
      if(map.has(k)){map.get(k).groups.push(g.name);continue}
      const o={...r,groups:[g.name]};map.set(k,o);out.push(o);
    } else out.push({...r,groups:[g.name]});
  }
  return out;
}
function planRows(mode,key){
  if(mode==='group'){const g=planGroup(key);return g?g.rows.map(r=>({...r,groups:[g.name]})):[]}
  if(mode==='teacher') return collect(r=>tk(r)===key);
  return collect(r=>r.room===key);
}

/* ---------- Выборки по расписанию ---------- */
function schedRecs(mode,key,w){
  if(!w) return [];
  if(mode==='group') return w.recs.filter(r=>r.group===key);
  if(mode==='teacher') return w.recs.filter(r=>r.teachers.some(t=>t.key===key));
  return w.recs.filter(r=>r.rooms.includes(key));
}
/* одинаковое занятие у нескольких групп (поток) — одна карточка */
function cards(recs,mode){
  const Z=ZS();
  if(mode==='group') return recs.map(r=>({...r,groups:[r.group],zach:Z.has(r)}));
  const m=new Map(),out=[];
  for(const r of recs){const k=[r.day,r.period,r.subject,r.rooms.join(','),r.teachers.map(t=>t.key).join(',')].join('|');
    if(m.has(k)){const c=m.get(k);if(!c.groups.includes(r.group)) c.groups.push(r.group);if(Z.has(r)) c.zach=true;continue}
    const c={...r,groups:[r.group],zach:Z.has(r)};m.set(k,c);out.push(c)}
  return out;
}
const slotKey=r=>r.day+'|'+r.period;
const slots=recs=>new Set(recs.map(slotKey)).size;
function gaps(recs){let n=0;for(let d=1;d<=6;d++){const ps=[...new Set(recs.filter(r=>r.day===d).map(r=>r.period))].sort((a,b)=>a-b);
  if(ps.length>1) n+=ps[ps.length-1]-ps[0]+1-ps.length}return n}
/* накладки: преподаватель в двух местах, аудитория (с номером) занята разными занятиями, у группы общее занятие совпало с другим */
function markConflicts(cs,mode,key){
  const by=new Map();cs.forEach(c=>{const k=slotKey(c);(by.get(k)||by.set(k,[]).get(k)).push(c)});
  let n=0;
  for(const list of by.values()){
    if(list.length<2) continue;
    let bad=false;
    if(mode==='teacher') bad=key!=='вакант';
    else if(mode==='room') bad=/^\d/.test(key);
    else bad=list.some(c=>c.subgroup===0);
    if(bad){n++;list.forEach(c=>c.conf=true)}
  }
  return n;
}

/* ---------- Сверка плана и расписания на неделю ---------- */
function reconKey(s,bkey){
  s=String(s||'').trim();const pre=(s.match(/^([12])-/)||[])[1]||'';
  const code=s.replace(/^[12]-\s?/,'').split(/\s/)[0];
  const kind=/консульт/i.test(s)?'К':/экзам|\.ЭК\b|квалиф/i.test(s)?'Э':'';
  return [code,kind,pre,bkey||''].join('|');
}
function recon(mode,key,w){
  if(!PLAN||!w||!w.week) return null;
  const i=w.week-1;const B=new Map();
  const get=(k,init)=>B.get(k)||B.set(k,{...init,plan:0,fact:0}).get(k);
  const gnames=mode==='group'?[key]:[...new Set([
    ...PLAN.groups.filter(g=>g.rows.some(r=>tk(r)===key)).map(g=>g.name),
    ...w.recs.filter(r=>r.teachers.some(t=>t.key===key)).map(r=>r.group)])];
  for(const gn of gnames){
    const pg=planGroup(gn);
    if(pg) for(const r of pg.rows){
      if(mode!=='group'&&tk(r)!==key) continue;
      const v=r.weeks[i]||0;
      const b=get(gn+'#'+reconKey(r.disc,r.t&&r.t.bkey),{group:gn,name:r.disc,tkey:tk(r),inPlan:true});
      b.plan+=v;b.inPlan=true;
    }
    for(const x of w.recs){
      if(x.group!==gn) continue;
      const t=mode==='group'?x.teachers[0]:x.teachers.find(t=>t.key===key);
      if(mode!=='group'&&!t) continue;
      const b=get(gn+'#'+reconKey(x.subject,t&&t.bkey),{group:gn,name:x.subject,tkey:t?t.key:''});
      b.fact++;if(!b.full) b.full=x.subject;if(!b.tkey&&t) b.tkey=t.key;
    }
  }
  const rows=[...B.values()].filter(b=>b.plan||b.fact).map(b=>({...b,name:b.full||b.name,mis:b.plan!==b.fact}));
  rows.sort((a,b)=>(b.mis-a.mis)||coll.compare(a.group,b.group)||coll.compare(a.name,b.name));
  return rows;
}
function planPairs(mode,key,w){
  if(!PLAN||!w||!w.week) return null;const i=w.week-1;
  if(mode==='group'){const g=planGroup(key);if(!g) return null;return g.totals?g.totals[i]||0:g.rows.reduce((a,r)=>a+(r.weeks[i]||0),0)}
  if(mode==='teacher'){const rs=collect(r=>tk(r)===key);return rs.length?rs.reduce((a,r)=>a+(r.weeks[i]||0),0):null}
  return null;
}

/* ---------- Зачётные дисциплины ----------
   Отметка ставится на дисциплину группы (код без «1-»/«2-»). Последняя пара берётся так:
   неделя — последняя по плану неделя с парами; день и пара — последнее занятие этой недели в расписании.
   Если у дисциплины есть подгруппы, зачёт ставится на последнее занятие, после которого у этих студентов пар по дисциплине нет. */
const codeOf=s=>String(s||'').trim().replace(/^[12]-\s?/,'').split(/\s/)[0];
const preOf=s=>(String(s||'').trim().match(/^([12])-/)||[])[1]||'';
const kindOf=s=>/консульт/i.test(s)?'К':/экзам|\.ЭК\b|квалиф/i.test(s)?'Э':'';
let FLAGS=new Map(),FVER=0;
const isZ=(g,code)=>!!(FLAGS.get(g)&&FLAGS.get(g).has(code));
function loadLocalFlags(){try{const o=JSON.parse(localStorage.getItem('plan-zachety')||'{}');FLAGS=new Map(Object.entries(o).filter(([,a])=>Array.isArray(a)).map(([g,a])=>[g,new Set(a)]))}catch(e){}FVER++}
function saveLocalFlags(){try{localStorage.setItem('plan-zachety',JSON.stringify(Object.fromEntries([...FLAGS].map(([g,s])=>[g,[...s]]))))}catch(e){}}
function applyFlag(groups,code,on){
  for(const g of groups){let s=FLAGS.get(g);if(!s){s=new Set();FLAGS.set(g,s)}on?s.add(code):s.delete(code);if(!s.size) FLAGS.delete(g)}
  FVER++;
}
function setFlag(groups,code,on){
  if(CLOUD&&!CAN_FLAG){render();return}
  applyFlag(groups,code,on);render();
  if(!CLOUD){saveLocalFlags();return}
  Promise.resolve(window.EduLOGCloud&&window.EduLOGCloud.saveFlag(groups,code,on)).catch(e=>{
    applyFlag(groups,code,!on);render();toast(e&&e.message||'Не удалось сохранить отметку.',true);
  });
}
function fmtFull(d){return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+d.getFullYear()}
/* даты недели плана n: из расписания этой недели либо отсчётом от загруженной */
function weekRange(n){
  if(!SCHED) return null;const w=SCHED.weeks.find(x=>x.week===n);
  if(w&&w.start) return {start:w.start.replace(/-/g,'.'),end:w.end.replace(/-/g,'.'),exact:true};
  const a=SCHED.weeks.find(x=>x.week&&ddmm(x.start));if(!a) return null;const s=ddmm(a.start);
  const d0=new Date(s.y,s.m-1,s.d+(n-a.week)*7),d1=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate()+5);
  return {start:fmtFull(d0),end:fmtFull(d1),exact:false,anchor:a};
}
function fullSubject(g,code,pre){if(SCHED) for(const w of SCHED.weeks){const r=w.recs.find(x=>x.group===g&&codeOf(x.subject)===code&&preOf(x.subject)===pre&&!kindOf(x.subject));if(r) return r.subject}return ''}
function creditItems(g){
  const pg=planGroup(g),codes=FLAGS.get(g);if(!pg||!codes) return [];
  const out=[];
  for(const code of codes){
    const B=new Map();
    for(const r of pg.rows){if(codeOf(r.disc)!==code||kindOf(r.disc)) continue;const p=preOf(r.disc);
      const b=B.get(p)||B.set(p,{pre:p,rows:[],last:0}).get(p);b.rows.push(r);r.weeks.forEach((v,i)=>{if(v&&i+1>b.last) b.last=i+1})}
    const bs=[...B.values()].filter(b=>b.last);
    for(const b of bs){
      const w=SCHED&&SCHED.weeks.find(x=>x.week===b.last);b.rec=null;b.w=w||null;
      if(w){const rs=w.recs.filter(x=>x.group===g&&codeOf(x.subject)===code&&!kindOf(x.subject)&&preOf(x.subject)===b.pre).sort((a,c)=>a.day-c.day||a.period-c.period);b.rec=rs[rs.length-1]||null}
      b.pos=[b.last,b.rec?b.rec.day:0,b.rec?b.rec.period:0];
    }
    const later=(a,c)=>a.pos[0]-c.pos[0]||a.pos[1]-c.pos[1]||a.pos[2]-c.pos[2];
    for(const b of bs){
      const rivals=bs.filter(o=>o!==b&&(b.pre===''?o.pre!=='':o.pre===''));
      if(rivals.some(o=>later(o,b)>0)) continue;
      out.push({group:g,code,pre:b.pre,week:b.last,rec:b.rec,w:b.w,
        teachers:b.rec?b.rec.teachers.map(t=>t.key):[...new Set(b.rows.map(tk).filter(Boolean))],
        rooms:b.rec?b.rec.rooms:[...new Set(b.rows.map(r=>r.room).filter(Boolean))],
        name:(b.rec&&b.rec.subject)||fullSubject(g,code,b.pre)||b.rows[0].disc});
    }
  }
  const rd=x=>x.rec?x.rec.day*10+x.rec.period:0;
  return out.sort((a,c)=>a.week-c.week||rd(a)-rd(c)||coll.compare(a.name,c.name));
}
function bucketLast(g,code,pre){const pg=planGroup(g);let l=0;if(pg) for(const r of pg.rows) if(codeOf(r.disc)===code&&preOf(r.disc)===pre&&!kindOf(r.disc)) r.weeks.forEach((v,i)=>{if(v&&i+1>l) l=i+1});return l}
let ZMEMO={k:'',set:new Set()};
function ZS(){
  const w=W();const k=FVER+'|'+(w?st.wi:'-');
  if(ZMEMO.k===k) return ZMEMO.set;
  const set=new Set();
  if(w&&PLAN) for(const g of FLAGS.keys()) for(const it of creditItems(g)) if(it.rec&&it.w===w) set.add(it.rec);
  ZMEMO={k,set};return set;
}

/* ---------- Указатель ---------- */
function items(mode){
  if(st.view==='changes'){
    const C=changeCounts()[mode];const lab=k=>mode==='teacher'?tName(k):k;
    const keys=mode==='group'?REG.groups:mode==='teacher'?[...REG.teachers.keys()]:REG.rooms;
    const list=keys.map(k=>{const n=C.get(k)||0;return {key:k,label:lab(k),present:n>0,n:n?n+' '+plural(n,'изм.','изм.','изм.'):'—'}});
    if(mode==='group') list.forEach(i=>{const c=REG.courses[i.key];i.sec=c?c+' курс':'Шифр …'+i.key.slice(-2);i.secO=c?c:100+(99-(+i.key.slice(-2)||0))});
    return mode==='room'?list:list.sort((a,b)=>coll.compare(a.label,b.label));
  }
  const plan=st.view==='plan', w=W();
  if(mode==='group') return REG.groups.map(n=>groupItem(n,plan,w)).sort((a,b)=>a.secO-b.secO||coll.compare(a.label,b.label));
  if(mode==='teacher') return [...REG.teachers.values()].map(e=>{const k=e.key;
    if(plan){const rs=planRows('teacher',k);return {key:k,label:tName(k),present:rs.length>0,n:rs.length?rs.reduce((a,r)=>a+r.hours,0)+' ч':'—'}}
    const rs=schedRecs('teacher',k,w);const s=slots(rs);const p=planPairs('teacher',k,w);
    return {key:k,label:tName(k),present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар'),dot:!PLAN?'':(p==null&&!s?'none':((p||0)===s?'ok':'warn'))};
  }).sort((a,b)=>coll.compare(a.label,b.label));
  const list=REG.rooms.map(k=>{
    if(plan){const rs=planRows('room',k);return {key:k,label:k,present:rs.length>0,n:rs.length?rs.reduce((a,r)=>a+r.hours,0)+' ч':'—'}}
    const rs=schedRecs('room',k,w);const s=slots(rs);return {key:k,label:k,present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар')};
  });
  if(!plan&&SCHED) list.unshift({key:'*',label:'Все аудитории',all:true,present:true,n:''});
  return list;
}
function groupItem(n,plan,w){
    const c=REG.courses[n];const sec=c?c+' курс':'Шифр …'+n.slice(-2);const secO=c?c:100+(99-(+n.slice(-2)||0));
    if(plan){const g=planGroup(n);return {key:n,label:n,sec,secO,present:!!g,n:g?(g.plan??g.rows.reduce((a,r)=>a+r.hours,0))+' ч':'—',
      dot:g?(/недогруз/i.test(g.status)?'warn':'ok'):'none'}}
    const rs=schedRecs('group',n,w);const s=slots(rs);const p=planPairs('group',n,w);
    return {key:n,label:n,sec,secO,present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар'),dot:p==null?'none':(p===s?'ok':'warn')};
}
function resolveKey(list){
  const k=st.key[st.mode];
  if(list.some(i=>i.key===k&&(i.present||i.all))) return k;
  if(k!=null&&list.some(i=>i.key===k)) return k;      // выбранный есть в справочнике, но не в этом источнике — покажем пусто
  const f=list.find(i=>i.present&&!i.all)||list[0];st.key[st.mode]=f?f.key:null;return st.key[st.mode];
}
let LIST=[];
function renderList(){
  const el=$('#list');
  if(!PLAN&&!SCHED){el.innerHTML='<p class="empty-list">Откройте файл плана или расписания.</p>';return}
  const q=st.q.trim().toLowerCase();
  const its=LIST.filter(i=>!q||i.label.toLowerCase().includes(q));
  if(!its.length){el.innerHTML='<p class="empty-list">Ничего не найдено.</p>';return}
  const cur=st.key[st.mode];
  const T=st.view==='changes'?null:touchedFor(st.view)[st.mode];
  const btn=i=>`<button class="item${i.present?'':' absent'}${i.all?' all':''}" data-key="${esc(i.key)}" aria-current="${i.key===cur}">`+
    (i.dot?`<span class="dot ${i.dot}"></span>`:'')+`<span class="nm">${esc(i.label)}</span>`+
    (T&&T.has(i.key)?`<span class="chm" title="${st.view==='sched'?'Есть изменения на этой неделе':'Есть изменения в последней загрузке расписания'}">изм.</span>`:'')+`<span class="n">${i.n}</span></button>`;
  if(st.mode==='group'){
    const secs=[...new Map(its.map(i=>[i.sec,i.secO])).entries()].sort((a,b)=>a[1]-b[1]).map(x=>x[0]);
    el.innerHTML=secs.map(s=>`<div class="sec">${esc(s)}</div>`+its.filter(i=>i.sec===s).sort((a,b)=>coll.compare(a.label,b.label)).map(btn).join('')).join('');
  } else el.innerHTML=its.map(btn).join('');
}
function renderTabs(){
  document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.mode===st.mode)));
  document.querySelectorAll('.seg [data-view]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.view===st.view)));
}
const MODE_NAME={group:'группы',teacher:'преподавателя',room:'аудитории'};
const label=(mode,key)=>mode==='teacher'?tName(key):key;
function titleRow(key){
  const ps=LIST.filter(i=>i.present&&!i.all);const idx=ps.findIndex(i=>i.key===key);
  const dis=ps.length<2?' disabled':'';
  return `<div class="title-row"><button class="arrow" data-step="-1" aria-label="Предыдущий в списке"${dis}>←</button><h1>${esc(label(st.mode,key))}</h1><button class="arrow" data-step="1" aria-label="Следующий в списке"${dis}>→</button></div>`;
}
function emptyCard(h,p,withBtn){return `<div class="panel msg"><h2>${h}</h2><p>${p}</p>${withBtn?'<label class="btn" for="file">Открыть файлы…</label>':''}</div>`}

/* ---------- Вид «Недельный план» ---------- */
function heat(v,max){return max?Math.round(Math.min(v/max,1)*48):0}
function renderPlan(key){
  const main=$('#main');
  if(!PLAN) return main.innerHTML=emptyCard('План не загружен','Откройте текстовую выгрузку плана (plany.txt): блоки «Группа: … Студентов: …» и строки дисциплин с часами по неделям.',true);
  const mode=st.mode;
  if(key==null) return main.innerHTML=emptyCard('Список пуст','В плане нет записей для этого раздела.');
  const rows=planRows(mode,key);
  if(!rows.length) return main.innerHTML=`<section class="head"><div class="head-l"><span class="eyebrow">План ${MODE_NAME[mode]}</span>${titleRow(key)}</div></section>`+emptyCard('Нет в плане',`${esc(label(mode,key))} есть только в расписании.`);
  const G=mode==='group'?planGroup(key):null;const fileTot=G&&G.totals;
  let last=0;rows.forEach(r=>r.weeks.forEach((v,i)=>{if(v&&i+1>last) last=i+1}));
  if(fileTot) fileTot.forEach((v,i)=>{if(v&&i+1>last) last=i+1});
  const w=W();const cw=w&&w.week?w.week:0;
  last=Math.max(last,1,cw);
  const totals=Array.from({length:last},(_,i)=>fileTot?(fileTot[i]||0):rows.reduce((a,r)=>a+(r.weeks[i]||0),0));
  const plan=G&&G.plan!=null?G.plan:rows.reduce((a,r)=>a+r.hours,0);
  const dsum=fileTot?totals.reduce((a,b)=>a+b,0)*2:rows.reduce((a,r)=>a+dist(r),0);
  const peak=Math.max(...totals),peakW=totals.indexOf(peak)+1,active=totals.filter(Boolean).length;
  const cellMax=Math.max(1,...rows.flatMap(r=>r.weeks));
  let stats=`<div class="stat"><dt>По плану</dt><dd>${plan} <small>ч</small></dd></div>`+
    `<div class="stat${dsum<plan?' warn':''}"><dt>Расставлено по неделям</dt><dd>${dsum} <small>ч</small></dd></div>`+
    `<div class="stat"><dt>Недель с занятиями</dt><dd>${active}</dd></div>`+
    `<div class="stat"><dt>Пиковая неделя</dt><dd>${peak} <small>пар · нед. ${peakW}</small></dd></div>`;
  let extra='';
  if(G){stats=`<div class="stat"><dt>Студентов</dt><dd>${G.students}</dd></div>`+stats;
    if(G.status) extra=`<span class="pill${/недогруз/i.test(G.status)?' warn':''}">${esc(G.status)}</span>`;
    const zn=FLAGS.get(key)?FLAGS.get(key).size:0;if(zn) extra+=` <span class="pill z">${zn} ${plural(zn,'зачёт','зачёта','зачётов')}</span>`}
  else{const gs=new Set(rows.flatMap(r=>r.groups)),ds=new Set(rows.map(r=>r.disc.replace(/^[12]-\s?/,'')));
    stats=`<div class="stat"><dt>Групп</dt><dd>${gs.size}</dd></div><div class="stat"><dt>Дисциплин</dt><dd>${ds.size}</dd></div>`+stats}
  const barMax=Math.max(1,peak);
  const bars=totals.map((v,i)=>`<div class="bar${i+1===cw?' cur':''}" title="Неделя ${i+1}: ${v} ${plural(v,'пара','пары','пар')}"><span class="v">${v||''}</span><i class="${v?'':'zero'}" style="height:${v?Math.max(2,v/barMax*82):1}%"></i><span class="k">${i+1}</span></div>`).join('');
  const showWho=mode!=='teacher',showRoom=mode!=='room';
  const curc=i=>i+1===cw?' cur':'';
  const chW=new Map();entityChanges(mode,key).forEach(r=>{if(r.w.week) chW.set(r.w.week,(chW.get(r.w.week)||0)+1)});
  const weekHead=totals.map((_,i)=>{const n=chW.get(i+1);return `<th class="w${curc(i)}${n?' chg':''}" scope="col"${n?` title="Неделя ${i+1}: ${n} ${plural(n,'изменение','изменения','изменений')} в расписании"`:''}>${i+1}</th>`}).join('');
  const body=rows.map(r=>{
    const svc=/экзамен|консультац|\.ЭК\b|Квалификац/i.test(r.disc);const tags=[];
    const zc=codeOf(r.disc),zok=!kindOf(r.disc),zon=zok&&r.groups.every(g=>isZ(g,zc));
    let zl=-1;if(zon){r.weeks.forEach((v,i)=>{if(v) zl=i});if(zl+1<bucketLast(r.groups[0],zc,preOf(r.disc))) zl=-1}
    const cb=zok?`<input type="checkbox" class="zcb" data-zg="${esc(r.groups.join('\n'))}" data-zc="${esc(zc)}" title="${CAN_FLAG?'Зачётная дисциплина':'Зачётная дисциплина (менять может редактор)'}" aria-label="Зачёт: ${esc(r.disc)}"${zon?' checked':''}${CAN_FLAG?'':' disabled'}>`:'<span class="zcb-sp"></span>';
    if(r.sub) tags.push(`<span class="tag${r.sub==='Поток'?' acc':''}">${esc(r.sub)}</span>`);
    if(r.kak) tags.push(`<span class="tag" title="Практика блоками">${esc(r.kak)}</span>`);
    const grp=mode!=='group'?`<div class="d-grp">${r.groups.map(n=>`<button class="link" data-go="group" data-key="${esc(n)}">${esc(n)}</button>`).join(', ')}</div>`:'';
    const who=showWho?`<td class="c-who">${r.t?`<button class="link" data-go="teacher" data-key="${esc(r.t.key)}">${esc(tName(r.t.key))}</button>`:'—'}</td>`:'';
    const room=showRoom?`<td class="c-room">${r.room?`<button class="link" data-go="room" data-key="${esc(r.room)}">${esc(r.room)}</button>`:'—'}</td>`:'';
    const d=dist(r);
    const ws=totals.map((_,i)=>{const v=r.weeks[i]||0;return v?`<td class="w${curc(i)}${i===zl?' zl':''}" style="--h:${heat(v,cellMax)}"${i===zl?' title="Последняя пара — зачёт"':''}>${v}</td>`:`<td class="w z${curc(i)}">·</td>`}).join('');
    return `<tr class="${svc?'svc':''}"><th class="c-disc" scope="row"><div class="dd">${cb}<div>${grp}<span class="d-name">${esc(r.disc)}</span>${tags.length?`<span class="tags">${tags.join('')}</span>`:''}</div></div></th>${who}${room}<td class="c-num">${r.hours}${d!==r.hours?`<span class="sub">расст. ${d}</span>`:''}</td>${ws}<td class="c-num">${d}</td></tr>`;
  }).join('');
  const footW=totals.map((v,i)=>`<td class="w${curc(i)}" style="--h:${heat(v,barMax)}">${v||'·'}</td>`).join('');
  const span=(showWho?1:0)+(showRoom?1:0);
  const streams=rows.filter(r=>r.stream&&r.groups.length>1).length;
  main.innerHTML=`
  <section class="head"><div class="head-l"><span class="eyebrow">План ${MODE_NAME[mode]}</span>${titleRow(key)}${extra?`<div>${extra}</div>`:''}</div></section>
  <dl class="stats">${stats}</dl>
  <section class="panel" aria-label="Нагрузка по неделям">
    <h2>Пар в неделю${cw?`<span class="pill mute">выделена неделя ${cw} из расписания</span>`:''}</h2>
    <div class="bars-wrap"><div class="bars">${bars}</div></div>
    ${fileTot?`<p class="note">Нагрузка группы взята из строки «ИТОГО» файла: параллельные подгруппы и потоки учтены один раз, поэтому сумма часов в таблице может быть больше.</p>`:''}
    ${streams&&!fileTot?`<p class="note">Потоковые занятия, общие для нескольких групп, посчитаны один раз (${streams} ${plural(streams,'строка','строки','строк')}).</p>`:''}
  </section>
  <div class="legend"><span>Флажок слева — зачётная дисциплина: её последняя пара обведена здесь и помечена «зачёт» в расписании</span><span>Ячейка недели — число пар (1 пара = 2 ч)</span><span>«расст.» — по неделям расставлено меньше часов, чем по плану</span>${chW.size?'<span>Номер недели с точкой — в расписании этой недели были изменения (список внизу)</span>':''}</div>
  <div class="grid-wrap"><table>
    <thead><tr><th class="c-disc" scope="col">${mode==='group'?'Дисциплина':'Группа и дисциплина'}</th>${showWho?'<th scope="col">Преподаватель</th>':''}${showRoom?'<th scope="col">Ауд.</th>':''}<th class="c-num" scope="col">Часы</th>${weekHead}<th class="c-num" scope="col">Расст.</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="c-disc">${fileTot?'Итого по файлу':'Итого'}</td>${span?`<td colspan="${span}"></td>`:''}<td class="c-num">${plan}</td>${footW}<td class="c-num">${dsum}</td></tr></tfoot>
  </table></div>${entityChangesPanel(mode,key)}`;
}

/* ---------- Вид «Расписание» ---------- */
const linkT=t=>`<button class="link" data-go="teacher" data-key="${esc(t.key)}">${esc(tName(t.key))}</button>`;
const linkR=r=>`<button class="link" data-go="room" data-key="${esc(r)}">${esc(r)}</button>`;
const linkG=g=>`<button class="link" data-go="group" data-key="${esc(g)}">${esc(g)}</button>`;
function lessonCard(c,mode,w,compact){
  const tm=w.times[c.period]||['',''];
  const odd=c.start&&(c.start!==tm[0]||c.end!==tm[1])?`<span class="tag warn" title="Время отличается от обычного для этой пары">${esc(c.start)}–${esc(c.end)}</span>`:'';
  const sg=c.subgroup?`<span class="tag">${c.subgroup<=2?c.subgroup+' п/г':'п/г '+c.subgroup}</span>`:'';
  const T=c.teachers.length?c.teachers.map(linkT).join(', '):'—', R=c.rooms.length?c.rooms.map(linkR).join(', '):'—';
  const cls='ls'+(c.subgroup?' sub':'')+(c.conf?' conf':'')+(c.zach?' zach':'')+(c.chg?' ch-'+c.chg:'')+(compact?' compact':'');
  const was=c.was&&c.was.length?' Было: '+c.was.map(it=>[it.s,it.t.join(', '),it.r.join(', '),it.tm].filter(Boolean).join(' · ')).join('; '):'';
  const zt=(c.zach?'<span class="ztag" title="Последняя пара зачётной дисциплины">Зачёт</span>':'')+
    (c.chg?`<span class="ctag ${c.chg}" title="${esc((c.chg==='add'?'Добавлено':'Изменено')+' при последней загрузке этой недели.'+was)}">${c.chg==='add'?'Новое':'Изменено'}</span>`:'');
  const conf=c.conf?`<span class="tag warn">накладка</span>`:'';
  if(mode==='group') return `<div class="${cls}">${zt}<div class="ls-s" title="${esc(c.subject)}">${esc(c.subject)}</div><div class="ls-m">${T}<span>${R}</span>${sg}${odd}${conf}</div></div>`;
  const grp=`<div class="ls-g">${c.groups.map(linkG).join('')}</div>`;
  const other=mode==='teacher'?R:T;
  return `<div class="${cls}">${zt}${grp}<div class="ls-s" title="${esc(c.subject)}">${esc(c.subject)}</div><div class="ls-m"><span>${other}</span>${sg}${odd}${conf}</div></div>`;
}
function weekTable(cs,mode,w,compact,ghosts){
  const head=DAYS.map((d,i)=>`<th scope="col"><span>${d}</span><small>${esc(w.dates[i+1]||'')}</small></th>`).join('');
  let rows='';
  for(let p=1;p<=w.maxP;p++){
    const tm=w.times[p]||['',''];
    rows+='<tr>'+DAYS.map((_,i)=>{const its=cs.filter(c=>c.day===i+1&&c.period===p);
      const gs=(ghosts||[]).filter(g=>g.day===i+1&&g.period===p);
      return `<td><div class="slot-h"><span>${p} пара</span><time>${esc(tm[0])}–${esc(tm[1])}</time></div>${its.length?its.map(c=>lessonCard(c,mode,w,compact)).join(''):(gs.length?'':'<div class="nil">—</div>')}${gs.map(g=>ghostCard(g,mode)).join('')}</td>`}).join('')+'</tr>';
  }
  return `<div class="wk-wrap"><table class="wk"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function weekNav(w){
  const n=SCHED.weeks.length;const range=w.start||w.end?`${esc(w.start.replace(/-/g,'.'))}–${esc(w.end.replace(/-/g,'.'))}`:'даты не указаны';
  return `<div class="weeknav" aria-label="Неделя расписания"><button class="arrow" data-wk="-1" aria-label="Предыдущая неделя"${st.wi<=0?' disabled':''}>←</button>
    <div><b>${w.week?'Неделя '+w.week:'Неделя'}</b><small>${range}${n>1?` · ${st.wi+1} из ${n}`:''}</small></div>
    <button class="arrow" data-wk="1" aria-label="Следующая неделя"${st.wi>=n-1?' disabled':''}>→</button></div>`;
}
function reconPanel(mode,key,w){
  const rows=recon(mode,key,w);if(!rows) return '';
  const pg=mode==='group'?planGroup(key):null;
  if(mode==='group'&&!pg) return `<section class="panel"><h2>Сверка с планом · неделя ${w.week}</h2><p class="note">Группы ${esc(key)} нет в загруженном плане.</p></section>`;
  if(!rows.length) return '';
  const mis=rows.filter(r=>r.mis).length;
  const shown=st.onlyMis?rows.filter(r=>r.mis):rows;
  const body=shown.map(r=>{const d=r.fact-r.plan;
    const who=mode==='group'?`<td class="c-who">${r.tkey?`<button class="link" data-go="teacher" data-key="${esc(r.tkey)}">${esc(tName(r.tkey))}</button>`:'—'}</td>`:`<td>${linkG(r.group)}</td>`;
    return `<tr class="${r.mis?'mis':''}"><td>${esc(r.name)}</td>${who}<td class="c-num">${r.plan}</td><td class="c-num">${r.fact}</td><td class="c-num${d?' bad':''}">${d>0?'+'+d:d||'0'}</td></tr>`}).join('');
  return `<section class="panel" aria-label="Сверка с планом">
    <h2>Сверка с планом · неделя ${w.week}${mis?`<span class="pill warn">${mis} ${plural(mis,'расхождение','расхождения','расхождений')}</span>`:'<span class="pill">всё совпадает</span>'}
      ${mis&&mis<rows.length?`<label class="rc-tools"><input type="checkbox" id="onlyMis"${st.onlyMis?' checked':''}> только расхождения</label>`:''}</h2>
    <div class="rc-wrap"><table class="rc"><thead><tr><th>Дисциплина</th><th>${mode==='group'?'Преподаватель':'Группа'}</th><th class="c-num">План, пар</th><th class="c-num">В расписании</th><th class="c-num">Разница</th></tr></thead><tbody>${body||'<tr><td colspan="5">Расхождений нет.</td></tr>'}</tbody></table></div>
    <p class="note">Строки плана и занятия расписания сопоставлены по коду дисциплины, подгруппе («1-»/«2-») и преподавателю. Строки с одинаковым кодом (лекции и практика) объединяются.</p>
  </section>`;
}
function renderSched(key){
  const main=$('#main');
  if(!SCHED||!SCHED.weeks.length) return main.innerHTML=emptyCard(SCHED?'В базе нет недель':'Расписание не загружено','Откройте JSON-файл расписания (раздел timetable): одна или несколько целых недель. Загрузка заменяет только эти недели, остальные остаются. План при этом останется загруженным, и расписание можно будет сверить с ним.',true);
  const w=W();const mode=st.mode;
  if(mode==='room'&&key==='*') return renderRoomsGrid(w);
  if(key==null) return main.innerHTML=`<div class="head">${weekNav(w)}</div>`+emptyCard('Список пуст','В расписании нет записей для этого раздела.');
  const recs=schedRecs(mode,key,w);const cs=cards(recs,mode);const conf=markConflicts(cs,mode,key);
  const ghosts=markChanges(cs,mode,key,w);const chn=cs.filter(c=>c.chg).length+ghosts.length;
  const s=slots(recs),g=gaps(recs);const pp=planPairs(mode,key,w);
  const days=new Set(recs.map(r=>r.day)).size;
  let stats=`<div class="stat"><dt>Пар за неделю</dt><dd>${s}</dd></div>`;
  if(pp!=null) stats+=`<div class="stat${pp!==s?' warn':''}"><dt>По плану на нед. ${w.week}</dt><dd>${pp}${pp!==s?` <small>${s-pp>0?'+':''}${s-pp}</small>`:''}</dd></div>`;
  if(mode!=='group'){const gs=new Set(recs.map(r=>r.group));stats+=`<div class="stat"><dt>Групп</dt><dd>${gs.size}</dd></div>`}
  stats+=`<div class="stat"><dt>Учебных дней</dt><dd>${days}</dd></div>`;
  if(mode!=='room') stats+=`<div class="stat${g?' warn':''}"><dt>Окна</dt><dd>${g}</dd></div>`;
  if(conf) stats+=`<div class="stat bad"><dt>Накладки</dt><dd>${conf}</dd></div>`;
  const zn=cs.filter(c=>c.zach).length;if(zn) stats+=`<div class="stat bad"><dt>Зачётов на неделе</dt><dd>${zn}</dd></div>`;
  if(chn) stats+=`<div class="stat acc"><dt>Изменено при загрузке</dt><dd>${chn}</dd></div>`;
  const course=mode==='group'&&REG.courses[key]?`<span class="pill mute">${REG.courses[key]} курс</span>`:'';
  const head=`<section class="head"><div class="head-l"><span class="eyebrow">Расписание ${MODE_NAME[mode]}</span>${titleRow(key)}${course?`<div>${course}</div>`:''}</div>${weekNav(w)}</section>`;
  const chp=entityChangesPanel(mode,key,{week:w.key,quiet:true});
  if(!recs.length){main.innerHTML=head+emptyCard('Нет занятий',`На этой неделе в расписании нет занятий: ${esc(label(mode,key))}.`)+chp+reconPanel(mode,key,w);return}
  main.innerHTML=head+`<dl class="stats">${stats}</dl>
    <div class="legend"><span>Клик по преподавателю, аудитории или группе открывает её расписание</span><span>Правый клик — быстрый просмотр недели</span><span>Серые карточки — подгруппы</span>${chn?'<span>«Новое», «Изменено», «Отменено» — по последней загрузке этой недели</span>':''}</div>
    ${weekTable(cs,mode,w,false,ghosts)}${chp}${mode!=='room'?reconPanel(mode,key,w):''}`;
}
function renderRoomsGrid(w){
  const rooms=[...new Set(w.recs.flatMap(r=>r.rooms))].sort(cmpRooms);
  const cs=cards(w.recs,'room');
  const cell=new Map();cs.forEach(c=>c.rooms.forEach(r=>{const k=r+'|'+c.day+'|'+c.period;(cell.get(k)||cell.set(k,[]).get(k)).push(c)}));
  let conf=0;
  const headR=rooms.map(r=>{const p=roomParts(r);return `<th scope="col"><button class="link" data-go="room" data-key="${esc(r)}"><b>${esc(p.code)}</b></button>${p.owner?`<small>${esc(p.owner)}</small>`:''}</th>`}).join('');
  let body='';
  for(let d=1;d<=6;d++) for(let p=1;p<=w.maxP;p++){
    const tm=w.times[p]||['',''];
    const tds=rooms.map(r=>{const its=cell.get(r+'|'+d+'|'+p)||[];if(!its.length) return '<td></td>';
      const bad=its.length>1&&/^\d/.test(r);if(bad) conf++;
      if(its.length>3) return `<td class="busy"><div class="occ" title="${esc(its.map(c=>c.groups.join(', ')+' — '+c.subject).join('\n'))}"><span>${its.flatMap(c=>c.groups).map(linkG).join(', ')}</span><small>${its.length} ${plural(its.length,'занятие','занятия','занятий')}</small></div></td>`;
      return `<td class="${bad?'conf':'busy'}">${its.map(c=>`<div class="occ" title="${esc(c.subject)}"><span>${c.groups.map(linkG).join(', ')}</span><small>${esc(c.teachers.map(t=>tName(t.key)).join(', ')||'—')}</small></div>`).join('')}</td>`}).join('');
    body+=`<tr class="${p===1&&d>1?'ds':''}">${p===1?`<th class="rg-d" rowspan="${w.maxP}" scope="rowgroup"><span>${DAYS[d-1]} ${esc(w.dates[d]||'')}</span></th>`:''}<th class="rg-p" scope="row"><b>${p}</b> ${esc(tm[0])}</th>${tds}</tr>`;
  }
  $('#main').innerHTML=`<section class="head"><div class="head-l"><span class="eyebrow">Сетка занятости</span><h1>Все аудитории</h1></div>${weekNav(w)}</section>
    <dl class="stats"><div class="stat"><dt>Аудиторий</dt><dd>${rooms.length}</dd></div><div class="stat"><dt>Занятий</dt><dd>${cs.length}</dd></div>${conf?`<div class="stat bad"><dt>Накладки</dt><dd>${conf}</dd></div>`:''}</dl>
    <div class="legend"><span>Наведите на группу, чтобы увидеть дисциплину</span><span>Клик по номеру — расписание аудитории</span></div>
    <div class="rg-wrap"><table class="rg"><thead><tr><th class="rg-d" scope="col">День</th><th class="rg-p" scope="col">Пара</th>${headR}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Отображение изменений ---------- */
const DSHORT=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const KIND={add:['Добавлено','add'],del:['Отменено','del'],chg:['Изменено','chg']};
const sgText=sg=>sg?(sg<=2?sg+' п/г':'п/г '+sg):'';
function itemHtml(it,ref){
  // ref — другая сторона изменения: подчёркиваем то, что отличается
  const diff=(v,o)=>ref&&ref.length&&!ref.some(x=>o(x)===v)?' class="df"':'';
  const T=it.t.join(', '),R=it.r.join(', ');
  return `<span${diff(it.s,x=>x.s)}>${esc(it.s)}</span>`+
    `<small>${T?`<span${diff(T,x=>x.t.join(', '))}>${esc(T)}</span>`:'<span>без преподавателя</span>'}${R?` · <span${diff(R,x=>x.r.join(', '))}>${esc(R)}</span>`:''}${it.tm&&ref&&ref.length&&!ref.some(x=>x.tm===it.tm)?` · <span class="df">${esc(it.tm)}</span>`:''}</small>`;
}
function whatHtml(r){
  if(r.kind==='add') return r.a.map(it=>`<div class="ci">${itemHtml(it)}</div>`).join('');
  if(r.kind==='del') return r.b.map(it=>`<div class="ci was">${itemHtml(it)}</div>`).join('');
  return r.b.map(it=>`<div class="ci was">${itemHtml(it,r.a)}</div>`).join('')+`<div class="arrow-d" aria-hidden="true">↓</div>`+r.a.map(it=>`<div class="ci">${itemHtml(it,r.b)}</div>`).join('');
}
const kindTag=k=>`<span class="ck ${KIND[k][1]}">${KIND[k][0]}</span>`;
const whenTxt=c=>`${DSHORT[c.d-1]||c.d}${c.dt?' '+esc(c.dt.slice(0,5).replace(/-/g,'.')):''}, ${c.p} пара${c.sg?' · '+sgText(c.sg):''}`;
function uploadStamp(e){
  const d=new Date(e.at);const t=isNaN(d)?'':fmtStamp(e.at);
  return `${esc(t)}${e.author?' · '+esc(e.author):''}${e.local?' <span class="pill warn" title="Изменение видно только вам, пока не нажата «Опубликовать»">не опубликовано</span>':''}`;
}
/* таблица изменений для группы, преподавателя или аудитории */
function changesTable(rows,mode,opt){
  opt=opt||{};
  const showWeek=!opt.week, showGroup=opt.showGroup!=null?opt.showGroup:mode!=='group';
  return `<div class="rc-wrap"><table class="rc chg-t"><thead><tr>${showWeek?'<th>Неделя</th>':''}<th>Когда</th>${showGroup?'<th>Группа</th>':''}<th>Что</th><th>Загрузка</th></tr></thead><tbody>`+
    rows.map(r=>`<tr class="k-${r.kind}">${showWeek?`<td class="c-num"><button class="link" data-gowk="${esc(r.w.k)}">${r.w.week?'нед. '+r.w.week:esc(fmtRange(r.w))}</button></td>`:''}`+
      `<td class="when">${whenTxt(r.c)}</td>${showGroup?`<td>${linkG(r.c.g)}</td>`:''}<td class="what">${kindTag(r.kind)}${whatHtml(r)}</td><td class="up">${esc(r.e.file||'—')}<small>${uploadStamp(r.e)}</small></td></tr>`).join('')+
    '</tbody></table></div>';
}
function entityChangesPanel(mode,key,opt){
  opt=opt||{};
  if(!SCHED||!SCHED.history.length||key==null||key==='*') return '';
  const all=entityChanges(mode,key,opt.week);
  const lim=opt.limit||12;
  const title=opt.week?`Изменения этой недели`:'Изменения в расписании';
  if(!all.length) return opt.quiet?'':`<section class="panel chg-p"><h2>${title}<span class="pill">нет</span></h2><p class="note">${opt.week?'При загрузках расписания эта неделя для выбранного не менялась.':'В загруженных файлах расписания для выбранного ничего не менялось.'}</p></section>`;
  const n={add:0,del:0,chg:0};all.forEach(r=>n[r.kind]++);
  const pills=['add','chg','del'].filter(k=>n[k]).map(k=>`<span class="ck ${KIND[k][1]}">${KIND[k][0]}: ${n[k]}</span>`).join('');
  const more=all.length>lim?`<details class="more"><summary>Показать все (${all.length})</summary>${changesTable(all.slice(lim),mode,opt)}</details>`:'';
  return `<section class="panel chg-p" aria-label="${title}"><h2>${title}<span class="cks">${pills}</span><button class="link sm" data-view-go="changes">весь журнал →</button></h2>
    ${changesTable(all.slice(0,lim),mode,opt)}${more}
    <p class="note">${opt.week?'Сравнение с тем, что было в базе до последней загрузки этой недели.':'По журналу загрузок расписания, новые сверху. Каждая загрузка заменяет только недели из своего файла.'}</p></section>`;
}
/* подсветка в сетке недели: что добавлено/изменено, и «призраки» отменённых занятий */
function markChanges(cs,mode,key,w){
  const u=weekLastUpload(w.key);if(!u) return [];
  const ghosts=[];
  for(const c of u.ch){
    const r=relChange(c,mode,key);if(!r) continue;
    if(r.kind==='del'){r.b.forEach(it=>ghosts.push({day:c.d,period:c.p,subgroup:c.sg,group:c.g,it}));continue}
    for(const it of r.a){
      const card=cs.find(x=>x.day===c.d&&x.period===c.p&&x.subgroup===c.sg&&x.groups.includes(c.g)&&x.subject===it.s);
      if(card&&!card.chg){card.chg=r.kind;card.was=r.b}
    }
  }
  return ghosts;
}
function ghostCard(g,mode){
  const it=g.it;const who=mode==='group'?it.t.join(', '):mode==='teacher'?[g.group,it.r.join(', ')].filter(Boolean).join(' · '):[g.group,it.t.join(', ')].filter(Boolean).join(' · ');
  return `<div class="ls gone" title="Отменено при последней загрузке этой недели"><span class="ctag del">Отменено</span><div class="ls-s">${esc(it.s)}</div><div class="ls-m"><span>${esc(who||'—')}</span>${g.subgroup?`<span class="tag">${sgText(g.subgroup)}</span>`:''}</div></div>`;
}

/* ---------- Вид «Изменения» ---------- */
let CNT={v:-1,m:null};
function changeCounts(){
  if(CNT.v===FVER) return CNT.m;
  const m={group:new Map(),teacher:new Map(),room:new Map()};
  if(SCHED) for(const e of SCHED.history) for(const w of e.weeks){if(w.st!=='upd') continue;
    for(const c of e.ch[w.k]||[]){const T=touched([c]);for(const md of ['group','teacher','room']) for(const k of T[md]) m[md].set(k,(m[md].get(k)||0)+1)}}
  CNT={v:FVER,m};return m;
}
const ST_TXT={new:'новая неделя',upd:'обновлена',same:'без изменений',del:'удалена'};
function weekChip(w){
  const extra=w.st==='upd'?` · ${[w.add?'+'+w.add:'',w.chg?'~'+w.chg:'',w.del?'−'+w.del:''].filter(Boolean).join(' ')}`:w.st!=='del'?` · ${w.n} ${plural(w.n,'занятие','занятия','занятий')}`:'';
  return `<span class="wchip s-${w.st}"><b>${w.week?'Неделя '+w.week:'Неделя'}</b> ${esc(fmtRange(w))} · ${ST_TXT[w.st]}${extra}</span>`;
}
function renderChanges(key){
  const main=$('#main');
  if(!SCHED) return main.innerHTML=emptyCard('Расписание не загружено','Откройте файл расписания (.json): одна или несколько целых недель. Каждый следующий файл обновит только свои недели, а здесь будет видно, что изменилось.',CAN_FLAG);
  const mode=st.mode;const only=st.chOnly&&key!=null&&key!=='*';
  const filt=only?`<label class="rc-tools"><input type="checkbox" id="chOnly" checked> только ${esc(label(mode,key))}</label>`:(key!=null&&key!=='*'?`<label class="rc-tools"><input type="checkbox" id="chOnly"> только ${esc(label(mode,key))}</label>`:'');
  let body='';
  if(!SCHED.history.length) body=`<div class="panel msg"><h2>Изменений пока нет</h2><p>Журнал начнётся со следующей загрузки файла расписания. Файл заменяет только свои недели, остальные остаются как были.</p></div>`;
  SCHED.history.forEach((e,i)=>{
    let inner='';
    for(const w of e.weeks){
      if(w.st!=='upd') continue;
      let list=(e.ch[w.k]||[]).map(c=>({e,w,c,kind:!c.b.length?'add':!c.a.length?'del':'chg',b:c.b,a:c.a}));
      if(only) list=entityChanges(mode,key,w.k).filter(r=>r.e===e);
      if(!list.length) continue;
      const shown=list.slice(0,300);
      inner+=`<h3>${w.week?'Неделя '+w.week:'Неделя'} <small>${esc(fmtRange(w))}</small> <button class="link sm" data-gowk="${esc(w.k)}">открыть расписание</button></h3>`+
        changesTable(shown,mode,{week:w.k,showGroup:!only||mode!=='group'})+(list.length>shown.length?`<p class="note">Показаны первые ${shown.length} из ${list.length}.</p>`:'');
    }
    if(only&&!inner) return;
    const head=`<span class="up-t"><b>${esc(e.file||(e.weeks.every(w=>w.st==='del')?'Удаление недель':'Загрузка'))}</b><small>${uploadStamp(e)}</small></span><span class="wchips">${e.weeks.map(weekChip).join('')}</span>`;
    body+=`<details class="panel upl"${i<3?' open':''}><summary>${head}</summary>${inner||'<p class="note">Изменений внутри уже загруженных недель нет.</p>'}</details>`;
  });
  if(only&&!body) body=`<div class="panel msg"><h2>Нет изменений</h2><p>Для ${esc(label(mode,key))} в журнале загрузок изменений нет.</p></div>`;
  // недели в базе
  const canEd=CAN_FLAG;
  const weeks=SCHED.weeks.map((w,i)=>`<tr><td class="c-num">${w.week||'—'}</td><td>${esc(fmtRange(w))}</td><td class="c-num">${w.recs.length}</td><td class="c-num">${new Set(w.recs.map(r=>r.group)).size}</td>`+
    `<td><button class="link sm" data-gowk="${esc(w.key)}">открыть</button>${canEd?` <button class="link sm danger" data-delwk="${esc(w.key)}">удалить</button>`:''}</td></tr>`).join('');
  main.innerHTML=`<section class="head"><div class="head-l"><span class="eyebrow">Журнал загрузок расписания</span><h1>Что изменилось</h1></div>${filt}</section>
    <div class="legend"><span>Файл расписания — одна или несколько целых недель: загрузка заменяет только их, остальные недели остаются</span><span>${kindTag('add')} ${kindTag('chg')} ${kindTag('del')} — по группе, дню, паре и подгруппе</span></div>
    ${body}
    <section class="panel"><h2>Недели в базе · ${SCHED.weeks.length}</h2><div class="rc-wrap"><table class="rc"><thead><tr><th class="c-num">Неделя</th><th>Даты</th><th class="c-num">Занятий</th><th class="c-num">Групп</th><th></th></tr></thead><tbody>${weeks}</tbody></table></div>
    ${canEd?'<p class="note">Неделю, загруженную по ошибке, можно удалить: остальные не изменятся.'+(CLOUD?' Удаление, как и новые файлы, увидят все после «Опубликовать».':'')+'</p>':''}</section>`;
}

/* ---------- Быстрый просмотр (правый клик) ---------- */
let PREV=null;
function openPreview(mode,key){
  const w=W();if(!w) return;
  const cs=cards(schedRecs(mode,key,w),mode);markConflicts(cs,mode,key);
  PREV={mode,key};
  $('#modalEyebrow').textContent=`Неделя ${w.week||''} · расписание ${MODE_NAME[mode]}`;
  $('#modalTitle').textContent=label(mode,key);
  $('#modalBody').innerHTML=cs.length?weekTable(cs,mode,w,true):'<p class="note">На этой неделе занятий нет.</p>';
  $('#modal').hidden=false;document.body.classList.add('modal-open');$('#modal .x').focus();
}
function closePreview(){$('#modal').hidden=true;document.body.classList.remove('modal-open');PREV=null}

/* ---------- Отрисовка ---------- */
function render(){
  renderTabs();
  document.body.classList.toggle('v-admin',st.view==='admin');
  if(st.view==='admin'){
    if(window.EduLOGCloud&&window.EduLOGCloud.isAdmin()){window.EduLOGCloud.renderAdmin($('#main'));save();return}
    st.view='plan';renderTabs();document.body.classList.remove('v-admin');
  }
  LIST=(PLAN||SCHED)?items(st.mode):[];
  const key=LIST.length?resolveKey(LIST):null;
  renderList();
  if(st.view==='plan') renderPlan(key); else if(st.view==='changes') renderChanges(key); else renderSched(key);
  renderSources();save();
}
function renderSources(){
  const sp=$('#srcPlan'),ss=$('#srcSched');
  const tag=o=>o.sample?' (пример)':o.local&&CLOUD?' <span class="pill warn" title="Файл открыт только у вас">не опубликован</span>':o.meta?` <span class="by" title="Опубликовал(а): ${esc(o.meta.author||'—')}">${esc(fmtStamp(o.meta.updated_at))}</span>`:'';
  if(PLAN){sp.className='src';sp.innerHTML=`<span class="k">План</span><b>${esc(PLAN.name)}</b>${tag(PLAN)} · ${PLAN.groups.length} ${plural(PLAN.groups.length,'группа','группы','групп')}`}
  else{sp.className='src none';sp.innerHTML='<span class="k">План</span><b>не загружен</b>'}
  if(SCHED){const n=SCHED.weeks.length;ss.className='src';ss.innerHTML=`<span class="k">Расписание</span><b>${n} ${plural(n,'неделя','недели','недель')}</b>${tag(SCHED)}${SCHED.name?` · <span title="Последний загруженный файл">${esc(SCHED.name)}</span>`:''}`}
  else{ss.className='src none';ss.innerHTML='<span class="k">Расписание</span><b>не загружено</b>'}
  if(window.EduLOGCloud) window.EduLOGCloud.onSources();
}
function fmtStamp(iso){const d=new Date(iso);if(isNaN(d)) return '';return fmtFull(d)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
let toastT;
function toast(m,err){const t=$('#toast');t.textContent=m;t.className='toast'+(err?' err':'');t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,4000)}

/* ---------- Загрузка файлов ---------- */
function decode(buf){
  const u8=new Uint8Array(buf);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(u8)}catch(e){}
  const score=s=>(s.match(/Группа|Дисциплина|ПРЕПОДАВАТЕЛИ|timetable/g)||[]).length;
  const a=new TextDecoder('windows-1251').decode(u8);let b='';try{b=new TextDecoder('ibm866').decode(u8)}catch(e){}
  return score(b)>score(a)?b:a;
}
function ingest(text,name,sample,extra){
  text=text.replace(/^﻿/,'');
  if(/^\s*[\[{]/.test(text)){
    let obj;try{obj=JSON.parse(text)}catch(e){throw new Error(`«${name}»: не удалось разобрать JSON.`)}
    // сохранённая база (локальный режим): недели и журнал как есть
    if(obj&&obj.edulog==='sched'){schedFrom(new Map((obj.weeks||[]).map(w=>[w.k,w])),obj.history,Object.assign({name:obj.name||''},extra));return 'sched'}
    const weeks=parseSched(obj);
    const nm=name.replace(/\.json$/i,'');
    // пример или опубликованный ранее одним файлом — это исходная база, а не загрузка
    if(sample||(extra&&extra.meta)){
      const store=new Map(weeks.map(w=>[w.k,w]));const legacy=!!(extra&&extra.meta);
      schedFrom(store,[],Object.assign({name:nm,sample,legacy,legacyStore:legacy?store:null,legacyName:nm},extra));return 'sched'}
    const e=uploadSched(nm,weeks,[]);
    if(extra&&extra.report) extra.report.push(e);
    return 'sched';
  }
  const groups=parsePlan(text);
  if(!groups.length) throw new Error(`«${name}»: не найдено ни одной группы плана.`);
  PLAN=Object.assign({name,file:name,groups,sample,raw:text},extra);FVER++;return 'plan';
}
async function openFiles(files){
  const done=[],report=[];let last=null;
  // файлы применяются по очереди: если одна неделя есть в двух файлах, останется из последнего
  for(const f of files){try{last=ingest(decode(await f.arrayBuffer()),f.name,false,{local:true,report});done.push(f.name)}catch(e){toast(e.message||'Не удалось открыть файл.',true)}}
  if(!done.length) return;
  buildRegistry();if(last) st.view=report.length?'changes':last;closePreview();render();
  if(report.length) toast('Расписание: '+report.map(uploadSummary).join('; ')+(CLOUD?'. Нажмите «Опубликовать», чтобы изменения увидели все.':''));
  else toast(done.length>1?`Открыты файлы: ${done.join(', ')}`:`Открыт файл «${done[0]}»`);
}
$('#file').addEventListener('change',e=>{openFiles([...e.target.files]);e.target.value=''});
let dragN=0;
addEventListener('dragenter',e=>{if([...(e.dataTransfer&&e.dataTransfer.types||[])].includes('Files')){dragN++;$('#drop').hidden=false}});
addEventListener('dragleave',()=>{if(--dragN<=0){dragN=0;$('#drop').hidden=true}});
addEventListener('dragover',e=>e.preventDefault());
addEventListener('drop',e=>{e.preventDefault();dragN=0;$('#drop').hidden=true;openFiles([...e.dataTransfer.files])});

/* ---------- Навигация ---------- */
function go(mode,key){st.mode=mode;st.key[mode]=key;st.q='';$('#q').value='';closePreview();render();scrollTo({top:0})}
document.querySelector('.seg').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b) return;st.view=b.dataset.view;render()});
document.querySelector('.tabs').addEventListener('click',e=>{const b=e.target.closest('.tab');if(!b) return;st.mode=b.dataset.mode;st.q='';$('#q').value='';render()});
$('#list').addEventListener('click',e=>{const b=e.target.closest('.item');if(!b) return;st.key[st.mode]=b.dataset.key;render();if(innerWidth<=820) $('#main').scrollIntoView({behavior:'smooth'})});
$('#q').addEventListener('input',e=>{st.q=e.target.value;renderList()});
document.addEventListener('click',e=>{
  const g=e.target.closest('[data-go]');if(g){go(g.dataset.go,g.dataset.key);return}
  const s=e.target.closest('[data-step]');
  if(s){const ps=LIST.filter(i=>i.present&&!i.all);if(ps.length<2) return;const i=ps.findIndex(x=>x.key===st.key[st.mode]);
    st.key[st.mode]=ps[((i<0?0:i)+(+s.dataset.step)+ps.length)%ps.length].key;render();return}
  const wk=e.target.closest('[data-wk]');if(wk&&SCHED){st.wi=Math.max(0,Math.min(SCHED.weeks.length-1,st.wi+(+wk.dataset.wk)));render();return}
  const gw=e.target.closest('[data-gowk]');if(gw&&SCHED){const i=SCHED.weeks.findIndex(x=>x.key===gw.dataset.gowk);if(i<0){toast('Этой недели уже нет в базе.',true);return}
    st.wi=i;st.view='sched';if(st.key[st.mode]==='*'&&st.mode!=='room') st.key[st.mode]=null;closePreview();render();scrollTo({top:0});return}
  const vg=e.target.closest('[data-view-go]');if(vg){st.view=vg.dataset.viewGo;render();scrollTo({top:0});return}
  const dw=e.target.closest('[data-delwk]');if(dw&&SCHED&&CAN_FLAG){
    if(dw.dataset.sure!=='1'){dw.dataset.sure='1';dw.textContent='точно удалить?';setTimeout(()=>{if(dw.isConnected){dw.dataset.sure='';dw.textContent='удалить'}},4000);return}
    const en=uploadSched('',[],[dw.dataset.delwk]);buildRegistry();render();toast('Расписание: '+uploadSummary(en)+(CLOUD?'. Нажмите «Опубликовать», чтобы удаление увидели все.':''));return}
  if(e.target.closest('[data-close]')) closePreview();
});
document.addEventListener('change',e=>{
  if(e.target.id==='onlyMis'){st.onlyMis=e.target.checked;render();return}
  if(e.target.id==='chOnly'){st.chOnly=e.target.checked;render();return}
  const z=e.target.closest('[data-zc]');if(z) setFlag(z.dataset.zg.split('\n'),z.dataset.zc,z.checked);
});
document.addEventListener('contextmenu',e=>{
  if(st.view!=='sched'||!SCHED) return;
  const g=e.target.closest('[data-go]');if(!g) return;
  e.preventDefault();openPreview(g.dataset.go,g.dataset.key);
});
$('#modalOpen').addEventListener('click',()=>{if(PREV) go(PREV.mode,PREV.key)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#modal').hidden) closePreview()});


/* ---------- PDF (pdfmake со шрифтом Roboto: кириллица, текст выделяется) ---------- */
const PM_URL='https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/pdfmake.min.js';
const VFS_URL='https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/vfs_fonts.js';
const PC={ink:'#14212a',muted:'#5a6a76',rule:'#c4ced5',fill:'#e6f0f3',sub:'#f3f6f7',z:'#a83232',zf:'#fbe9e9'};
const DSH=['Пн','Вт','Ср','Чт','Пт','Сб'];
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=()=>rej(new Error('Не удалось загрузить модуль PDF — нужен интернет.'));document.head.appendChild(s)})}
async function pdfLib(){
  if(!(window.pdfMake&&window.pdfMake.createPdf)) await loadScript(PM_URL);
  if(!(window.pdfMake.vfs&&window.pdfMake.vfs['Roboto-Regular.ttf'])) await loadScript(VFS_URL);
  return window.pdfMake;
}
const trunc=(s,n)=>s.length>n?s.slice(0,n-1).trim()+'…':s;
const LAY={hLineWidth:()=>.5,vLineWidth:()=>.5,hLineColor:()=>PC.rule,vLineColor:()=>PC.rule,paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>2,paddingBottom:()=>2};
const STY={h:{fontSize:14,bold:true,color:PC.ink},s:{fontSize:8.5,color:PC.muted,margin:[0,2,0,8]},th:{bold:true,fontSize:8,color:PC.ink},note:{fontSize:7,color:PC.muted,margin:[0,8,0,0]}};
const entTitle=(mode,key)=>mode==='group'?'Расписание группы '+key:mode==='teacher'?'Расписание преподавателя '+tName(key):'Расписание аудитории '+key;
function pdfLesson(c,mode,n){
  const L=n>2?34:n>1?62:110;const subj=trunc(c.subject,L);const fs=n>1?6.8:7.5;
  const sg=c.subgroup?(c.subgroup<=2?c.subgroup+' п/г':'п/г '+c.subgroup):'';
  const T=c.teachers.map(t=>tName(t.key)).join(', '),R=c.rooms.join(', ');
  const meta=(a)=>a.filter(Boolean).join(' · ');
  const st=[];
  if(c.zach) st.push({text:'ЗАЧЁТ',bold:true,color:PC.z,fontSize:6.5,characterSpacing:.6});
  if(mode==='group'){st.push({text:subj,bold:true,fontSize:fs});st.push({text:meta([T,R,sg]),color:PC.muted,fontSize:6.3})}
  else{st.push({text:c.groups.join(', '),bold:true,fontSize:fs});st.push({text:subj,fontSize:6.3});st.push({text:meta([mode==='teacher'?R:T,sg]),color:PC.muted,fontSize:6.3})}
  return {stack:st,margin:[0,0,0,2]};
}
/* ячейка группы: занятия с одной дисциплиной (подгруппы, ИОТ) — название один раз, ниже строки подгрупп */
function pdfGroupCell(its){
  const by=new Map();its.forEach(c=>{(by.get(c.subject)||by.set(c.subject,[]).get(c.subject)).push(c)});
  if(by.size===its.length) return its.map(c=>pdfLesson(c,'group',its.length));
  const out=[];const n=by.size;
  for(const [subj,cs] of by){
    const st=[];if(cs.some(c=>c.zach)) st.push({text:'ЗАЧЁТ',bold:true,color:PC.z,fontSize:6.5,characterSpacing:.6});
    st.push({text:trunc(subj,n>1?50:90),bold:true,fontSize:6.8});
    cs.sort((a,b)=>a.subgroup-b.subgroup).forEach(c=>{const sg=c.subgroup?(c.subgroup<=2?c.subgroup+' п/г':'п/г '+c.subgroup):'вся группа';
      st.push({text:[{text:sg+': ',bold:true},[c.teachers.map(t=>tName(t.key)).join(', '),c.rooms.join(', ')].filter(Boolean).join(' · ')],color:PC.muted,fontSize:6.2})});
    out.push({stack:st,margin:[0,0,0,2]});
  }
  return out;
}
function pdfWeekPage(mode,key,w,brk){
  const recs=schedRecs(mode,key,w),cs=cards(recs,mode);
  const head=[{text:'Пара',style:'th'}].concat(DAYS.map((d,i)=>({text:[d+'\n',{text:w.dates[i+1]||'',bold:false,color:PC.muted,fontSize:7}],style:'th'})));
  const body=[head];
  for(let p=1;p<=w.maxP;p++){
    const tm=w.times[p]||['',''];
    const row=[{stack:[{text:String(p),bold:true,fontSize:11},{text:tm[0]+'\n'+tm[1],fontSize:6.5,color:PC.muted}]}];
    for(let d=1;d<=6;d++){
      const its=cs.filter(c=>c.day===d&&c.period===p);
      row.push(its.length?{stack:mode==='group'?pdfGroupCell(its):its.map(c=>pdfLesson(c,mode,its.length)),fillColor:its.some(c=>c.zach)?PC.zf:(its.every(c=>c.subgroup)?PC.sub:PC.fill)}:{text:''});
    }
    body.push(row);
  }
  const range=w.start||w.end?`${w.start.replace(/-/g,'.')}–${w.end.replace(/-/g,'.')}`:'';
  const course=mode==='group'&&REG.courses[key]?REG.courses[key]+' курс':'';
  const zn=cs.filter(c=>c.zach).length;
  const sub=[w.week?'Неделя '+w.week:'',range,course,slots(recs)+' '+plural(slots(recs),'пара','пары','пар'),zn?zn+' '+plural(zn,'зачёт','зачёта','зачётов'):''].filter(Boolean).join(' · ');
  return [{text:entTitle(mode,key),style:'h',pageBreak:brk?'before':undefined},{text:sub,style:'s'},
    {table:{headerRows:1,dontBreakRows:true,widths:[30,'*','*','*','*','*','*'],heights:i=>i?(w.maxP>6?44:56):undefined,body},layout:LAY}];
}
function sortedGroups(list){return list.slice().sort((a,b)=>(REG.courses[a]||99)-(REG.courses[b]||99)||coll.compare(a,b))}
function pdfCreditPage(g,items,brk){
  const head=['№','Дисциплина','П/г','Преподаватель','Неделя','День и пара','Ауд.'].map(x=>({text:x,style:'th'}));
  let guessed=null;
  const body=[head].concat(items.map((it,i)=>{
    let when;
    if(it.rec){const tm=it.w.times[it.rec.period]||['',''];const s=it.rec.start||tm[0],e=it.rec.end||tm[1];
      when={text:[{text:DAYS[it.rec.day-1]+', '+(it.rec.date||'').replace(/-/g,'.')+'\n',bold:true},it.rec.period+' пара, '+s+'–'+e]}}
    else{const r=weekRange(it.week);if(r&&!r.exact) guessed=r.anchor;
      when={text:[r?r.start+'–'+r.end+'\n':'',{text:'расписания этой недели нет в файле',color:PC.muted,fontSize:7}]}}
    return [String(i+1),{text:it.name},it.pre?it.pre+' п/г':'вся группа',it.teachers.map(tName).join(', ')||'—',{text:String(it.week),alignment:'center'},when,it.rooms.join(', ')||'—'];
  }));
  const pg=planGroup(g);const course=REG.courses[g]?REG.courses[g]+' курс · ':'';
  const out=[{text:'Зачёты группы '+g,style:'h',pageBreak:brk?'before':undefined},
    {text:course+(pg?pg.students+' студентов · ':'')+items.length+' '+plural(items.length,'зачётная пара','зачётные пары','зачётных пар')+' за семестр',style:'s'},
    {table:{headerRows:1,dontBreakRows:true,widths:[14,'*',44,92,34,104,62],body},layout:LAY,fontSize:8.5}];
  let note='Неделя — последняя неделя с парами по недельному плану; день, пара и аудитория — по загруженному расписанию.';
  if(guessed) note+=` Даты недель без расписания рассчитаны от недели ${guessed.week} (${guessed.start.replace(/-/g,'.')}) по 7 дней.`;
  out.push({text:note,style:'note'});
  return out;
}
async function savePdf(doc,filename){
  const pm=await pdfLib();
  const blob=await new Promise((res,rej)=>{try{pm.createPdf(doc).getBlob(res)}catch(e){rej(e)}});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast('PDF сохранён: '+filename);
}
function baseDoc(landscape,content){
  return {pageSize:'A4',pageOrientation:landscape?'landscape':'portrait',pageMargins:[24,26,24,30],content,styles:STY,
    defaultStyle:{font:'Roboto',fontSize:7.5,color:PC.ink,lineHeight:1.1},
    footer:(cur,total)=>({columns:[{text:[PLAN?'План: '+PLAN.name:'',SCHED?(PLAN?' · ':'')+'Расписание: '+SCHED.name:''].join('')},{text:cur+' / '+total,alignment:'right'}],margin:[24,8,24,0],fontSize:6.5,color:PC.muted})};
}
async function makePdf(kind){
  const w=W();
  if(kind==='one'){
    const key=st.key[st.mode];
    if(!w) return toast('Сначала откройте файл расписания (.json).',true);
    if(key==null||key==='*') return toast('Выберите группу, преподавателя или аудиторию.',true);
    return savePdf(baseDoc(true,pdfWeekPage(st.mode,key,w,false)),`${entTitle(st.mode,key)}, неделя ${w.week||''}.pdf`.replace(/[\\/:*?"<>|]/g,'-'));
  }
  if(kind==='all'){
    if(!w) return toast('Сначала откройте файл расписания (.json).',true);
    const gs=sortedGroups([...new Set(w.recs.map(r=>r.group))]);
    return savePdf(baseDoc(true,gs.flatMap((g,i)=>pdfWeekPage('group',g,w,i>0))),`Расписание всех групп, неделя ${w.week||''}.pdf`);
  }
  if(!PLAN) return toast('Для зачётов нужен недельный план (.txt).',true);
  const gs=sortedGroups([...FLAGS.keys()].filter(g=>planGroup(g)));
  const pages=gs.map(g=>[g,creditItems(g)]).filter(x=>x[1].length);
  if(!pages.length) return toast('Нет отмеченных зачётных дисциплин: поставьте флажки в недельном плане.',true);
  return savePdf(baseDoc(false,pages.flatMap(([g,its],i)=>pdfCreditPage(g,its,i>0))),'Зачёты за семестр.pdf');
}
function updatePdfMenu(){
  const w=W(),key=st.key[st.mode];
  const one=$('#pdf-one'),all=$('#pdf-all'),z=$('#pdf-zach');
  $('#pdfOneLabel').textContent=key&&key!=='*'?entTitle(st.mode,key):'Открытое расписание';
  $('#pdfOneSub').textContent=w?'неделя '+(w.week||'')+', одна страница':'нужен файл расписания';
  $('#pdfAllSub').textContent=w?'неделя '+(w.week||'')+', каждая группа на отдельной странице':'нужен файл расписания';
  one.disabled=!w||key==null||key==='*';all.disabled=!w;z.disabled=!PLAN||!FLAGS.size;
}
$('#pdfBtn').addEventListener('click',e=>{e.stopPropagation();const m=$('#pdfMenu');updatePdfMenu();m.hidden=!m.hidden;$('#pdfBtn').setAttribute('aria-expanded',String(!m.hidden))});
document.addEventListener('click',e=>{if(!e.target.closest('.pmenu')){$('#pdfMenu').hidden=true;$('#pdfBtn').setAttribute('aria-expanded','false')}});
$('#pdfMenu').addEventListener('click',async e=>{
  const b=e.target.closest('[data-pdf]');if(!b||b.disabled) return;
  $('#pdfMenu').hidden=true;const btn=$('#pdfBtn');btn.disabled=true;btn.textContent='Готовлю PDF…';
  try{await makePdf(b.dataset.pdf)}catch(err){toast(err&&err.message||'Не удалось сформировать PDF.',true)}
  finally{btn.disabled=false;btn.textContent='PDF ▾'}
});

/* ---------- Встроенные примеры ---------- */
/* ---------- Связь с облачным режимом (cloud.js) ---------- */
window.EduLOG={
  CLOUD,CFG,esc,toast,fmtStamp,
  get plan(){return PLAN},get sched(){return SCHED},
  get view(){return st.view},
  setView(v){st.view=v;render()},
  // Загрузить опубликованный файл; meta — {updated_at, author}
  load(kind,text,name,meta){const k=ingest(text,name,false,{meta});if(k!==kind) throw new Error(`«${name}»: ожидался ${kind==='plan'?'план':'файл расписания'}.`);return k},
  clear(kind){if(kind==='plan') PLAN=null;else if(kind==='sched') SCHED=null;else{PLAN=null;SCHED=null}FVER++},
  markPublished(kind,meta){const o=kind==='plan'?PLAN:SCHED;if(o){o.local=false;o.meta=meta}},
  // База расписания из таблиц sched_weeks / sched_uploads
  loadSchedDB(rows,uploads,meta){
    const store=new Map();
    for(const r of rows||[]){try{const c=JSON.parse(r.content);c.k=r.wkey;store.set(r.wkey,c)}catch(e){}}
    const hist=(uploads||[]).map(u=>({id:u.id,at:u.at,author:u.author||'',file:u.file||'',weeks:(u.summary&&u.summary.weeks)||[],ch:(u.summary&&u.summary.ch)||{}}));
    const last=hist.find(e=>e.file);
    schedFrom(store,hist,{name:last?last.file:'',meta});
  },
  // Что отправить при публикации: загрузки по порядку. База, опубликованная раньше одним файлом, переносится первой.
  schedPending(){
    if(!SCHED||!SCHED.local) return [];
    const ops=SCHED.pending.slice();
    if(SCHED.legacy) ops.unshift({file:SCHED.legacyName||'',put:[...SCHED.legacyStore.values()],del:[],migrate:true});
    return ops;
  },
  computeUpload,
  setFlags(rows){FLAGS=new Map();for(const r of rows){let s=FLAGS.get(r.grp);if(!s){s=new Set();FLAGS.set(r.grp,s)}s.add(r.code)}FVER++},
  setCanFlag(v){CAN_FLAG=!!v},
  refresh(){buildRegistry();closePreview();render()},
};
if(!CLOUD){
  try{const t=$('#samplePlan').textContent;if(t.trim()) ingest(t,'plany.txt',true)}catch(e){}
  // база расписания, накопленная в этом браузере, иначе — встроенный пример
  let saved=null;try{saved=localStorage.getItem(SKEY_SCHED)}catch(e){}
  if(saved){try{ingest(saved,'',false,{})}catch(e){saved=null}}
  if(!saved){try{const t=$('#sampleSched').textContent;if(t.trim()) ingest(t,'1 семестр — 2 неделя.json',true)}catch(e){}}
  loadLocalFlags();
}
buildRegistry();render();
})();
