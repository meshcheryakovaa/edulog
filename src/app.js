(function(){
'use strict';
// Облачный режим включается, если в config.js заданы адрес и ключ Supabase (см. cloud.js).
const CFG=window.EDULOG_CONFIG||{};
const CLOUD=!!(CFG.supabaseUrl&&CFG.supabaseAnonKey);
let CAN_FLAG=!CLOUD;
// Роль «Просмотр»: доступны только расписание и его печать (план, журнал и словари скрыты)
let VIEW_ONLY=false;
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
const st={view:'plan',mode:'group',key:{group:null,teacher:null,room:null},one:{},q:'',wi:0,onlyMis:false,chOnly:false,dtab:'disc',dq:'',donly:false,pf:null};
try{const s=JSON.parse(localStorage.getItem('plan-sched-view')||'null');if(s){if(s.view) st.view=s.view;if(s.mode) st.mode=s.mode;if(s.dtab) st.dtab=s.dtab;Object.assign(st.key,s.key||{})}}catch(e){}
function save(){try{localStorage.setItem('plan-sched-view',JSON.stringify({view:st.view,mode:st.mode,key:st.key,dtab:st.dtab}))}catch(e){}}
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
    for(const m of e.z||[]){
      if(onlyWeek&&m.from.k!==onlyWeek&&m.to.k!==onlyWeek) continue;
      if(zHas(m,mode,key)) out.push(zRow(e,m,ei));
    }
  });
  return out;
}
/* перенос зачёта как строка таблицы изменений */
function zHas(m,mode,key){
  if(mode==='group') return m.g===key;
  if(mode==='teacher') return [...m.from.t,...m.to.t].includes(key);
  return [...m.from.r,...m.to.r].includes(key);
}
function zRow(e,m,ei){
  const at=m.to.d?m.to:m.from;
  return {e,ei,m,kind:'z',w:{k:at.k||'',week:at.week,start:at.start,end:at.end},c:{g:m.g,d:at.d,p:at.p,dt:at.dt,sg:0},b:[],a:[],
    sk:e.id+'|z|'+[m.g,m.code,m.pre].join('|')};
}
/* все непросмотренные изменения недели: по всем загрузкам, как в «Изменениях этой недели», и переносы зачётов */
function weekUnseen(wk){
  const out=[];if(!SCHED||!wk) return out;
  for(const e of SCHED.history){
    for(const w of e.weeks){if(w.st!=='upd'||w.k!==wk) continue;
      for(const c of e.ch[w.k]||[]){const r={e,w,c};if(!isSeen(r)) out.push(r)}}
    for(const m of e.z||[]){if(m.from.k!==wk&&m.to.k!==wk) continue;const r=zRow(e,m);if(!isSeen(r)) out.push(r)}
  }
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
    if(view==='sched'){
      // «изм.» — только пока на этой неделе есть непросмотренное
      const w=W();const T={group:new Set(),teacher:new Set(),room:new Set()};
      if(w) for(const r of weekUnseen(w.key)){
        if(r.m){T.group.add(r.m.g);[...r.m.from.t,...r.m.to.t].forEach(t=>T.teacher.add(t));[...r.m.from.r,...r.m.to.r].forEach(x=>T.room.add(x))}
        else{const t=touched([r.c]);for(const md of ['group','teacher','room']) t[md].forEach(x=>T[md].add(x))}
      }
      CHMEMO.set(k,T);return T;
    }
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
  buildDiscCat();
}

/* ---------- Словари: короткие названия и свойства строк плана ----------
   Короткое название задаётся дисциплине, преподавателю, группе или аудитории и показывается на экране
   вместо истинного; истинное остаётся во всплывающей подсказке, в PDF и в исходных файлах.
   Дисциплина узнаётся по названию без «1-»/«2-» и «(1 подгруппа)». Обрезанное название из плана
   («ОП.06 Основы предпринима») связывается с полным из расписания, если такое полное одно. */
const DICT_KINDS={disc:'Дисциплины',teacher:'Преподаватели',group:'Группы',room:'Аудитории'};
const emptyNames=()=>({disc:new Map(),teacher:new Map(),group:new Map(),room:new Map()});
let NAMES=emptyNames();
let PROPS=[];            // свойства строк: [{id,name,short,color,sort}]
let RPROPS=new Map();    // группа → Map(строка плана → Set(id свойства))
const DCAT=new Map(),DMAP=new Map();   // каталог дисциплин; название без префиксов → ключ каталога
const lc=s=>s.toLowerCase().replace(/ё/g,'е');
const normDisc=s=>String(s||'').trim().replace(/^[12]-\s*/,'').replace(/\s*\(\s*\d\s*п(?:о(?:д(?:г(?:р(?:у(?:п(?:п\S*)?)?)?)?)?)?)?\s*\)?\s*$/i,'').replace(/\s+/g,' ').trim();
function buildDiscCat(){
  DCAT.clear();DMAP.clear();
  const add=(name,src,g)=>{let e=DCAT.get(name);if(!e){e={key:name,src:new Set(),groups:new Set()};DCAT.set(name,e);DMAP.set(name,name)}e.src.add(src);if(g) e.groups.add(g)};
  if(SCHED) for(const w of SCHED.weeks) for(const r of w.recs){const n=normDisc(r.subject);if(n) add(n,'sched',r.group)}
  const full=[...DCAT.keys()].map(k=>[lc(k),k]);
  if(PLAN) for(const g of PLAN.groups) for(const r of g.rows){
    const n=normDisc(r.disc);if(!n) continue;
    let k=DMAP.get(n);
    if(k===undefined){const l=lc(n);const c=full.filter(x=>x[0].startsWith(l));k=c.length===1?c[0][1]:n;DMAP.set(n,k)}
    add(k,'plan',g.name);
  }
}
const discKey=raw=>{const n=normDisc(raw);return DMAP.get(n)||n};
function dShow(raw){
  raw=String(raw==null?'':raw);const n=normDisc(raw);
  const s=NAMES.disc.get(DMAP.get(n)||n)||NAMES.disc.get(n);if(!s) return raw;
  const p=preOf(raw);return (p?p+'-':'')+s;
}
const tShow=k=>NAMES.teacher.get(k)||tName(k);
const gShow=k=>NAMES.group.get(k)||k;
const rShow=k=>NAMES.room.get(k)||k;
const tShowRaw=n=>{const t=tparse(n);return t?tShow(t.key):n};
// title с истинным названием, если на экране короткое
const tip=(shown,full)=>shown!==full?` title="${esc(full)}"`:'';
const propOrder=(a,b)=>a.sort-b.sort||coll.compare(a.name,b.name);
const okColor=c=>/^#[0-9a-f]{6}$/i.test(c||'')?c:'#1c6a85';
function rpHas(g,disc,id){const m=RPROPS.get(g);const s=m&&m.get(disc);return !!(s&&s.has(id))}
function rpSet(g,disc,id,on){
  let m=RPROPS.get(g);if(!m){if(!on) return;m=new Map();RPROPS.set(g,m)}
  let s=m.get(disc);if(!s){if(!on) return;s=new Set();m.set(disc,s)}
  on?s.add(id):s.delete(id);if(!s.size) m.delete(disc);if(!m.size) RPROPS.delete(g);
}
const rowProps=r=>PROPS.filter(p=>r.groups.every(g=>rpHas(g,r.disc,p.id)));
function propUse(id){let n=0;for(const m of RPROPS.values()) for(const s of m.values()) if(s.has(id)) n++;return n}
const propTag=p=>`<span class="ptag" style="--pc:${okColor(p.color)}" title="${esc(p.name)}">${esc(p.short||p.name)}</span>`;
function setDict(o){
  o=o||{};NAMES=emptyNames();
  for(const r of o.names||[]) if(NAMES[r.kind]&&r.key!=null&&r.short) NAMES[r.kind].set(String(r.key),String(r.short));
  PROPS=(o.props||[]).filter(p=>p&&p.id&&p.name).map(p=>({id:String(p.id),name:String(p.name),short:String(p.short||''),color:okColor(p.color),sort:+p.sort||0})).sort(propOrder);
  RPROPS=new Map();const ids=new Set(PROPS.map(p=>p.id));
  for(const r of o.rprops||[]) if(ids.has(String(r.prop_id))) rpSet(r.grp,r.disc,String(r.prop_id),true);
  FVER++;
}
function dictData(){
  return {names:Object.entries(NAMES).flatMap(([kind,m])=>[...m].map(([key,short])=>({kind,key,short}))),props:PROPS,
    rprops:[...RPROPS].flatMap(([grp,m])=>[...m].flatMap(([disc,s])=>[...s].map(prop_id=>({grp,disc,prop_id}))))};
}
const SKEY_DICT='edulog-dict';
function loadLocalDict(){try{const o=JSON.parse(localStorage.getItem(SKEY_DICT)||'null');if(o) setDict(o)}catch(e){}}
function saveLocalDict(){try{localStorage.setItem(SKEY_DICT,JSON.stringify(dictData()))}catch(e){toast('Не удалось сохранить словари в браузере.',true)}}
/* локально — в браузер; в облаке — в базу, при ошибке изменение откатывается */
function dictSync(op,undo){
  if(!CLOUD){saveLocalDict();return}
  Promise.resolve(window.EduLOGCloud&&window.EduLOGCloud.saveDict(op)).catch(e=>{undo();FVER++;if(st.view==='dict') renderDict();render();toast(e&&e.message||'Не удалось сохранить словарь.',true)});
}
const canDict=()=>!CLOUD||CAN_FLAG;
function setShort(kind,key,v){
  if(!canDict()) return false;
  v=String(v||'').replace(/\s+/g,' ').trim().slice(0,200);
  const old=NAMES[kind].get(key)||'';if(v===old) return false;
  v?NAMES[kind].set(key,v):NAMES[kind].delete(key);FVER++;
  dictSync({t:'name',kind,key,short:v},()=>{old?NAMES[kind].set(key,old):NAMES[kind].delete(key)});
  return true;
}
/* pairs — [[группы, строка плана], …] */
function setRowProp(pairs,id,on){
  if(!canDict()) return;
  const ch=[];for(const [gs,d] of pairs) for(const g of gs) if(rpHas(g,d,id)!==on){rpSet(g,d,id,on);ch.push([g,d])}
  if(!ch.length) return;FVER++;render();
  dictSync({t:'rp',rows:ch,id,on},()=>ch.forEach(([g,d])=>rpSet(g,d,id,!on)));
}
function putProps(list){
  if(!canDict()||!list.length) return;
  const old=PROPS.map(p=>({...p}));
  for(const p of list){const i=PROPS.findIndex(x=>x.id===p.id);if(i>=0) PROPS[i]=p;else PROPS.push(p)}
  PROPS.sort(propOrder);FVER++;
  dictSync({t:'props',list},()=>{PROPS=old});
}
function delProp(id){
  if(!canDict()) return;
  const old=PROPS.map(p=>({...p})),used=[];
  for(const [g,m] of RPROPS) for(const [d,s] of m) if(s.has(id)) used.push([g,d]);
  used.forEach(([g,d])=>rpSet(g,d,id,false));PROPS=PROPS.filter(p=>p.id!==id);FVER++;
  dictSync({t:'propDel',id},()=>{PROPS=old;used.forEach(([g,d])=>rpSet(g,d,id,true))});
}
const newId=()=>'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);

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
/* pairs — [[группы, код], …]: одна отметка или сразу все строки таблицы */
function setFlags(pairs,on){
  if(CLOUD&&!CAN_FLAG){render();return}
  pairs=pairs.filter(([gs,c])=>gs.some(g=>isZ(g,c)!==on));
  if(!pairs.length){render();return}
  pairs.forEach(([gs,c])=>applyFlag(gs,c,on));render();
  if(!CLOUD){saveLocalFlags();zSyncLocal();render();return}
  Promise.resolve(window.EduLOGCloud&&window.EduLOGCloud.saveFlags(pairs,on)).catch(e=>{
    pairs.forEach(([gs,c])=>applyFlag(gs,c,!on));render();toast(e&&e.message||'Не удалось сохранить отметку.',true);
  });
}
const setFlag=(groups,code,on)=>setFlags([[groups,code]],on);
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
/* ---------- Перенос зачётов ----------
   Место зачёта — последняя пара зачётной дисциплины в последней неделе по плану. Оно сдвигается,
   когда меняется недельная нагрузка в плане или расписание недели. Сдвиги записываются в журнал
   загрузок отдельной записью (kind 'zachet', z — список переносов). */
function zachetPos(){
  if(!PLAN||!SCHED) return null;
  const out={};
  for(const g of FLAGS.keys()) for(const it of creditItems(g)){const r=it.rec,w=it.w;
    out[g+'|'+it.code+'|'+it.pre]={g,code:it.code,pre:it.pre,name:it.name,week:it.week,k:w?w.key:null,start:w?w.start:'',end:w?w.end:'',
      d:r?r.day:0,p:r?r.period:0,dt:r&&r.date||'',t:it.teachers,r:it.rooms}}
  return out;
}
function zachetMoves(before,after){
  const out=[];if(!before||!after) return out;
  const pos=x=>({week:x.week,k:x.k,start:x.start,end:x.end,d:x.d,p:x.p,dt:x.dt,t:x.t||[],r:x.r||[]});
  for(const key of Object.keys(after)){const a=after[key],b=before[key];if(!b) continue;
    if(b.week===a.week&&b.d===a.d&&b.p===a.p) continue;
    // неделя только появилась в расписании или удалена из него — это не перенос
    if(b.week===a.week&&(!b.d||!a.d)) continue;
    out.push({g:a.g,code:a.code,pre:a.pre,name:a.name,from:pos(b),to:pos(a)})}
  return out;
}
function addZachetEntry(moves,local){
  if(!SCHED||!moves.length) return;
  SCHED.history.unshift({id:'local-'+Date.now(),at:new Date().toISOString(),author:'',file:'',kind:'zachet',weeks:[],ch:{},z:moves,local});
  SCHED.history.length=Math.min(SCHED.history.length,HIST_MAX);CHMEMO.clear();FVER++;
}
// локальный режим: сравнить с прошлым положением зачётов в этом браузере
const SKEY_ZPOS='edulog-zpos';
function zSyncLocal(){
  if(CLOUD) return;
  const now=zachetPos();if(!now) return;
  let prev=null;try{prev=JSON.parse(localStorage.getItem(SKEY_ZPOS)||'null')}catch(e){}
  const mv=zachetMoves(prev,now);
  if(mv.length){addZachetEntry(mv,false);persistSched()}
  try{localStorage.setItem(SKEY_ZPOS,JSON.stringify(now))}catch(e){}
}

/* ---------- Указатель ---------- */
function items(mode){
  if(st.view==='changes'){
    const C=changeCounts()[mode];const lab=k=>label(mode,k);
    const keys=mode==='group'?REG.groups:mode==='teacher'?[...REG.teachers.keys()]:REG.rooms;
    const list=keys.map(k=>{const n=C.get(k)||0;return {key:k,label:lab(k),present:n>0,n:n?n+' '+plural(n,'изм.','изм.','изм.'):'—'}});
    if(mode==='group') list.forEach(i=>{const c=REG.courses[i.key];i.sec=c?c+' курс':'Шифр …'+i.key.slice(-2);i.secO=c?c:100+(99-(+i.key.slice(-2)||0))});
    return mode==='room'?list:list.sort((a,b)=>coll.compare(a.label,b.label));
  }
  const plan=st.view==='plan', w=W();
  const ALL={key:'*',label:ALL_NAME[mode],all:true,present:true,n:'',sec:'',secO:-1};
  if(mode==='group'){const l=REG.groups.map(n=>groupItem(n,plan,w)).sort((a,b)=>a.secO-b.secO||coll.compare(a.label,b.label));if(!plan&&SCHED) l.unshift(ALL);return l}
  if(mode==='teacher'){const l=[...REG.teachers.values()].map(e=>{const k=e.key;
    if(plan){const rs=planRows('teacher',k);return {key:k,label:tShow(k),present:rs.length>0,n:rs.length?rs.reduce((a,r)=>a+r.hours,0)+' ч':'—'}}
    const rs=schedRecs('teacher',k,w);const s=slots(rs);const p=planPairs('teacher',k,w);
    return {key:k,label:tShow(k),present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар'),dot:!PLAN?'':(p==null&&!s?'none':((p||0)===s?'ok':'warn'))};
  }).sort((a,b)=>coll.compare(a.label,b.label));if(!plan&&SCHED) l.unshift(ALL);return l}
  const list=REG.rooms.map(k=>{
    if(plan){const rs=planRows('room',k);return {key:k,label:rShow(k),present:rs.length>0,n:rs.length?rs.reduce((a,r)=>a+r.hours,0)+' ч':'—'}}
    const rs=schedRecs('room',k,w);const s=slots(rs);return {key:k,label:rShow(k),present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар')};
  });
  if(!plan&&SCHED) list.unshift(ALL);
  return list;
}
function groupItem(n,plan,w){
    const c=REG.courses[n];const sec=c?c+' курс':'Шифр …'+n.slice(-2);const secO=c?c:100+(99-(+n.slice(-2)||0));
    if(plan){const g=planGroup(n);return {key:n,label:gShow(n),sec,secO,present:!!g,n:g?(g.plan??g.rows.reduce((a,r)=>a+r.hours,0))+' ч':'—',
      dot:g?(/недогруз/i.test(g.status)?'warn':'ok'):'none'}}
    const rs=schedRecs('group',n,w);const s=slots(rs);const p=planPairs('group',n,w);
    return {key:n,label:gShow(n),sec,secO,present:rs.length>0,n:s+' '+plural(s,'пара','пары','пар'),dot:p==null?'none':(p===s?'ok':'warn')};
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
  const its=LIST.filter(i=>!q||(i.label+'\n'+fullLabel(st.mode,i.key)).toLowerCase().includes(q));
  if(!its.length){el.innerHTML='<p class="empty-list">Ничего не найдено.</p>';return}
  const cur=st.key[st.mode];
  const T=st.view==='changes'?null:touchedFor(st.view)[st.mode];
  const btn=i=>`<button class="item${i.present?'':' absent'}${i.all?' all':''}" data-key="${esc(i.key)}" aria-current="${i.key===cur}">`+
    (i.dot&&!VIEW_ONLY?`<span class="dot ${i.dot}"></span>`:'')+`<span class="nm"${i.all?'':tip(i.label,fullLabel(st.mode,i.key))}>${esc(i.label)}</span>`+
    (T&&T.has(i.key)?`<span class="chm" title="${st.view==='sched'?'Есть изменения на этой неделе':'Есть изменения в последней загрузке расписания'}">изм.</span>`:'')+`<span class="n">${i.n}</span></button>`;
  if(st.mode==='group'){
    const secs=[...new Map(its.map(i=>[i.sec,i.secO])).entries()].sort((a,b)=>a[1]-b[1]).map(x=>x[0]);
    el.innerHTML=secs.map(s=>(s?`<div class="sec">${esc(s)}</div>`:'')+its.filter(i=>i.sec===s).sort((a,b)=>coll.compare(a.label,b.label)).map(btn).join('')).join('');
  } else el.innerHTML=its.map(btn).join('');
}
function renderTabs(){
  document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.mode===st.mode)));
  document.querySelectorAll('.seg [data-view]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.view===st.view));if(b.dataset.view!=='admin') b.hidden=VIEW_ONLY&&b.dataset.view!=='sched'});
  // счётчик непросмотренных изменений текущей недели (по всем группам) на вкладке «Расписание»
  const sb=$('#view-sched'),w=W(),nu=CAN_SEEN&&w?weekUnseen(w.key).length:0;
  sb.innerHTML='Расписание'+(nu?` <span class="tcnt" title="Непросмотренных изменений на неделе ${esc(w.week||fmtRange(w))}: ${nu}">${nu}</span>`:'');
  document.querySelector('label[for=file]').hidden=VIEW_ONLY;$('#pdf-zach').hidden=VIEW_ONLY;$('#srcPlan').hidden=VIEW_ONLY;
}
const ALL_NAME={group:'Все группы',teacher:'Все преподаватели',room:'Все аудитории'};
const MODE_NAME={group:'группы',teacher:'преподавателя',room:'аудитории'};
const label=(mode,key)=>mode==='teacher'?tShow(key):mode==='group'?gShow(key):rShow(key);
const fullLabel=(mode,key)=>mode==='teacher'?tName(key):String(key);
function titleRow(key){
  const ps=LIST.filter(i=>i.present&&!i.all);const idx=ps.findIndex(i=>i.key===key);
  const dis=ps.length<2?' disabled':'';
  return `<div class="title-row"><button class="arrow" data-step="-1" aria-label="Предыдущий в списке"${dis}>←</button><h1${tip(label(st.mode,key),fullLabel(st.mode,key))}>${esc(label(st.mode,key))}</h1><button class="arrow" data-step="1" aria-label="Следующий в списке"${dis}>→</button></div>`;
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
  PROWS=[];
  const pf=PROPS.find(p=>p.id===st.pf)||null;if(!pf) st.pf=null;
  const pfCount=new Map(PROPS.map(p=>[p.id,0]));rows.forEach(r=>rowProps(r).forEach(p=>pfCount.set(p.id,pfCount.get(p.id)+1)));
  const shownRows=pf?rows.filter(r=>rowProps(r).includes(pf)):rows;
  const body=shownRows.map(r=>{
    const svc=/экзамен|консультац|\.ЭК\b|Квалификац/i.test(r.disc);const tags=[];
    const zc=codeOf(r.disc),zok=!kindOf(r.disc),zon=zok&&r.groups.every(g=>isZ(g,zc));
    let zl=-1;if(zon){r.weeks.forEach((v,i)=>{if(v) zl=i});if(zl+1<bucketLast(r.groups[0],zc,preOf(r.disc))) zl=-1}
    const cb=zok?`<input type="checkbox" class="zcb" data-zg="${esc(r.groups.join('\n'))}" data-zc="${esc(zc)}" title="${CAN_FLAG?'Зачётная дисциплина':'Зачётная дисциплина (менять может редактор)'}" aria-label="Зачёт: ${esc(r.disc)}"${zon?' checked':''}${CAN_FLAG?'':' disabled'}>`:'<span class="zcb-sp"></span>';
    if(r.sub) tags.push(`<span class="tag${r.sub==='Поток'?' acc':''}">${esc(r.sub)}</span>`);
    if(r.kak) tags.push(`<span class="tag" title="Практика блоками">${esc(r.kak)}</span>`);
    const rp=rowProps(r);rp.forEach(p=>tags.push(propTag(p)));
    const pi=PROWS.push([r.groups,r.disc])-1;
    if(PROPS.length&&canDict()) tags.push(`<button class="padd" data-prow="${pi}" aria-haspopup="true" title="Свойства строки" aria-label="Свойства строки: ${esc(r.disc)}">${rp.length?'✎':'+ свойство'}</button>`);
    const grp=mode!=='group'?`<div class="d-grp">${r.groups.map(n=>linkG(n)).join(', ')}</div>`:'';
    const who=showWho?`<td class="c-who">${r.t?linkT(r.t):'—'}</td>`:'';
    const room=showRoom?`<td class="c-room">${r.room?linkR(r.room):'—'}</td>`:'';
    const d=dist(r);
    const ws=totals.map((_,i)=>{const v=r.weeks[i]||0;return v?`<td class="w${curc(i)}${i===zl?' zl':''}" style="--h:${heat(v,cellMax)}"${i===zl?' title="Последняя пара — зачёт"':''}>${v}</td>`:`<td class="w z${curc(i)}">·</td>`}).join('');
    return `<tr class="${svc?'svc':''}"><th class="c-disc" scope="row"><div class="dd">${cb}<div>${grp}<span class="d-name"${tip(dShow(r.disc),r.disc)}>${esc(dShow(r.disc))}</span>${tags.length?`<span class="tags">${tags.join('')}</span>`:''}</div></div></th>${who}${room}<td class="c-num">${r.hours}${d!==r.hours?`<span class="sub">расст. ${d}</span>`:''}</td>${ws}<td class="c-num">${d}</td></tr>`;
  }).join('');
  const zRows=rows.filter(r=>!kindOf(r.disc)),zOn=zRows.filter(r=>r.groups.every(g=>isZ(g,codeOf(r.disc)))).length;
  const zAll=zRows.length?`<input type="checkbox" class="zcb" id="zAll" data-zstate="${zOn===zRows.length?'all':zOn?'some':'none'}" title="${CAN_FLAG?'Отметить зачётными все дисциплины в таблице (повторный щелчок — снять все)':'Менять отметки может редактор'}" aria-label="Зачёт: все дисциплины"${zOn===zRows.length?' checked':''}${CAN_FLAG?'':' disabled'}>`:'<span class="zcb-sp"></span>';
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
  ${PROPS.length?`<div class="pfilter" role="group" aria-label="Отбор строк по свойству"><span class="k">Свойства:</span>${PROPS.map(p=>`<button class="pf${st.pf===p.id?' on':''}" data-pf="${esc(p.id)}" aria-pressed="${st.pf===p.id}">${propTag(p)}<small>${pfCount.get(p.id)}</small></button>`).join('')}${pf?`<button class="link sm" data-pf="">показать все строки</button>`:''}<button class="link sm" data-view-go="dict" data-dtab-go="props">изменить список</button></div>`:''}
  <div class="legend"><span>Флажок слева — зачётная дисциплина: её последняя пара обведена здесь и помечена «зачёт» в расписании; флажок в шапке отмечает или снимает все сразу</span><span>Ячейка недели — число пар (1 пара = 2 ч)</span><span>«расст.» — по неделям расставлено меньше часов, чем по плану</span><span>Свойства строк и короткие названия задаются в разделе «Словари»</span>${chW.size?'<span>Номер недели с точкой — в расписании этой недели были изменения (список внизу)</span>':''}</div>
  <div class="grid-wrap"><table>
    <thead><tr><th class="c-disc" scope="col"><div class="dd">${zAll}<span>${mode==='group'?'Дисциплина':'Группа и дисциплина'}</span></div></th>${showWho?'<th scope="col">Преподаватель</th>':''}${showRoom?'<th scope="col">Ауд.</th>':''}<th class="c-num" scope="col">Часы</th>${weekHead}<th class="c-num" scope="col">Расст.</th></tr></thead>
    <tbody>${body||`<tr><td class="c-disc" colspan="${totals.length+3+span}">Нет строк со свойством «${esc(pf?pf.name:'')}».</td></tr>`}</tbody>
    <tfoot><tr><td class="c-disc">${fileTot?'Итого по файлу':'Итого'}</td>${span?`<td colspan="${span}"></td>`:''}<td class="c-num">${plan}</td>${footW}<td class="c-num">${dsum}</td></tr></tfoot>
  </table></div>${entityChangesPanel(mode,key)}`;
  const za=$('#zAll');if(za) za.indeterminate=za.dataset.zstate==='some';
  ZROWS=zRows.map(r=>[r.groups,codeOf(r.disc)]);
}
let ZROWS=[],PROWS=[];

/* ---------- Вид «Расписание» ---------- */
const linkT=t=>`<button class="link" data-go="teacher" data-key="${esc(t.key)}"${tip(tShow(t.key),tName(t.key))}>${esc(tShow(t.key))}</button>`;
const linkR=r=>`<button class="link" data-go="room" data-key="${esc(r)}"${tip(rShow(r),r)}>${esc(rShow(r))}</button>`;
const linkG=g=>`<button class="link" data-go="group" data-key="${esc(g)}"${tip(gShow(g),g)}>${esc(gShow(g))}</button>`;
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
  if(mode==='group') return `<div class="${cls}">${zt}<div class="ls-s" title="${esc(c.subject)}">${esc(dShow(c.subject))}</div><div class="ls-m">${T}<span>${R}</span>${sg}${odd}${conf}</div></div>`;
  const grp=`<div class="ls-g">${c.groups.map(linkG).join('')}</div>`;
  const other=mode==='teacher'?R:T;
  return `<div class="${cls}">${zt}${grp}<div class="ls-s" title="${esc(c.subject)}">${esc(dShow(c.subject))}</div><div class="ls-m"><span>${other}</span>${sg}${odd}${conf}</div></div>`;
}
/* Ячейка пары: занятие всей группы — на всю ширину, 1 подгруппа — левая половина, 2 подгруппа — правая.
   Если занята только одна подгруппа, вторая половина остаётся пустой. */
function slotBody(its,gs,mode,w,compact){
  const half=sg=>its.filter(c=>c.subgroup===sg).map(c=>lessonCard(c,mode,w,compact)).join('')+gs.filter(g=>g.subgroup===sg).map(g=>ghostCard(g,mode)).join('');
  const full=its.filter(c=>c.subgroup!==1&&c.subgroup!==2).map(c=>lessonCard(c,mode,w,compact)).join('')+gs.filter(g=>g.subgroup!==1&&g.subgroup!==2).map(g=>ghostCard(g,mode)).join('');
  const a=half(1),b=half(2);
  const pair=a||b?`<div class="sg2"><div class="sg-h l">${a||'<div class="sg-free" title="1 подгруппа свободна">1 п/г —</div>'}</div><div class="sg-h r">${b||'<div class="sg-free" title="2 подгруппа свободна">2 п/г —</div>'}</div></div>`:'';
  return full+pair;
}
function weekTable(cs,mode,w,compact,ghosts){
  const head=DAYS.map((d,i)=>`<th scope="col"><span>${d}</span><small>${esc(w.dates[i+1]||'')}</small></th>`).join('');
  let rows='';
  for(let p=1;p<=w.maxP;p++){
    const tm=w.times[p]||['',''];
    rows+='<tr>'+DAYS.map((_,i)=>{const its=cs.filter(c=>c.day===i+1&&c.period===p);
      const gs=(ghosts||[]).filter(g=>g.day===i+1&&g.period===p);
      return `<td><div class="slot-h"><span>${p} пара</span><time>${esc(tm[0])}–${esc(tm[1])}</time></div>${its.length||gs.length?slotBody(its,gs,mode,w,compact):'<div class="nil">—</div>'}</td>`}).join('')+'</tr>';
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
    const who=mode==='group'?`<td class="c-who">${r.tkey?linkT({key:r.tkey}):'—'}</td>`:`<td>${linkG(r.group)}</td>`;
    return `<tr class="${r.mis?'mis':''}"><td${tip(dShow(r.name),r.name)}>${esc(dShow(r.name))}</td>${who}<td class="c-num">${r.plan}</td><td class="c-num">${r.fact}</td><td class="c-num${d?' bad':''}">${d>0?'+'+d:d||'0'}</td></tr>`}).join('');
  return `<section class="panel" aria-label="Сверка с планом">
    <h2>Сверка с планом · неделя ${w.week}${mis?`<span class="pill warn">${mis} ${plural(mis,'расхождение','расхождения','расхождений')}</span>`:'<span class="pill">всё совпадает</span>'}
      ${mis&&mis<rows.length?`<label class="rc-tools"><input type="checkbox" id="onlyMis"${st.onlyMis?' checked':''}> только расхождения</label>`:''}</h2>
    <div class="rc-wrap"><table class="rc"><thead><tr><th>Дисциплина</th><th>${mode==='group'?'Преподаватель':'Группа'}</th><th class="c-num">План, пар</th><th class="c-num">В расписании</th><th class="c-num">Разница</th></tr></thead><tbody>${body||'<tr><td colspan="5">Расхождений нет.</td></tr>'}</tbody></table></div>
    <p class="note">Строки плана и занятия расписания сопоставлены по коду дисциплины, подгруппе («1-»/«2-») и преподавателю. Строки с одинаковым кодом (лекции и практика) объединяются.</p>
  </section>`;
}
function renderSched(key){
  const main=$('#main');
  if(!SCHED||!SCHED.weeks.length) return main.innerHTML=VIEW_ONLY?emptyCard('Расписание не опубликовано','Пока нет ни одной недели расписания. Оно появится здесь, когда редактор его опубликует.'):emptyCard(SCHED?'В базе нет недель':'Расписание не загружено','Откройте JSON-файл расписания (раздел timetable): одна или несколько целых недель. Загрузка заменяет только эти недели, остальные остаются. План при этом останется загруженным, и расписание можно будет сверить с ним.',true);
  const w=W();const mode=st.mode;
  if(key==='*') return renderGrid(w,mode);
  if(key==null) return main.innerHTML=`<div class="head">${weekNav(w)}</div>`+emptyCard('Список пуст','В расписании нет записей для этого раздела.');
  const recs=schedRecs(mode,key,w);const cs=cards(recs,mode);const conf=markConflicts(cs,mode,key);
  const ghosts=markChanges(cs,mode,key,w);const chn=cs.filter(c=>c.chg).length+ghosts.length;
  const s=slots(recs),g=gaps(recs);const pp=VIEW_ONLY?null:planPairs(mode,key,w);
  const days=new Set(recs.map(r=>r.day)).size;
  let stats=`<div class="stat"><dt>Пар за неделю</dt><dd>${s}</dd></div>`;
  if(pp!=null) stats+=`<div class="stat${pp!==s?' warn':''}"><dt>По плану на нед. ${w.week}</dt><dd>${pp}${pp!==s?` <small>${s-pp>0?'+':''}${s-pp}</small>`:''}</dd></div>`;
  if(mode!=='group'){const gs=new Set(recs.map(r=>r.group));stats+=`<div class="stat"><dt>Групп</dt><dd>${gs.size}</dd></div>`}
  stats+=`<div class="stat"><dt>Учебных дней</dt><dd>${days}</dd></div>`;
  if(mode!=='room') stats+=`<div class="stat${g?' warn':''}"><dt>Окна</dt><dd>${g}</dd></div>`;
  if(conf) stats+=`<div class="stat bad"><dt>Накладки</dt><dd>${conf}</dd></div>`;
  const zn=cs.filter(c=>c.zach).length;if(zn) stats+=`<div class="stat bad"><dt>Зачётов на неделе</dt><dd>${zn}</dd></div>`;
  const uns=CAN_SEEN&&SCHED.history.length?entityChanges(mode,key,w.key).filter(r=>!isSeen(r)).length:0;
  if(CAN_SEEN){if(uns) stats+=`<div class="stat acc"><dt>Не просмотрено изменений</dt><dd>${uns}</dd></div>`}
  else if(chn) stats+=`<div class="stat acc"><dt>Изменено при загрузке</dt><dd>${chn}</dd></div>`;
  const course=mode==='group'&&REG.courses[key]?`<span class="pill mute">${REG.courses[key]} курс</span>`:'';
  const head=layoutBar(mode,false)+`<section class="head"><div class="head-l"><span class="eyebrow">Расписание ${MODE_NAME[mode]}</span>${titleRow(key)}${course?`<div>${course}</div>`:''}</div>${weekNav(w)}</section>`;
  const chp=entityChangesPanel(mode,key,{week:w.key,quiet:true});
  if(!recs.length){main.innerHTML=head+emptyCard('Нет занятий',`На этой неделе в расписании нет занятий: ${esc(label(mode,key))}.`)+chp+(VIEW_ONLY?'':reconPanel(mode,key,w));return}
  main.innerHTML=head+`<dl class="stats">${stats}</dl>
    <div class="legend"><span>Клик по преподавателю, аудитории или группе открывает её расписание</span><span>Правый клик — быстрый просмотр недели</span><span>Во всю ширину — вся группа, слева — 1 подгруппа, справа — 2 подгруппа</span>${chn?'<span>«Новое», «Изменено», «Отменено» — по последней загрузке этой недели</span>':''}</div>
    ${weekTable(cs,mode,w,false,ghosts)}${chp}${mode!=='room'&&!VIEW_ONLY?reconPanel(mode,key,w):''}`;
}
/* переключатель вида расписания: одно расписание или сводная таблица (столбцы — группы, преподаватели или аудитории) */
function layoutBar(mode,grid){
  const b=(v,t,on)=>`<button role="tab" data-lay="${v}" aria-selected="${on}">${t}</button>`;
  return `<div class="laybar"><span class="eyebrow">Вид</span><div class="seg" role="tablist" aria-label="Вид расписания">`+
    b('one','По одному',!grid)+`<span class="seg-sep">Сводная таблица:</span>`+
    b('group','группы',grid&&mode==='group')+b('teacher','преподаватели',grid&&mode==='teacher')+b('room','аудитории',grid&&mode==='room')+`</div></div>`;
}
/* сводная таблица недели: столбцы — все группы / преподаватели / аудитории, строки — пары по дням */
function renderGrid(w,mode){
  const cs=cards(w.recs,mode);
  const keysOf=c=>mode==='group'?c.groups:mode==='teacher'?c.teachers.map(t=>t.key):c.rooms;
  const cell=new Map();
  cs.forEach(c=>keysOf(c).forEach(k=>{const id=k+'|'+c.day+'|'+c.period;(cell.get(id)||cell.set(id,[]).get(id)).push(c)}));
  let cols=[...new Set(cs.flatMap(keysOf))];
  if(mode==='group') cols.sort((a,b)=>(REG.courses[a]||99)-(REG.courses[b]||99)||coll.compare(gShow(a),gShow(b)));
  else if(mode==='teacher') cols.sort((a,b)=>coll.compare(tShow(a),tShow(b)));
  else cols.sort(cmpRooms);
  const days=[...new Set(w.recs.map(r=>r.day))].sort((a,b)=>a-b);
  let conf=0;
  const clash=(its,k)=>{
    if(its.length<2) return false;
    if(mode==='group'){const sg=its.map(c=>c.subgroup||0);return sg.includes(0)||new Set(sg).size<sg.length}
    if(mode==='room') return /^\d/.test(k);
    return true;
  };
  const tz=c=>c.zach?'<span class="ctag z">Зачёт</span>':'';
  const occ=c=>{
    const T=c.teachers.map(t=>linkT(t)).join(', '),R=c.rooms.map(linkR).join(', '),G=c.groups.map(linkG).join(', ');
    const S=`<span class="s" title="${esc(c.subject)}">${esc(dShow(c.subject))}</span>`;
    const sg=c.subgroup?`<span class="tag">${sgText(c.subgroup)}</span>`:'';
    if(mode==='group') return `<div class="occ">${tz(c)}${S}<small>${T||'—'}${R?' · '+R:''} ${sg}</small></div>`;
    if(mode==='teacher') return `<div class="occ"><span>${G} ${sg}</span>${tz(c)}${S}<small>${R||'—'}</small></div>`;
    return `<div class="occ"><span>${G} ${sg}</span><small>${T||'—'}</small></div>`;
  };
  const td=(k,d,p)=>{
    const its=cell.get(k+'|'+d+'|'+p)||[];if(!its.length) return '<td></td>';
    const bad=clash(its,k);if(bad) conf++;
    if(mode==='room'&&its.length>3) return `<td class="busy"><div class="occ" title="${esc(its.map(c=>c.groups.join(', ')+' — '+dShow(c.subject)).join('\n'))}"><span>${its.flatMap(c=>c.groups).map(linkG).join(', ')}</span><small>${its.length} ${plural(its.length,'занятие','занятия','занятий')}</small></div></td>`;
    // у группы 1 и 2 подгруппа — рядом, как в карточках
    if(mode==='group'&&!bad&&its.every(c=>c.subgroup)){
      const by=n=>its.filter(c=>c.subgroup===n);
      return `<td class="busy"><div class="sgs"><div>${by(1).map(occ).join('')}</div><div>${its.filter(c=>c.subgroup!==1).map(occ).join('')}</div></div></td>`;
    }
    return `<td class="${bad?'conf':'busy'}">${its.map(occ).join('')}</td>`;
  };
  const headCell=k=>{
    if(mode==='room'){const p=NAMES.room.has(k)?{code:rShow(k),owner:''}:roomParts(k);return `<th scope="col"><button class="link" data-go="room" data-key="${esc(k)}" title="${esc(k)}"><b>${esc(p.code)}</b></button>${p.owner?`<small>${esc(p.owner)}</small>`:''}</th>`}
    if(mode==='teacher') return `<th scope="col"><button class="link" data-go="teacher" data-key="${esc(k)}" title="${esc(tName(k))}"><b>${esc(tShow(k))}</b></button></th>`;
    return `<th scope="col"><button class="link" data-go="group" data-key="${esc(k)}" title="${esc(k)}"><b>${esc(gShow(k))}</b></button></th>`;
  };
  // у групп над шапкой — строка курсов
  let pre='';
  if(mode==='group'){
    const runs=[];cols.forEach(k=>{const c=REG.courses[k]||0;const l=runs[runs.length-1];if(l&&l.c===c) l.n++;else runs.push({c,n:1})});
    pre=`<tr class="rg-c"><th class="rg-d"></th><th class="rg-p"></th>${runs.map(r=>`<th colspan="${r.n}" scope="colgroup"><span>${r.c?r.c+' курс':'без курса'}</span></th>`).join('')}</tr>`;
  }
  let body='';
  for(const d of days) for(let p=1;p<=w.maxP;p++){
    const tm=w.times[p]||['',''];
    body+=`<tr class="${p===1&&d!==days[0]?'ds':''}">${p===1?`<th class="rg-d" rowspan="${w.maxP}" scope="rowgroup"><span>${DAYS[d-1]} ${esc(w.dates[d]||'')}</span></th>`:''}<th class="rg-p" scope="row"><b>${p}</b> ${esc(tm[0])}</th>${cols.map(k=>td(k,d,p)).join('')}</tr>`;
  }
  const what={group:['Групп','Все группы'],teacher:['Преподавателей','Все преподаватели'],room:['Аудиторий','Все аудитории']}[mode];
  $('#main').innerHTML=layoutBar(mode,true)+`<section class="head"><div class="head-l"><span class="eyebrow">Сводная таблица</span><h1>${what[1]}</h1></div>${weekNav(w)}</section>
    <dl class="stats"><div class="stat"><dt>${what[0]}</dt><dd>${cols.length}</dd></div><div class="stat"><dt>Занятий</dt><dd>${cs.length}</dd></div>${conf?`<div class="stat bad"><dt>Накладки</dt><dd>${conf}</dd></div>`:''}</dl>
    <div class="legend"><span>Столбцы — ${what[1].toLowerCase()}, строки — пары по дням недели</span><span>Клик по заголовку столбца — его расписание</span><span>Красным — накладки</span></div>
    <div class="rg-wrap"><table class="rg rg-${mode}"><thead>${pre}<tr><th class="rg-d" scope="col">День</th><th class="rg-p" scope="col">Пара</th>${cols.map(headCell).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Отображение изменений ---------- */
const DSHORT=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const KIND={add:['Добавлено','add'],del:['Отменено','del'],chg:['Изменено','chg'],z:['Зачёт перенесён','z']};
const sgText=sg=>sg?(sg<=2?sg+' п/г':'п/г '+sg):'';
function itemHtml(it,ref){
  // ref — другая сторона изменения: подчёркиваем то, что отличается
  const diff=(v,o)=>ref&&ref.length&&!ref.some(x=>o(x)===v)?' class="df"':'';
  const T=it.t.join(', '),R=it.r.join(', ');
  return `<span${diff(it.s,x=>x.s)} title="${esc(it.s)}">${esc(dShow(it.s))}</span>`+
    `<small>${T?`<span${diff(T,x=>x.t.join(', '))}>${esc(it.t.map(tShowRaw).join(', '))}</span>`:'<span>без преподавателя</span>'}${R?` · <span${diff(R,x=>x.r.join(', '))}>${esc(it.r.map(rShow).join(', '))}</span>`:''}${it.tm&&ref&&ref.length&&!ref.some(x=>x.tm===it.tm)?` · <span class="df">${esc(it.tm)}</span>`:''}</small>`;
}
const zWhere=x=>`нед. ${x.week}${x.d?`, ${DSHORT[x.d-1]||x.d}${x.dt?' '+esc(x.dt.slice(0,5).replace(/-/g,'.')):''}, ${x.p} пара`:' (недели нет в расписании)'}`;
function whatHtml(r){
  if(r.kind==='z'){const m=r.m;return `<div class="ci"><span title="${esc(m.name)}">${esc(dShow(m.name))}</span><small class="zw">было: <s>${zWhere(m.from)}</s></small><small class="zw">стало: <b>${zWhere(m.to)}</b></small></div>`}
  if(r.kind==='add') return r.a.map(it=>`<div class="ci">${itemHtml(it)}</div>`).join('');
  if(r.kind==='del') return r.b.map(it=>`<div class="ci was">${itemHtml(it)}</div>`).join('');
  return r.b.map(it=>`<div class="ci was">${itemHtml(it,r.a)}</div>`).join('')+`<div class="arrow-d" aria-hidden="true">↓</div>`+r.a.map(it=>`<div class="ci">${itemHtml(it,r.b)}</div>`).join('');
}
const kindTag=k=>`<span class="ck ${KIND[k][1]}">${KIND[k][0]}</span>`;
const whenTxt=c=>!c.d?'—':`${DSHORT[c.d-1]||c.d}${c.dt?' '+esc(c.dt.slice(0,5).replace(/-/g,'.')):''}, ${c.p} пара${c.sg?' · '+sgText(c.sg):''}`;
function uploadStamp(e){
  const d=new Date(e.at);const t=isNaN(d)?'':fmtStamp(e.at);
  return `${esc(t)}${e.author?' · '+esc(e.author):''}${e.local?' <span class="pill warn" title="Изменение видно только вам, пока не нажата «Опубликовать»">не опубликовано</span>':''}`;
}
/* ---------- Отметки «просмотрено» ----------
   У каждого пользователя свои. Ключ — загрузка + неделя + группа, день, пара и подгруппа,
   поэтому одно изменение отмечается сразу везде: у группы, преподавателя и аудитории. */
let SEEN=new Set(), CAN_SEEN=!CLOUD;
const SKEY_SEEN='edulog-seen';
const seenKey=r=>r.sk||r.e.id+'|'+[r.w.k,r.c.g,r.c.d,r.c.p,r.c.sg||0].join('|');
const isSeen=r=>CAN_SEEN&&SEEN.has(seenKey(r));
// неопубликованную загрузку отметить нельзя: у неё ещё нет номера в базе
const seenable=r=>CAN_SEEN&&!r.e.local;
function loadLocalSeen(){try{const a=JSON.parse(localStorage.getItem(SKEY_SEEN)||'[]');if(Array.isArray(a)) SEEN=new Set(a)}catch(e){}}
function saveLocalSeen(){
  // отметки удалённых из журнала загрузок больше не нужны
  const ids=new Set(SCHED?SCHED.history.map(e=>String(e.id)):[]);
  try{localStorage.setItem(SKEY_SEEN,JSON.stringify([...SEEN].filter(k=>ids.has(k.slice(0,k.indexOf('|'))))))}catch(e){}
}
function setSeen(keys,on){
  keys=[...new Set(keys)].filter(k=>SEEN.has(k)!==on);if(!keys.length){render();return}
  const apply=v=>{keys.forEach(k=>v?SEEN.add(k):SEEN.delete(k));CHMEMO.clear()};
  apply(on);render();
  if(!CLOUD){saveLocalSeen();return}
  Promise.resolve(window.EduLOGCloud&&window.EduLOGCloud.saveSeen(keys,on)).catch(e=>{apply(!on);render();toast(e&&e.message||'Не удалось сохранить отметку.',true)});
}
let PANEL_FRESH=[]; // ключи непросмотренных в панели «Изменения этой недели» — для «отметить все»
function seenCell(r){
  if(!seenable(r)) return `<td class="c-seen"><input type="checkbox" class="seen-cb" disabled title="${r.e.local?'Отметить можно после публикации':'Отмечать могут пользователи с ролью «Просмотр» и выше'}" aria-label="Просмотрено"></td>`;
  const on=isSeen(r);
  return `<td class="c-seen"><input type="checkbox" class="seen-cb" data-sk="${esc(seenKey(r))}"${on?' checked':''} title="${on?'Просмотрено — снять отметку':'Отметить как просмотренное'}" aria-label="Просмотрено"></td>`;
}
/* таблица изменений для группы, преподавателя или аудитории */
function changesTable(rows,mode,opt){
  opt=opt||{};
  const showWeek=!opt.week, showGroup=opt.showGroup!=null?opt.showGroup:mode!=='group', showSeen=CAN_SEEN;
  return `<div class="rc-wrap"><table class="rc chg-t"><thead><tr>${showSeen?'<th class="c-seen" title="Просмотрено">✓</th>':''}${showWeek?'<th>Неделя</th>':''}<th>Когда</th>${showGroup?'<th>Группа</th>':''}<th>Что</th><th>Загрузка</th></tr></thead><tbody>`+
    rows.map(r=>`<tr class="k-${r.kind}${showSeen&&isSeen(r)?' seen':''}">${showSeen?seenCell(r):''}${showWeek?`<td class="c-num"><button class="link" data-gowk="${esc(r.w.k)}">${r.w.week?'нед. '+r.w.week:esc(fmtRange(r.w))}</button></td>`:''}`+
      `<td class="when">${whenTxt(r.c)}</td>${showGroup?`<td>${linkG(r.c.g)}</td>`:''}<td class="what">${kindTag(r.kind)}${whatHtml(r)}</td><td class="up">${esc(r.e.file||(r.e.kind==='zachet'?'перенос зачёта':'—'))}<small>${uploadStamp(r.e)}</small></td></tr>`).join('')+
    '</tbody></table></div>';
}
function entityChangesPanel(mode,key,opt){
  opt=opt||{};
  if(!SCHED||!SCHED.history.length||key==null||key==='*') return '';
  const all=entityChanges(mode,key,opt.week);
  const lim=opt.limit||12;
  const title=opt.week?`Изменения этой недели`:'Изменения в расписании';
  if(!all.length) return opt.quiet?'':`<section class="panel chg-p"><h2>${title}<span class="pill">нет</span></h2><p class="note">${opt.week?'При загрузках расписания эта неделя для выбранного не менялась.':'В загруженных файлах расписания для выбранного ничего не менялось.'}</p></section>`;
  // непросмотренные сверху, просмотренные — свёрнутой группой внизу
  const old=CAN_SEEN?all.filter(isSeen):[], fresh=CAN_SEEN?all.filter(r=>!isSeen(r)):all;
  const n={add:0,del:0,chg:0,z:0};fresh.forEach(r=>n[r.kind]++);
  const pills=['add','chg','del','z'].filter(k=>n[k]).map(k=>`<span class="ck ${KIND[k][1]}">${KIND[k][0]}: ${n[k]}</span>`).join('')+
    (old.length?`<span class="pill mute">просмотрено: ${old.length}</span>`:'');
  const more=fresh.length>lim?`<details class="more"><summary>Показать все (${fresh.length})</summary>${changesTable(fresh.slice(lim),mode,opt)}</details>`:'';
  const canAll=fresh.filter(seenable);PANEL_FRESH=canAll.map(seenKey);
  const allBtn=canAll.length>1?`<button class="link sm" data-seenall>отметить все просмотренными</button>`:'';
  const freshHtml=fresh.length?changesTable(fresh.slice(0,lim),mode,opt)+more:`<p class="note seen-done">Все изменения просмотрены.</p>`;
  const oldHtml=old.length?`<details class="more seen-g"><summary>Просмотренные (${old.length})</summary>${changesTable(old,mode,opt)}</details>`:'';
  return `<section class="panel chg-p" aria-label="${title}"><h2>${title}<span class="cks">${pills}</span>${allBtn}${VIEW_ONLY?'':'<button class="link sm" data-view-go="changes">весь журнал →</button>'}</h2>
    ${freshHtml}${oldHtml}
    <p class="note">${opt.week?'Сравнение с тем, что было в базе до последней загрузки этой недели.':'По журналу загрузок расписания, новые сверху. Каждая загрузка заменяет только недели из своего файла.'}</p></section>`;
}
/* подсветка в сетке недели: что добавлено/изменено, и «призраки» отменённых занятий */
function markChanges(cs,mode,key,w){
  const u=weekLastUpload(w.key);if(!u) return [];
  const ghosts=[];
  for(const c of u.ch){
    if(isSeen({e:u.e,w:u.w,c})) continue; // просмотренное больше не подсвечиваем
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
  const it=g.it;const T=it.t.map(tShowRaw).join(', '),R=it.r.map(rShow).join(', ');const who=mode==='group'?T:mode==='teacher'?[gShow(g.group),R].filter(Boolean).join(' · '):[gShow(g.group),T].filter(Boolean).join(' · ');
  return `<div class="ls gone" title="Отменено при последней загрузке этой недели"><span class="ctag del">Отменено</span><div class="ls-s" title="${esc(it.s)}">${esc(dShow(it.s))}</div><div class="ls-m"><span>${esc(who||'—')}</span>${g.subgroup?`<span class="tag">${sgText(g.subgroup)}</span>`:''}</div></div>`;
}

/* ---------- Вид «Изменения» ---------- */
let CNT={v:-1,m:null};
function changeCounts(){
  if(CNT.v===FVER) return CNT.m;
  const m={group:new Map(),teacher:new Map(),room:new Map()};
  if(SCHED) for(const e of SCHED.history) for(const w of e.weeks){if(w.st!=='upd') continue;
    for(const c of e.ch[w.k]||[]){const T=touched([c]);for(const md of ['group','teacher','room']) for(const k of T[md]) m[md].set(k,(m[md].get(k)||0)+1)}}
  if(SCHED) for(const e of SCHED.history) for(const z of e.z||[]){
    const T={group:new Set([z.g]),teacher:new Set([...z.from.t,...z.to.t]),room:new Set([...z.from.r,...z.to.r])};
    for(const md of ['group','teacher','room']) for(const k of T[md]) m[md].set(k,(m[md].get(k)||0)+1)}
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
    const zl=(e.z||[]).filter(m=>!only||zHas(m,mode,key)).map(m=>zRow(e,m));
    if(zl.length) inner+=`<h3>Перенос зачётов <small>сдвинулась последняя пара зачётной дисциплины</small></h3>`+changesTable(zl,mode,{showGroup:!only||mode!=='group'});
    if(only&&!inner) return;
    const head=`<span class="up-t"><b>${esc(e.file||(e.kind==='zachet'?'Перенос зачётов':e.weeks.every(w=>w.st==='del')?'Удаление недель':'Загрузка'))}</b><small>${uploadStamp(e)}</small></span><span class="wchips">${e.weeks.map(weekChip).join('')}</span>`;
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

/* ---------- Вид «Словари» ---------- */
const DICT_MAX=500;
function dictEntries(kind){
  let list;
  if(kind==='disc') list=[...DCAT.values()].map(e=>({key:e.key,full:e.key,meta:[e.src.has('plan')?'план':'',e.src.has('sched')?'расписание':''].filter(Boolean).join(', ')+(e.groups.size?` · ${e.groups.size} ${plural(e.groups.size,'группа','группы','групп')}`:'')}));
  else if(kind==='teacher') list=[...REG.teachers.keys()].map(k=>({key:k,full:tName(k),meta:''}));
  else if(kind==='group') list=REG.groups.map(k=>({key:k,full:k,meta:REG.courses[k]?REG.courses[k]+' курс':''}));
  else list=REG.rooms.map(k=>({key:k,full:k,meta:''}));
  list.sort((a,b)=>coll.compare(a.full,b.full));
  // короткие названия для того, чего нет в открытых файлах, не теряются — их видно и можно убрать
  const have=new Set(list.map(e=>e.key));
  for(const k of NAMES[kind].keys()) if(!have.has(k)) list.push({key:k,full:k,meta:'нет в открытых файлах',gone:true});
  return list;
}
function dictRowsHtml(){
  const kind=st.dtab,q=lc(st.dq.trim()),ro=!canDict();
  const all=dictEntries(kind).filter(e=>(!st.donly||NAMES[kind].has(e.key))&&(!q||lc(e.full+'\n'+(NAMES[kind].get(e.key)||'')).includes(q)));
  const shown=all.slice(0,DICT_MAX);
  const html=shown.map(e=>{const s=NAMES[kind].get(e.key)||'';
    return `<tr class="${e.gone?'off':''}${s?' has':''}"><td class="d-full">${esc(e.full)}</td><td class="d-short"><input type="text" class="dshort" data-dk="${esc(e.key)}" value="${esc(s)}" placeholder="как в истинном" maxlength="200" aria-label="Короткое название: ${esc(e.full)}"${ro?' disabled':''}></td><td class="d-meta">${esc(e.meta)}</td></tr>`}).join('');
  const cnt=`${all.length} ${plural(all.length,'запись','записи','записей')}`+(all.length>shown.length?`, показаны первые ${shown.length} — уточните поиск`:'');
  return {html:html||'<tr><td colspan="3" class="d-meta">Ничего не найдено.</td></tr>',cnt};
}
function fillDict(){const b=$('#dbody');if(!b) return;const r=dictRowsHtml();b.innerHTML=r.html;$('#dcount').textContent=r.cnt}
function propsPanel(){
  const ro=!canDict(),dis=ro?' disabled':'';
  const rows=PROPS.map((p,i)=>{const n=propUse(p.id);
    return `<tr><td><input type="color" class="pcolor" data-pid="${esc(p.id)}" value="${okColor(p.color)}" aria-label="Цвет: ${esc(p.name)}"${dis}></td>`+
      `<td><input type="text" class="pname" data-pid="${esc(p.id)}" value="${esc(p.name)}" maxlength="200" aria-label="Название свойства"${dis}></td>`+
      `<td><input type="text" class="pshort" data-pid="${esc(p.id)}" value="${esc(p.short)}" placeholder="как в названии" maxlength="40" aria-label="Короткое название: ${esc(p.name)}"${dis}></td>`+
      `<td>${propTag(p)}</td><td class="c-num">${n}</td>`+
      `<td class="p-act">${ro?'':`<button class="link sm" data-pmove="-1" data-pid="${esc(p.id)}" aria-label="Выше"${i?'':' disabled'}>↑</button> <button class="link sm" data-pmove="1" data-pid="${esc(p.id)}" aria-label="Ниже"${i<PROPS.length-1?'':' disabled'}>↓</button> <button class="link sm danger" data-pdel="${esc(p.id)}" data-n="${n}">удалить</button>`}</td></tr>`}).join('');
  return `<section class="panel"><h2>Свойства строк недельного плана <span class="pill mute">${PROPS.length}</span></h2>
    ${ro?'':`<form class="dict-tools" id="padd"><input type="text" id="pnew" placeholder="Новое свойство, например «Дистанционно»" maxlength="200" aria-label="Название нового свойства"><input type="color" id="pnewc" value="${PCOLORS[PROPS.length%PCOLORS.length]}" aria-label="Цвет нового свойства"><button class="btn sm" type="submit">Добавить</button></form>`}
    ${PROPS.length?`<div class="rc-wrap"><table class="rc dict-t props-t"><thead><tr><th>Цвет</th><th>Название</th><th>Короткое</th><th>Как выглядит</th><th class="c-num">Строк</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="note">Свойств пока нет. Добавьте первое — и в недельном плане у каждой строки появится кнопка «+ свойство».</p>'}
    <p class="note">Свойства ставятся на строки (дисциплины) в недельном плане: кнопка «+ свойство» или «✎» рядом с названием. Над таблицей плана по свойству можно отобрать строки. Удаление свойства снимает его со всех строк.${CLOUD&&ro?' Менять список может редактор.':''}</p></section>`;
}
function renderDict(){
  const t=st.dtab in DICT_KINDS||st.dtab==='props'?st.dtab:(st.dtab='disc');
  const tabs=[...Object.entries(DICT_KINDS),['props','Свойства строк']].map(([k,n])=>{const c=k==='props'?PROPS.length:NAMES[k].size;
    return `<button type="button" role="tab" data-dtab="${k}" aria-selected="${k===t}">${n}${c?` <span class="pill mute">${c}</span>`:''}</button>`}).join('');
  let body;
  if(t==='props') body=propsPanel();
  else{
    const hint={disc:'Дисциплина узнаётся по коду и названию без «1-»/«2-» и «(1 подгруппа)», поэтому одно короткое название действует во всех группах и подгруппах. Обрезанные названия из плана связаны с полными из расписания.',
      teacher:'Короткое имя заменяет «Фамилия И.О.» в списке, таблицах и карточках расписания.',group:'Короткое название группы показывается в списке, таблицах и карточках расписания.',
      room:'Например, «15» вместо «15 Михайличенко».'}[t];
    body=`<section class="panel"><div class="dict-tools"><input type="search" id="dq" placeholder="Поиск по истинному или короткому названию" value="${esc(st.dq)}" autocomplete="off" aria-label="Поиск в словаре">
      <label class="rc-tools"><input type="checkbox" id="donly"${st.donly?' checked':''}> только с коротким названием</label><span class="sp"></span><span class="d-meta" id="dcount"></span></div>
      <div class="rc-wrap"><table class="rc dict-t"><thead><tr><th>Истинное название</th><th>Короткое название (на экране)</th><th>${t==='disc'?'Где встречается':t==='group'?'Курс':''}</th></tr></thead><tbody id="dbody"></tbody></table></div>
      <p class="note">${hint} Пустое поле — показывается истинное название. Истинное остаётся во всплывающей подсказке, в PDF и в файлах.${CLOUD&&!canDict()?' Менять словари может редактор.':''}</p></section>`;
  }
  const empty=!PLAN&&!SCHED&&t!=='props'?'<p class="note">Откройте план или расписание — словари заполняются названиями из них.</p>':'';
  $('#main').innerHTML=`<section class="head"><div class="head-l"><span class="eyebrow">Справочники</span><h1>Словари</h1></div></section>
    <div class="gtabs adm-tabs" role="tablist">${tabs}</div><div class="adm-body">${empty}${body}</div>`;
  if(t!=='props') fillDict();
}
/* меню свойств строки плана */
const PMENU=document.createElement('div');PMENU.className='pmenu-pop';PMENU.id='propMenu';PMENU.hidden=true;document.body.appendChild(PMENU);
function fillPropMenu(){
  const row=PROWS[+PMENU.dataset.row];if(!row){PMENU.hidden=true;return}
  const [gs,disc]=row;
  PMENU.innerHTML=`<div class="eyebrow">Свойства строки</div><div class="pm-t" title="${esc(disc)}">${esc(dShow(disc))}${gs.length>1?` <small>· ${gs.length} ${plural(gs.length,'группа','группы','групп')}</small>`:''}</div>`+
    PROPS.map(p=>{const on=gs.every(g=>rpHas(g,disc,p.id)),some=!on&&gs.some(g=>rpHas(g,disc,p.id));
      return `<label><input type="checkbox" data-pm="${esc(p.id)}"${on?' checked':''}${some?' data-some="1"':''}> ${propTag(p)}${p.short&&p.short!==p.name?` <small>${esc(p.name)}</small>`:''}</label>`}).join('')+
    `<button class="link sm" data-view-go="dict" data-dtab-go="props">изменить список свойств</button>`;
  PMENU.querySelectorAll('[data-some]').forEach(x=>x.indeterminate=true);
}
function openPropMenu(btn){
  PMENU.dataset.row=btn.dataset.prow;fillPropMenu();PMENU.hidden=false;
  btn.setAttribute('aria-expanded','true');
  const r=btn.getBoundingClientRect(),w=PMENU.offsetWidth;
  PMENU.style.left=Math.max(8,Math.min(r.left+scrollX,scrollX+document.documentElement.clientWidth-w-8))+'px';
  PMENU.style.top=(r.bottom+scrollY+4)+'px';
  const f=PMENU.querySelector('input');if(f) f.focus();
}
const closePropMenu=()=>{PMENU.hidden=true};
PMENU.addEventListener('change',e=>{
  const c=e.target.closest('[data-pm]');if(!c) return;const row=PROWS[+PMENU.dataset.row];if(!row) return;
  setRowProp([[row[0],row[1]]],c.dataset.pm,c.checked);fillPropMenu();
  const f=PMENU.querySelector(`[data-pm="${CSS.escape(c.dataset.pm)}"]`);if(f) f.focus();
});
document.addEventListener('click',e=>{
  if(PMENU.hidden||e.target.closest('#propMenu')&&!e.target.closest('[data-view-go]')) return;
  if(!e.target.closest('[data-prow]')) closePropMenu();
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!PMENU.hidden) closePropMenu()});
addEventListener('resize',closePropMenu);

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
  if(VIEW_ONLY&&st.view!=='sched'&&st.view!=='admin') st.view='sched';
  renderTabs();
  document.body.classList.toggle('v-admin',st.view==='admin');
  document.body.classList.toggle('v-dict',st.view==='dict');
  if(st.view!=='plan') closePropMenu();
  if(st.view==='dict'){
    // фоновое обновление не сбивает ввод: пока курсор в поле словаря, страница не перерисовывается
    const a=document.activeElement;
    if(!(a&&a.matches('input[type=text],input[type=search]')&&$('#main').contains(a))) renderDict();
    renderSources();save();return;
  }
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
  if(VIEW_ONLY){toast('Роль «Просмотр»: открывать файлы может редактор.',true);return}
  const done=[],report=[];let last=null;
  // файлы применяются по очереди: если одна неделя есть в двух файлах, останется из последнего
  for(const f of files){try{last=ingest(decode(await f.arrayBuffer()),f.name,false,{local:true,report});done.push(f.name)}catch(e){toast(e.message||'Не удалось открыть файл.',true)}}
  if(!done.length) return;
  buildRegistry();zSyncLocal();if(last) st.view=report.length?'changes':last;closePreview();render();
  if(report.length) toast('Расписание: '+report.map(uploadSummary).join('; ')+(CLOUD?'. Нажмите «Опубликовать», чтобы изменения увидели все.':''));
  else toast(done.length>1?`Открыты файлы: ${done.join(', ')}`:`Открыт файл «${done[0]}»`);
}
$('#file').addEventListener('change',e=>{openFiles([...e.target.files]);e.target.value=''});
let dragN=0;
addEventListener('dragenter',e=>{if(!VIEW_ONLY&&[...(e.dataTransfer&&e.dataTransfer.types||[])].includes('Files')){dragN++;$('#drop').hidden=false}});
addEventListener('dragleave',()=>{if(--dragN<=0){dragN=0;$('#drop').hidden=true}});
addEventListener('dragover',e=>e.preventDefault());
addEventListener('drop',e=>{e.preventDefault();dragN=0;$('#drop').hidden=true;openFiles([...e.dataTransfer.files])});

/* ---------- Навигация ---------- */
function go(mode,key){st.mode=mode;st.key[mode]=key;st.q='';$('#q').value='';closePreview();render();scrollTo({top:0})}
document.querySelector('.seg').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b) return;st.view=b.dataset.view;render()});
document.querySelector('.tabs').addEventListener('click',e=>{const b=e.target.closest('.tab');if(!b) return;st.mode=b.dataset.mode;st.q='';$('#q').value='';render()});
$('#list').addEventListener('click',e=>{const b=e.target.closest('.item');if(!b) return;st.key[st.mode]=b.dataset.key;render();if(innerWidth<=820) $('#main').scrollIntoView({behavior:'smooth'})});
$('#q').addEventListener('input',e=>{st.q=e.target.value;renderList()});
document.addEventListener('input',e=>{if(e.target.id==='dq'){st.dq=e.target.value;fillDict()}});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches&&e.target.matches('.dshort,.pname,.pshort')){e.preventDefault();e.target.blur()}});
document.addEventListener('submit',e=>{
  if(e.target.id!=='padd') return;e.preventDefault();
  const v=$('#pnew').value.replace(/\s+/g,' ').trim().slice(0,200);if(!v){$('#pnew').focus();return}
  if(PROPS.some(p=>lc(p.name)===lc(v))){toast('Такое свойство уже есть.',true);return}
  putProps([{id:newId(),name:v,short:'',color:okColor($('#pnewc').value),sort:PROPS.reduce((a,p)=>Math.max(a,p.sort),0)+1}]);
  renderDict();const f=$('#pnew');if(f){f.focus();$('#pnewc').value=PCOLORS[PROPS.length%PCOLORS.length]}
});
const PCOLORS=['#1c6a85','#c0392b','#2c7349','#7a4fb0','#d68910','#16a085','#b03a8c','#5d6d7e'];
function movePropBy(id,d){
  const i=PROPS.findIndex(p=>p.id===id),j=i+d;if(i<0||j<0||j>=PROPS.length) return;
  const list=PROPS.map((p,k)=>({...p,sort:k+1}));[list[i].sort,list[j].sort]=[list[j].sort,list[i].sort];
  putProps(list.filter((p,k)=>p.sort!==PROPS[k].sort));renderDict();
}
document.addEventListener('click',e=>{
  const g=e.target.closest('[data-go]');if(g){go(g.dataset.go,g.dataset.key);return}
  const ly=e.target.closest('[data-lay]');if(ly){const m=ly.dataset.lay;
    if(m==='one'){if(st.key[st.mode]==='*') st.key[st.mode]=st.one[st.mode]||null}
    else{if(st.key[m]!=='*') st.one[m]=st.key[m];st.mode=m;st.key[m]='*'}
    st.q='';$('#q').value='';render();return}
  const s=e.target.closest('[data-step]');
  if(s){const ps=LIST.filter(i=>i.present&&!i.all);if(ps.length<2) return;const i=ps.findIndex(x=>x.key===st.key[st.mode]);
    st.key[st.mode]=ps[((i<0?0:i)+(+s.dataset.step)+ps.length)%ps.length].key;render();return}
  const wk=e.target.closest('[data-wk]');if(wk&&SCHED){st.wi=Math.max(0,Math.min(SCHED.weeks.length-1,st.wi+(+wk.dataset.wk)));render();return}
  const gw=e.target.closest('[data-gowk]');if(gw&&SCHED){const i=SCHED.weeks.findIndex(x=>x.key===gw.dataset.gowk);if(i<0){toast('Этой недели уже нет в базе.',true);return}
    st.wi=i;st.view='sched';closePreview();render();scrollTo({top:0});return}
  if(e.target.closest('[data-seenall]')){setSeen(PANEL_FRESH,true);return}
  const vg=e.target.closest('[data-view-go]');if(vg){st.view=vg.dataset.viewGo;if(vg.dataset.dtabGo) st.dtab=vg.dataset.dtabGo;closePropMenu();render();scrollTo({top:0});return}
  const pb=e.target.closest('[data-prow]');if(pb){if(!PMENU.hidden&&PMENU.dataset.row===pb.dataset.prow) closePropMenu();else openPropMenu(pb);return}
  const pfb=e.target.closest('[data-pf]');if(pfb){st.pf=pfb.dataset.pf&&st.pf!==pfb.dataset.pf?pfb.dataset.pf:null;render();return}
  const dt=e.target.closest('[data-dtab]');if(dt){st.dtab=dt.dataset.dtab;st.dq='';renderDict();save();return}
  const pm=e.target.closest('[data-pmove]');if(pm){movePropBy(pm.dataset.pid,+pm.dataset.pmove);return}
  const pd=e.target.closest('[data-pdel]');if(pd){
    if(pd.dataset.sure!=='1'){pd.dataset.sure='1';pd.textContent=+pd.dataset.n?`удалить и снять с ${pd.dataset.n} ${plural(+pd.dataset.n,'строки','строк','строк')}?`:'точно удалить?';setTimeout(()=>{if(pd.isConnected){pd.dataset.sure='';pd.textContent='удалить'}},4000);return}
    delProp(pd.dataset.pdel);if(st.pf===pd.dataset.pdel) st.pf=null;renderDict();return}
  const dw=e.target.closest('[data-delwk]');if(dw&&SCHED&&CAN_FLAG){
    if(dw.dataset.sure!=='1'){dw.dataset.sure='1';dw.textContent='точно удалить?';setTimeout(()=>{if(dw.isConnected){dw.dataset.sure='';dw.textContent='удалить'}},4000);return}
    const en=uploadSched('',[],[dw.dataset.delwk]);buildRegistry();zSyncLocal();render();toast('Расписание: '+uploadSummary(en)+(CLOUD?'. Нажмите «Опубликовать», чтобы удаление увидели все.':''));return}
  if(e.target.closest('[data-close]')) closePreview();
});
document.addEventListener('change',e=>{
  if(e.target.id==='onlyMis'){st.onlyMis=e.target.checked;render();return}
  if(e.target.id==='chOnly'){st.chOnly=e.target.checked;render();return}
  if(e.target.classList.contains('seen-cb')&&e.target.dataset.sk){setSeen([e.target.dataset.sk],e.target.checked);return}
  if(e.target.id==='zAll'){setFlags(ZROWS,e.target.checked);return}
  if(e.target.id==='donly'){st.donly=e.target.checked;fillDict();return}
  if(e.target.classList.contains('dshort')){setShort(st.dtab,e.target.dataset.dk,e.target.value);e.target.value=NAMES[st.dtab].get(e.target.dataset.dk)||'';e.target.closest('tr').classList.toggle('has',!!e.target.value);return}
  const pp=e.target.closest('[data-pid]');
  if(pp&&(pp.classList.contains('pname')||pp.classList.contains('pshort')||pp.classList.contains('pcolor'))){
    const p=PROPS.find(x=>x.id===pp.dataset.pid);if(!p) return;const n={...p};
    if(pp.classList.contains('pname')){const v=pp.value.replace(/\s+/g,' ').trim().slice(0,200);if(!v){pp.value=p.name;toast('У свойства должно быть название.',true);return}n.name=v}
    else if(pp.classList.contains('pshort')) n.short=pp.value.replace(/\s+/g,' ').trim().slice(0,40);
    else n.color=okColor(pp.value);
    if(n.name!==p.name||n.short!==p.short||n.color!==p.color){putProps([n]);renderDict()}
    return;
  }
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
/* как на экране: вся группа — во всю ширину, 1 п/г — левая колонка, 2 п/г — правая */
function pdfSlot(its,mode){
  const part=xs=>!xs.length?[]:mode==='group'?pdfGroupCell(xs):xs.map(c=>pdfLesson(c,mode,xs.length));
  const isH=c=>c.subgroup===1||c.subgroup===2;
  const a=its.filter(c=>c.subgroup===1),b=its.filter(c=>c.subgroup===2);
  const out=part(its.filter(c=>!isH(c)));
  if(a.length||b.length){
    const free=n=>({text:n+' п/г —',color:PC.rule,fontSize:6.3});
    out.push({columns:[{width:'*',stack:a.length?part(a):[free(1)]},{width:'*',stack:b.length?part(b):[free(2)]}],columnGap:4});
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
      row.push(its.length?{stack:pdfSlot(its,mode),fillColor:its.some(c=>c.zach)?PC.zf:(its.every(c=>c.subgroup)?PC.sub:PC.fill)}:{text:''});
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
function pdfCreditPage(g,items,brk,period,first,last){
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
  const out=[{text:'Зачёты группы '+g,style:'h',pageBreak:brk&&!first?'before':undefined,margin:!brk&&!first?[0,16,0,0]:undefined},
    {text:course+(pg?pg.students+' студентов · ':'')+items.length+' '+plural(items.length,'зачётная пара','зачётные пары','зачётных пар')+' '+(period||'за семестр'),style:'s'},
    {table:{headerRows:1,dontBreakRows:true,widths:[14,'*',44,92,34,104,62],body},layout:LAY,fontSize:8.5}];
  let note='Неделя — последняя неделя с парами по недельному плану; день, пара и аудитория — по загруженному расписанию.';
  if(guessed) note+=` Даты недель без расписания рассчитаны от недели ${guessed.week} (${guessed.start.replace(/-/g,'.')}) по 7 дней.`;
  if(brk||last) out.push({text:note,style:'note'});
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
const fname=s=>s.replace(/[\\/:*?"<>|]/g,'-');
const wkName=w=>w.week?String(w.week):fmtRange(w);
/* подпись набора недель: «неделя 3», «недели 3–5», «недели 3, 5, 8» */
function wksTitle(ws){
  const n=ws.map(w=>w.week);
  if(ws.length===1) return 'неделя '+wkName(ws[0]);
  if(n.every(Boolean)&&n.every((x,i)=>!i||x===n[i-1]+1)) return 'недели '+n[0]+'–'+n[n.length-1];
  return 'недели '+ws.map(wkName).join(', ');
}
/* несколько файлов подряд: браузер может один раз спросить разрешение на множественную загрузку */
async function savePdfs(files){
  for(let i=0;i<files.length;i++){
    if(i) await new Promise(r=>setTimeout(r,450));
    await savePdf(files[i][0],files[i][1]);
  }
  if(files.length>1) toast(`Сохранено ${files.length} ${plural(files.length,'PDF-файл','PDF-файла','PDF-файлов')}`);
}
async function makePdf(kind){
  if(kind==='one'||kind==='all'){
    if(!W()) return toast('Сначала откройте файл расписания (.json).',true);
    const key=st.key[st.mode];
    if(kind==='one'&&(key==null||key==='*')) return toast('Выберите группу, преподавателя или аудиторию.',true);
    return openSchedDlg(kind);
  }
  if(!PLAN) return toast('Для зачётов нужен недельный план (.txt).',true);
  openCreditDlg();
}

/* ---------- Печать расписания: текущая или выбранные недели, один файл или по файлу на неделю ---------- */
const SD={kind:'one',mode:'group',key:null,pick:new Set()};
/* страницы одной недели; пустой массив — в эту неделю печатать нечего */
function schedWeekContent(w,brk){
  if(SD.kind==='one') return schedRecs(SD.mode,SD.key,w).length?pdfWeekPage(SD.mode,SD.key,w,brk):[];
  const gs=sortedGroups([...new Set(w.recs.map(r=>r.group))]);
  return gs.flatMap((g,i)=>pdfWeekPage('group',g,w,brk||i>0));
}
function schedSel(){
  const wm=$('input[name=sw]:checked').value;
  const ws=wm==='cur'?[W()].filter(Boolean):SCHED.weeks.filter(w=>SD.pick.has(w.key));
  const sep=ws.length>1&&$('input[name=sfile]:checked').value==='sep';
  return {ws,sep};
}
function schedHas(w){return SD.kind==='one'?schedRecs(SD.mode,SD.key,w).length>0:w.recs.length>0}
function schedDlgSum(){
  const wm=$('input[name=sw]:checked').value;$('#sdWeeks').classList.toggle('off',wm!=='pick');
  const {ws,sep}=schedSel();const ok=ws.filter(schedHas);
  $('#sdFiles').classList.toggle('off',ws.length<2);$('#sdFiles').querySelectorAll('input').forEach(x=>x.disabled=ws.length<2);
  let t;
  if(!ws.length) t='Выберите хотя бы одну неделю.';
  else if(!ok.length) t=SD.kind==='one'?'В выбранные недели занятий нет.':'В выбранных неделях нет занятий.';
  else{
    const files=sep?ok.length:1;
    t=`Будет выведено: ${ok.length} ${plural(ok.length,'неделя','недели','недель')} · ${files} ${plural(files,'файл','файла','файлов')}`;
    if(ok.length<ws.length) t+=` · без занятий пропущено: ${ws.filter(w=>!schedHas(w)).map(wkName).join(', ')}`;
  }
  $('#sdSum').textContent=t;$('#sdGo').disabled=!ok.length;
}
function openSchedDlg(kind){
  SD.kind=kind;SD.mode=kind==='one'?st.mode:'group';SD.key=kind==='one'?st.key[st.mode]:null;
  const cw=W();
  $('#sdTitle').textContent=kind==='one'?entTitle(SD.mode,SD.key):'Расписание всех групп';
  $('#sdCurLabel').textContent='Текущая неделя ('+wkName(cw)+(cw.week&&fmtRange(cw)?', '+fmtRange(cw):'')+')';
  const keys=new Set(SCHED.weeks.map(w=>w.key));SD.pick=new Set([...SD.pick].filter(k=>keys.has(k)));
  if(!SD.pick.size) SD.pick.add(cw.key);
  $('#sdWeeks').innerHTML=SCHED.weeks.map(w=>{const has=schedHas(w);
    return `<label title="${esc(fmtRange(w))}"${has?'':' class="empty"'}><input type="checkbox" data-sw="${esc(w.key)}"${SD.pick.has(w.key)?' checked':''}> ${esc(wkName(w))}${w.week&&fmtRange(w)?` <small>${esc(fmtRange(w))}</small>`:''}${has?'':' <small>(пусто)</small>'}</label>`}).join('');
  schedDlgSum();
  $('#sdlg').hidden=false;document.body.classList.add('modal-open');$('#sdGo').focus();
}
function closeSchedDlg(){$('#sdlg').hidden=true;if($('#modal').hidden&&$('#zdlg').hidden) document.body.classList.remove('modal-open')}
$('#sdlg').addEventListener('change',e=>{
  const k=e.target.dataset.sw;if(k!=null){e.target.checked?SD.pick.add(k):SD.pick.delete(k);$('input[name=sw][value=pick]').checked=true}
  schedDlgSum();
});
$('#sdlg').addEventListener('click',e=>{
  if(e.target.closest('[data-sclose]')) return closeSchedDlg();
  const all=e.target.closest('#sdAll'),none=e.target.closest('#sdNone');
  if(all||none){e.preventDefault();SD.pick=new Set(all?SCHED.weeks.filter(schedHas).map(w=>w.key):[]);
    $('#sdWeeks').querySelectorAll('[data-sw]').forEach(x=>x.checked=SD.pick.has(x.dataset.sw));
    $('input[name=sw][value=pick]').checked=true;schedDlgSum()}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#sdlg').hidden) closeSchedDlg()});
$('#sdGo').addEventListener('click',async()=>{
  const {ws,sep}=schedSel();const ok=ws.filter(schedHas);if(!ok.length) return;
  const base=SD.kind==='one'?entTitle(SD.mode,SD.key):'Расписание всех групп';
  closeSchedDlg();const btn=$('#pdfBtn');btn.disabled=true;btn.textContent='Готовлю PDF…';
  try{
    const files=sep?ok.map(w=>[baseDoc(true,schedWeekContent(w,false)),fname(`${base}, неделя ${wkName(w)}.pdf`)])
      :[[baseDoc(true,ok.flatMap((w,i)=>schedWeekContent(w,i>0))),fname(`${base}, ${wksTitle(ok)}.pdf`)]];
    await savePdfs(files);
  }catch(err){toast(err&&err.message||'Не удалось сформировать PDF.',true)}
  finally{btn.disabled=false;btn.textContent='PDF ▾'}
});

/* ---------- Печать зачётов: выбор групп и недель ---------- */
const ZD={pick:new Set()};
function creditAll(){return sortedGroups([...FLAGS.keys()].filter(g=>planGroup(g))).map(g=>[g,creditItems(g)]).filter(x=>x[1].length)}
const wkList=ws=>ws.length===1?'неделя '+ws[0]:'недели '+ws.join(', ');
function creditSel(){
  const all=ZD.all||[];const gm=$('input[name=zg]:checked').value,wm=$('input[name=zw]:checked').value;
  const cw=W()&&W().week;
  const weeks=wm==='sem'?null:wm==='cur'?(cw?[cw]:[]):[...ZD.pick].sort((a,b)=>a-b);
  let pages=gm==='one'?all.filter(([g])=>g===$('#zdGroup').value):all;
  if(weeks) pages=pages.map(([g,its])=>[g,its.filter(it=>weeks.includes(it.week))]).filter(x=>x[1].length);
  /* несколько недель: весь семестр или выбрано больше одной */
  const multi=!weeks||weeks.length>1;
  const sep=multi&&$('input[name=zfile]:checked').value==='sep';
  return {pages,weeks,gm,sep};
}
/* недели, которые реально попадут в выборку, по возрастанию */
const creditWeeks=pages=>[...new Set(pages.flatMap(([,its])=>its.map(it=>it.week)))].sort((a,b)=>a-b);
function creditDlgSum(){
  const wm=$('input[name=zw]:checked').value;$('#zdWeeks').classList.toggle('off',wm!=='pick');
  $('#zdGroup').disabled=$('input[name=zg]:checked').value!=='one';
  const {pages,weeks,sep}=creditSel();const n=pages.reduce((a,[,its])=>a+its.length,0);
  const multi=!weeks||weeks.length>1;
  $('#zdFiles').classList.toggle('off',!multi);$('#zdFiles').querySelectorAll('input').forEach(x=>x.disabled=!multi);
  const files=sep?creditWeeks(pages).length:1;
  $('#zdSum').textContent=weeks&&!weeks.length?'Выберите хотя бы одну неделю.':n?`Будет выведено: ${n} ${plural(n,'зачёт','зачёта','зачётов')} · ${pages.length} ${plural(pages.length,'группа','группы','групп')} · ${files} ${plural(files,'файл','файла','файлов')}`:'Под выбранные условия зачётов нет.';
  $('#zdGo').disabled=!n;
}
function openCreditDlg(){
  ZD.all=creditAll();
  if(!ZD.all.length) return toast('Нет отмеченных зачётных дисциплин: поставьте флажки в недельном плане.',true);
  const gs=ZD.all.map(x=>x[0]),cur=st.mode==='group'&&gs.includes(st.key.group)?st.key.group:gs[0];
  $('#zdGroup').innerHTML=gs.map(g=>`<option${g===cur?' selected':''}>${esc(g)}</option>`).join('');
  const cnt=new Map();ZD.all.forEach(([,its])=>its.forEach(it=>cnt.set(it.week,(cnt.get(it.week)||0)+1)));
  const ws=[...cnt.keys()].sort((a,b)=>a-b);ZD.pick=new Set([...ZD.pick].filter(w=>cnt.has(w)));
  $('#zdWeeks').innerHTML=ws.map(w=>`<label><input type="checkbox" data-zw="${w}"${ZD.pick.has(w)?' checked':''}> ${w} <small>(${cnt.get(w)})</small></label>`).join('');
  const cw=W()&&W().week;const curR=$('input[name=zw][value=cur]');
  curR.disabled=!cw;$('#zdCurLabel').textContent=cw?'Текущая неделя ('+cw+')':'Текущая неделя (нет расписания)';
  if(curR.disabled&&curR.checked) $('input[name=zw][value=sem]').checked=true;
  creditDlgSum();
  $('#zdlg').hidden=false;document.body.classList.add('modal-open');$('#zdGo').focus();
}
function closeCreditDlg(){$('#zdlg').hidden=true;if($('#modal').hidden&&$('#sdlg').hidden) document.body.classList.remove('modal-open')}
$('#zdlg').addEventListener('change',e=>{
  const w=e.target.dataset.zw;if(w){e.target.checked?ZD.pick.add(+w):ZD.pick.delete(+w);$('input[name=zw][value=pick]').checked=true}
  if(e.target.name==='zg') $('#zdBreak').checked=e.target.value==='all'&&$('input[name=zw]:checked').value==='sem';
  if(e.target.name==='zw') $('#zdBreak').checked=$('input[name=zg]:checked').value==='all'&&e.target.value==='sem';
  creditDlgSum();
});
$('#zdlg').addEventListener('click',e=>{if(e.target.closest('[data-zclose]')) closeCreditDlg()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#zdlg').hidden) closeCreditDlg()});
$('#zdGo').addEventListener('click',async()=>{
  const {pages,weeks,gm,sep}=creditSel();if(!pages.length) return;
  const brk=$('#zdBreak').checked,who=gm==='one'?pages[0][0]:'все группы';
  const doc=(pp,period)=>baseDoc(false,pp.flatMap(([g,its],i)=>pdfCreditPage(g,its,brk,period,i===0,i===pp.length-1)));
  closeCreditDlg();const btn=$('#pdfBtn');btn.disabled=true;btn.textContent='Готовлю PDF…';
  try{
    const files=sep?creditWeeks(pages).map(wk=>{
        const pp=pages.map(([g,its])=>[g,its.filter(it=>it.week===wk)]).filter(x=>x[1].length);
        return [doc(pp,'· '+wkList([wk])),fname(`Зачёты — ${who} — ${wkList([wk])}.pdf`)]})
      :[[doc(pages,weeks?'· '+wkList(weeks):'за семестр'),fname(`Зачёты — ${who} — ${weeks?wkList(weeks):'семестр'}.pdf`)]];
    await savePdfs(files);
  }catch(err){toast(err&&err.message||'Не удалось сформировать PDF.',true)}
  finally{btn.disabled=false;btn.textContent='PDF ▾'}
});
function updatePdfMenu(){
  const w=W(),key=st.key[st.mode];
  const one=$('#pdf-one'),all=$('#pdf-all'),z=$('#pdf-zach');
  $('#pdfOneLabel').textContent=(key&&key!=='*'?entTitle(st.mode,key):'Открытое расписание')+'…';
  $('#pdfOneSub').textContent=w?'текущая неделя ('+wkName(w)+') или выбрать недели':'нужен файл расписания';
  $('#pdfAllSub').textContent=w?'каждая группа на отдельной странице, недели на выбор':'нужен файл расписания';
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
    const hist=(uploads||[]).map(u=>({id:u.id,at:u.at,author:u.author||'',file:u.file||'',weeks:(u.summary&&u.summary.weeks)||[],ch:(u.summary&&u.summary.ch)||{},kind:(u.summary&&u.summary.kind)||'',z:(u.summary&&u.summary.z)||[]}));
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
  // первая загрузка из schedPending() записана в базу — убрать её из очереди
  schedSent(){
    if(!SCHED) return;
    if(SCHED.legacy){SCHED.legacy=false;SCHED.legacyStore=null}
    else SCHED.pending.shift();
  },
  computeUpload,
  setFlags(rows){FLAGS=new Map();for(const r of rows){let s=FLAGS.get(r.grp);if(!s){s=new Set();FLAGS.set(r.grp,s)}s.add(r.code)}FVER++},
  setCanFlag(v){CAN_FLAG=!!v},
  setViewOnly(v){VIEW_ONLY=!!v},
  // отметки «просмотрено» текущего пользователя: [{upload_id, ckey}]; can — можно ли отмечать
  setSeen(rows,can){SEEN=new Set((rows||[]).map(r=>r.upload_id+'|'+r.ckey));CAN_SEEN=!!can;CHMEMO.clear()},
  zachetPos,zachetMoves,
  // Словари из таблиц dict_names / props / row_props
  setDict,
  refresh(){buildRegistry();closePreview();render()},
};
if(!CLOUD){
  try{const t=$('#samplePlan').textContent;if(t.trim()) ingest(t,'plany.txt',true)}catch(e){}
  // база расписания, накопленная в этом браузере, иначе — встроенный пример
  let saved=null;try{saved=localStorage.getItem(SKEY_SCHED)}catch(e){}
  if(saved){try{ingest(saved,'',false,{})}catch(e){saved=null}}
  if(!saved){try{const t=$('#sampleSched').textContent;if(t.trim()) ingest(t,'1 семестр — 2 неделя.json',true)}catch(e){}}
  loadLocalFlags();loadLocalDict();loadLocalSeen();buildRegistry();zSyncLocal();
}
buildRegistry();render();
})();
