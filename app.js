/* HAIR 병동 행동 관찰 코딩 앱 (PWA) · v1.0 · 2026-08-14
   단일 연속 코딩(S2) — 관찰자는 4-상태(LIE/SIT/STD/WLK)만 태핑, 전환·bed-exit 자동 도출.
   시각동기: HTTP /time(옵션) + 단조앵커(performance.now) → t_server/t_device/clock_offset_ms/sync_flag.
   저장: IndexedDB(오프라인·재실행 보존). 결합: 서버 3-way(행동×알람×판정), 무 PII. */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};

/* ───────── 어휘 (코딩시트 목록과 정합) ───────── */
var STATES=[{c:'LIE',k:'누움'},{c:'SIT',k:'앉음'},{c:'STD',k:'일어섬'},{c:'WLK',k:'걸음'}];
var CTX=[{c:'none',k:'관찰 중'},{c:'toilet',k:'화장실'},{c:'procedure',k:'처치중'},{c:'off_view',k:'시야이탈'},{c:'off_ward',k:'병동밖'}];
var MOT=[{c:'tremor',k:'떨림'},{c:'brush_repeat',k:'반복상지'},{c:'scratch',k:'긁기'},{c:'eat',k:'식사'},{c:'turn',k:'뒤척임'},{c:'care',k:'처치받음'},{c:'other',k:'기타'}];
var POST={LIE:1,SIT:1,STD:1};                                  // 전환코드는 LIE/SIT/STD 삼각만
function transCode(from,to){ return (POST[from]&&POST[to]) ? (from+'→'+to) : to; } // WLK 끼면 도착코드
/* ModeA 17컬럼(코딩시트 스키마 동일 순서) + 시각동기 5컬럼(결합키) */
var HEAD_CORE=['record_id','observer_id','patient_id','date','time_start','time_end','code','is_bed_exit',
  'context','in_bed_move','sensor_status','uncertain','duration_sec','note','enroll_date','set_assign','motion_detail'];
var HEAD_TIME=['t_server_start','t_server_end','clock_offset_ms','sync_flag','session_id','device_serial'];
var HEAD=HEAD_CORE.concat(HEAD_TIME);

/* ───────── 시각동기 모듈 (단조앵커 + Cristian) ───────── */
var Clock={
  offsetMs:0, flag:'DEVICE', rtt:null, endpoint:'', lastSync:0,
  anchorMono:0, anchorServer:0,     // t_server = anchorServer + (performance.now()-anchorMono)
  reAnchor:function(){ this.anchorMono=performance.now(); this.anchorServer=Date.now()+this.offsetMs; },
  now:function(){ return Math.round(this.anchorServer + (performance.now()-this.anchorMono)); }, // 서버기준 ms(단조)
  deviceNow:function(){ return Date.now(); },
  sync:function(){
    var self=this;
    if(!self.endpoint){ self.offsetMs=0; self.flag='DEVICE'; self.rtt=null; self.reAnchor(); self.lastSync=Date.now(); paintSync(); return Promise.resolve(); }
    var t0=Date.now();
    return fetch(self.endpoint,{cache:'no-store',mode:'cors'}).then(function(res){
      var t1=Date.now();
      return res.json().catch(function(){return null;}).then(function(j){
        var srv=null;
        if(j){ srv=+(j.now||j.epoch_ms||j.server_time||j.t||0)||null; }
        if(!srv){ var d=res.headers.get('Date'); srv=d?Date.parse(d):null; }
        if(!srv){ throw new Error('no server time'); }
        var rtt=t1-t0;
        self.rtt=rtt;
        self.offsetMs=Math.round((srv+rtt/2)-Date.now());
        self.flag='OK'; self.reAnchor(); self.lastSync=Date.now(); paintSync();
      });
    }).catch(function(){ self.flag='FAIL'; self.lastSync=Date.now(); paintSync(); });
  }
};
function paintSync(){
  var el=$('sync'); if(!el) return;
  el.classList.remove('device','fail');
  var txt='서버동기';
  if(Clock.flag==='DEVICE'){ el.classList.add('device'); txt='기기시계'; }
  else if(Clock.flag==='FAIL'){ el.classList.add('fail'); txt='동기실패'; }
  $('synctxt').textContent=txt;
  var info=(Clock.flag==='OK'?('OK · offset '+Clock.offsetMs+' ms · rtt '+Clock.rtt+' ms')
          :Clock.flag==='DEVICE'?'기기 시계 사용(오프셋 0) — 외부망 NTP 자동동기 가정'
          :'동기 실패 — 직전 오프셋 '+Clock.offsetMs+' ms 유지, 기록은 flag=FAIL');
  var ci=$('cfgSyncInfo'); if(ci) ci.textContent=info;
  var ss=$('startSync'); if(ss) ss.textContent=(Clock.flag==='OK'?'서버동기 OK ('+Clock.offsetMs+' ms)':Clock.flag==='DEVICE'?'기기시계(외부망 NTP)':'동기 실패');
}

/* ───────── IndexedDB (초경량 KV) ───────── */
var DB=null;
function idbOpen(){
  return new Promise(function(res,rej){
    var r=indexedDB.open('hair_observer',1);
    r.onupgradeneeded=function(e){ var db=e.target.result;
      if(!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions',{keyPath:'id'});
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'k'});
    };
    r.onsuccess=function(){ DB=r.result; res(DB); };
    r.onerror=function(){ rej(r.error); };
  });
}
function idbPut(store,val){ return new Promise(function(res,rej){ var tx=DB.transaction(store,'readwrite'); tx.objectStore(store).put(val); tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }
function idbGet(store,key){ return new Promise(function(res,rej){ var tx=DB.transaction(store,'readonly'); var rq=tx.objectStore(store).get(key); rq.onsuccess=function(){res(rq.result);}; rq.onerror=function(){rej(rq.error);}; }); }
function idbAll(store){ return new Promise(function(res,rej){ var tx=DB.transaction(store,'readonly'); var rq=tx.objectStore(store).getAll(); rq.onsuccess=function(){res(rq.result||[]);}; rq.onerror=function(){rej(rq.error);}; }); }
function idbDel(store,key){ return new Promise(function(res,rej){ var tx=DB.transaction(store,'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }
function idbClear(store){ return new Promise(function(res,rej){ var tx=DB.transaction(store,'readwrite'); tx.objectStore(store).clear(); tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }

/* ───────── 설정 ───────── */
var CFG={endpoint:'',obs:'',set:'',theme:'system'};
function applyTheme(){ var t=CFG.theme; if(t==='system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme',t); }
function loadCfg(){ return idbGet('meta','cfg').then(function(v){ if(v&&v.val) CFG=Object.assign(CFG,v.val); Clock.endpoint=CFG.endpoint||''; applyTheme(); }); }
function saveCfg(){ return idbPut('meta',{k:'cfg',val:CFG}); }

/* ───────── 세션 상태 ───────── */
var S=null;   // 현재 활성 세션(메모리) — 변경마다 IndexedDB 저장
function newSession(meta){
  var ts=Clock.now();
  return {
    id:'S'+Date.now()+'-'+Math.floor(performance.now()),
    obs:meta.obs, pid:meta.pid, set:meta.set||'', enroll:meta.enroll||'', serial:meta.serial||'', sessNote:meta.note||'',
    createdDevice:Date.now(),
    cur:(meta.start||'LIE'), ctx:'none', unc:false, sensor:'on', reminded:false, ended:false, endTs:null,
    sessionStart:ts, boutStart:ts, boutStartDev:Date.now(), boutEnter:(meta.start||'LIE'), boutIsBed:false,
    seq:0, bouts:[], ctxStart:ts, ctxBouts:[], motions:[], markers:[], log:[], undoCount:0, uncCount:0
  };
}
var _saveT=null;
function persist(){ if(!S) return; clearTimeout(_saveT); _saveT=setTimeout(function(){ if(S) idbPut('sessions',S); },250); }
function persistNow(){ if(S) return idbPut('sessions',S); return Promise.resolve(); }

/* ───────── 화면 전환 ───────── */
var SCREENS=['startScreen','codeScreen','summaryScreen','settingsScreen'];
function show(id){ SCREENS.forEach(function(s){ $(s).classList.toggle('hidden', s!==id); }); if($('scroll')) $('scroll').scrollTop=0; }

/* ───────── 유틸 ───────── */
function pad(n){return(n<10?'0':'')+n;}
function clock(ms){var d=new Date(ms);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());}
function dateStr(ms){var d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function stampSec(ms){var d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());}
function isoMs(ms){var d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+'.'+String(ms%1000+1000).slice(1);}
function koState(c){for(var i=0;i<STATES.length;i++)if(STATES[i].c===c)return STATES[i].k;return c;}
function koCtx(c){for(var i=0;i<CTX.length;i++)if(CTX[i].c===c)return CTX[i].k;return c;}
function fmtDur(s){s=Math.max(0,Math.round(s));if(s<60)return s+'s';var m=Math.floor(s/60);return m+'m '+pad(s%60)+'s';}
function memoVal(){return($('memo').value||'').trim();}
var LOCKED=function(){return S&&(S.ctx==='off_view'||S.ctx==='off_ward');};

/* ───────── 버튼 빌드 ───────── */
var sc,mc,cc;
function buildButtons(){
  sc=$('states'); sc.innerHTML='';
  STATES.forEach(function(s){var b=document.createElement('button');b.className='stbtn';b.type='button';b.dataset.c=s.c;
    b.innerHTML='<span class="ko">'+s.k+'</span><span class="en">'+s.c+'</span>';
    b.addEventListener('click',function(){tapState(s.c);}); sc.appendChild(b);});
  mc=$('motions'); mc.innerHTML='';
  MOT.forEach(function(m){var b=document.createElement('button');b.className='chip motion';b.type='button';b.dataset.c=m.c;b.textContent=m.k;
    b.addEventListener('click',function(){tapMotion(m,b);}); mc.appendChild(b);});
  cc=$('contexts'); cc.innerHTML='';
  CTX.forEach(function(x){var b=document.createElement('button');b.className='chip ctx';b.type='button';b.dataset.c=x.c;b.textContent=x.k;
    b.addEventListener('click',function(){tapContext(x);}); cc.appendChild(b);});
}

/* ───────── 코딩 동작 ───────── */
function tapState(c){
  if(!S||S.ended||LOCKED()||c===S.cur)return;
  var ts=Clock.now(), dev=Clock.deviceNow(), nt=memoVal();
  S.bouts.push({rid:'r'+(++S.seq),state:S.cur,enter:S.boutEnter,isBed:S.boutIsBed,start:S.boutStart,startDev:S.boutStartDev,
    end:ts,endDev:dev,dur:(ts-S.boutStart)/1000,ctx:S.ctx,unc:S.unc,note:nt,offset:Clock.offsetMs,flag:Clock.flag});
  var isBed=(S.cur==='LIE'&&(c==='SIT'||c==='STD'));
  S.log.push({t:clock(ts),kind:'transition',code:transCode(S.cur,c),bed:isBed,dur:(ts-S.boutStart)/1000,from:S.cur});
  S.cur=c; S.boutStart=ts; S.boutStartDev=dev; S.boutEnter=S.log[S.log.length-1].code; S.boutIsBed=isBed; S.reminded=false;
  if(nt)$('memo').value=''; persist(); render();
}
function tapMotion(m,b){
  if(!S||S.ended||LOCKED()||S.cur==='WLK')return;
  var ts=Clock.now(), ibm=(S.cur==='LIE'&&m.c==='turn'), nt=memoVal();
  S.motions.push({rid:'r'+(++S.seq),t:ts,tDev:Clock.deviceNow(),state:S.cur,code:m.c,ibm:ibm,unc:S.unc,note:nt,offset:Clock.offsetMs,flag:Clock.flag});
  S.log.push({t:clock(ts),kind:'motion',code:'motion:'+m.c+(ibm?' (in_bed_move=1)':''),bed:false});
  b.classList.add('on'); setTimeout(function(){b.classList.remove('on');},420);
  if(nt)$('memo').value=''; persist(); render();
}
function tapContext(x){
  if(!S||S.ended)return;
  var leaving=(x.c==='toilet'||x.c==='off_view'||x.c==='off_ward');
  if(leaving&&S.cur==='LIE'&&!S.reminded){ showToast(); S.reminded=true; }
  var newc=(x.c===S.ctx)?'none':x.c, ts=Clock.now();
  S.ctxBouts.push({ctx:S.ctx,start:S.ctxStart,end:ts,dur:(ts-S.ctxStart)/1000});
  S.ctx=newc; S.ctxStart=ts;
  S.log.push({t:clock(ts),kind:'context',code:'context='+newc,bed:false});
  persist(); render();
}
function tapSyncMarker(){
  if(!S||S.ended)return;
  var ts=Clock.now();
  S.markers.push({rid:'r'+(++S.seq),t:ts,tDev:Clock.deviceNow(),offset:Clock.offsetMs,flag:Clock.flag});
  S.log.push({t:clock(ts),kind:'marker',code:'⏱ sync_marker',bed:false});
  var b=$('markerBtn'); b.classList.add('flash'); setTimeout(function(){b.classList.remove('flash');},450);
  persist(); render();
}
function showToast(){var t=$('toast');t.classList.add('show');clearTimeout(showToast._h);showToast._h=setTimeout(function(){t.classList.remove('show');},6000);}
function doUndo(){
  if(!S||S.ended||!S.log.length)return;
  var e=S.log.pop(); S.undoCount++;
  if(e.kind==='transition'){ var b=S.bouts.pop(); if(b){S.cur=b.state;S.boutStart=b.start;S.boutStartDev=b.startDev;S.boutEnter=b.enter;S.boutIsBed=b.isBed;} }
  else if(e.kind==='motion'){ S.motions.pop(); }
  else if(e.kind==='marker'){ S.markers.pop(); }
  else if(e.kind==='context'){ var cb=S.ctxBouts.pop(); if(cb){S.ctx=cb.ctx;S.ctxStart=cb.start;} }
  persist(); render();
}

/* ───────── 렌더 ───────── */
function render(){
  if(!S)return;
  var openDur=(Clock.now()-S.boutStart)/1000;
  $('pidlbl').textContent='👤 '+S.pid+(S.set?(' · '+S.set):'');
  $('cur').innerHTML=koState(S.cur)+' <b>('+S.cur+')</b>'+(S.boutIsBed?'<span class="be">★ bed-exit</span>':'');
  $('held').innerHTML=fmtDur(openDur);
  Array.prototype.forEach.call(sc.children,function(b){ b.classList.toggle('on',b.dataset.c===S.cur); b.disabled=LOCKED()||S.ended; });
  Array.prototype.forEach.call(mc.children,function(b){ b.classList.toggle('disabled',LOCKED()||S.cur==='WLK'||S.ended); });
  Array.prototype.forEach.call(cc.children,function(b){ var a=b.dataset.c===S.ctx; b.classList.toggle('on',a&&b.dataset.c!=='none'); b.classList.toggle('onnone',a&&b.dataset.c==='none'); });
  var cb=$('ctxbanner'),lb=$('lockbanner'); cb.className='banner'; lb.className='banner';
  if(S.ctx!=='none'){ cb.className='banner ctx'; cb.textContent='⚠ 맥락: '+koCtx(S.ctx)+' — 관찰 복귀를 상기'; }
  if(LOCKED()){ lb.className='banner lock'; lb.textContent='🔒 미관찰(상태 입력 잠금) — 관찰 복귀 시 자동 해제'; }
  $('unc').classList.toggle('on',S.unc);
  $('sensor').textContent=S.sensor; $('sensorbtn').classList.toggle('senson',S.sensor==='on'); $('sensorbtn').classList.toggle('senswarn',S.sensor!=='on');
  $('memo').classList.toggle('req',S.unc&&!$('memo').value.trim());
  var mcEl=$('mcount'); if(mcEl) mcEl.textContent=(S.markers||[]).length;
  var ul=$('events');
  if(!S.log.length){ ul.innerHTML='<li class="empty">아직 기록 없음 — 상태 버튼을 눌러보세요</li>'; }
  else{ ul.innerHTML='';
    S.log.slice(-40).forEach(function(e){ var li=document.createElement('li');
      var dtxt=(e.kind==='transition')?('<span class="d">'+koState(e.from)+' '+fmtDur(e.dur)+'</span>'):'';
      li.innerHTML='<span class="t">'+e.t+'</span><span class="c'+(e.bed?' bd':'')+'">'+(e.bed?'★ ':'')+e.code+'</span>'+dtxt;
      ul.appendChild(li); });
    ul.scrollTop=ul.scrollHeight;
  }
}

/* ───────── CSV ───────── */
function boutRows(sess,nowTs){
  var rows=sess.bouts.slice();
  if(!sess.ended){ rows=rows.concat([{rid:'r'+((sess.seq||0)+1),state:sess.cur,enter:sess.boutEnter,isBed:sess.boutIsBed,start:sess.boutStart,startDev:sess.boutStartDev,
    end:nowTs,endDev:Clock.deviceNow(),dur:(nowTs-sess.boutStart)/1000,ctx:sess.ctx,unc:sess.unc,note:'',offset:Clock.offsetMs,flag:Clock.flag,open:true}]); }
  return rows;
}
function csvEscape(v){v=String(v==null?'':v);return /[",\n]/.test(v)?('"'+v.replace(/"/g,'""')+'"'):v;}
function sessRows(sess,includeHead,nowTs){
  var out=includeHead?[HEAD.slice()]:[], n=1;
  boutRows(sess,nowTs).forEach(function(b){
    out.push([b.rid||('r'+(n++)),sess.obs,sess.pid,dateStr(b.start),clock(b.start),b.open?'(진행중)':clock(b.end),
      b.enter,b.isBed?1:0,b.ctx,0,sess.sensor,b.unc?1:0,b.dur.toFixed(1),b.note||'',sess.enroll,sess.set||'','',
      isoMs(b.start),b.open?'':isoMs(b.end),(b.offset==null?'':b.offset),b.flag||'',sess.id,sess.serial||'']);
  });
  sess.motions.forEach(function(m){
    out.push([m.rid||('r'+(n++)),sess.obs,sess.pid,dateStr(m.t),clock(m.t),clock(m.t),
      'motion',0,'',m.ibm?1:0,sess.sensor,m.unc?1:0,'0.0',m.note||'',sess.enroll,sess.set||'',m.code,
      isoMs(m.t),isoMs(m.t),(m.offset==null?'':m.offset),m.flag||'',sess.id,sess.serial||'']);
  });
  (sess.markers||[]).forEach(function(k){
    out.push([k.rid||('r'+(n++)),sess.obs,sess.pid,dateStr(k.t),clock(k.t),clock(k.t),
      'sync_marker',0,'',0,sess.sensor,0,'0.0','',sess.enroll,sess.set||'','',
      isoMs(k.t),isoMs(k.t),(k.offset==null?'':k.offset),k.flag||'',sess.id,sess.serial||'']);
  });
  return out;
}
function matrixToCsv(rows){ return '﻿'+rows.map(function(r){return r.map(csvEscape).join(',');}).join('\r\n'); }
function download(name,text){ var blob=new Blob([text],{type:'text/csv;charset=utf-8'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1500); }

/* ───────── 세션 요약 ───────── */
function endSession(){
  if(!S||S.ended)return;
  var ts=Clock.now();
  S.bouts.push({rid:'r'+(++S.seq),state:S.cur,enter:S.boutEnter,isBed:S.boutIsBed,start:S.boutStart,startDev:S.boutStartDev,
    end:ts,endDev:Clock.deviceNow(),dur:(ts-S.boutStart)/1000,ctx:S.ctx,unc:S.unc,note:memoVal(),offset:Clock.offsetMs,flag:Clock.flag});
  S.ctxBouts.push({ctx:S.ctx,start:S.ctxStart,end:ts,dur:(ts-S.ctxStart)/1000});
  S.ended=true; S.endTs=ts; persistNow(); buildSummary(S,ts); show('summaryScreen');
}
function kpi(v,a,l){ if(l===undefined){l=a;a='';} return '<div class="kpi '+a+'"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>'; }
function buildSummary(sess,endTs){
  var total=(endTs-sess.sessionStart)/1000, byState={LIE:0,SIT:0,STD:0,WLK:0}, bed=0, trans=0;
  sess.bouts.forEach(function(b){byState[b.state]=(byState[b.state]||0)+b.dur; if(b.isBed)bed++; if((''+b.enter).indexOf('→')>=0)trans++;});
  var off=0;
  sess.ctxBouts.forEach(function(cb){ if(cb.ctx==='off_view'||cb.ctx==='off_ward')off+=cb.dur; });
  var valid=Math.max(0,total-off), cov=total>0?valid/total*100:100;
  $('ssub').textContent='근무 종료 '+clock(endTs)+' · '+sess.pid+' · 자동 집계 (동기 '+sess_flag(sess)+')';
  $('kpis').innerHTML=
    kpi(fmtDur(total),'총 관찰시간')+
    kpi(cov.toFixed(0)+'%',(off>0?'warn':'good'),'유효 커버리지 (유효 '+fmtDur(valid)+')')+
    kpi(String(bed),(bed>0?'good':''),'목격 bed-exit')+
    kpi(String(trans),'','상태 전환 수')+
    kpi(fmtDur(off),(off>0?'warn':''),'미관찰 off_view/ward')+
    kpi(String(sess.motions.length),'','움직임 태그')+
    kpi(String((sess.markers||[]).length),((sess.markers||[]).length>0?'good':''),'⏱ 동기마커(#8)')+
    kpi(String(sess.uncCount),(sess.uncCount>0?'alert':''),'불확실 횟수')+
    kpi(String(sess.undoCount),'','실행취소');
  var maxv=Math.max(1,byState.LIE,byState.SIT,byState.STD,byState.WLK);
  var rows='<tr><th>상태</th><th>duration_sec 합</th><th>비율</th></tr>';
  ['LIE','SIT','STD','WLK'].forEach(function(st){ var v=byState[st]||0, pct=total>0?v/total*100:0;
    rows+='<tr><td><b>'+koState(st)+'</b> <span style="color:var(--muted)">('+st+')</span></td><td class="n">'+v.toFixed(1)+' s</td>'+
      '<td><span class="bar" style="width:'+(v/maxv*80)+'px"></span> '+pct.toFixed(0)+'%</td></tr>'; });
  $('stbl').innerHTML='<caption style="text-align:left;font-size:10.5px;color:var(--muted);font-weight:700;padding-bottom:4px">상태별 체류시간 (duration_sec 합)</caption>'+rows;
}
function sess_flag(sess){ var f={}; sess.bouts.forEach(function(b){if(b.flag)f[b.flag]=1;}); var ks=Object.keys(f); return ks.length?ks.join('/'):'—'; }

/* ───────── 지난 세션 목록 ───────── */
function refreshList(){
  return idbAll('sessions').then(function(list){
    list.sort(function(a,b){return b.createdDevice-a.createdDevice;});
    $('sessCount').textContent=list.length?('('+list.length+')'):'';
    var ul=$('sesslist');
    if(!list.length){ ul.innerHTML='<li class="empty" style="color:var(--muted);padding:8px 0">아직 저장된 세션이 없습니다.</li>'; return; }
    ul.innerHTML='';
    list.forEach(function(s){
      var li=document.createElement('li');
      var dur=s.ended&&s.endTs?fmtDur((s.endTs-s.sessionStart)/1000):'진행중';
      var pill=s.ended?'<span class="pill done">종료</span>':'<span class="pill open">진행중</span>';
      li.innerHTML='<div class="meta"><div class="m1">'+esc(s.pid)+pill+'</div>'+
        '<div class="m2">'+esc(s.obs)+(s.set?(' · '+esc(s.set)):'')+' · '+dateStr(s.createdDevice)+' '+clock(s.createdDevice)+' · '+dur+'</div></div>';
      var open=document.createElement('button'); open.className='sbtn'; open.textContent=s.ended?'CSV':'이어하기';
      open.addEventListener('click',function(){ if(s.ended){ download('HAIR_'+s.pid+'_'+s.id+'.csv', matrixToCsv(sessRows(s,true,s.endTs))); } else { resumeSession(s); } });
      li.appendChild(open); ul.appendChild(li);
    });
  });
}
function esc(t){return String(t==null?'':t).replace(/[<>&]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;'}[c];});}

/* ───────── 세션 시작/재개 ───────── */
function startSession(){
  var obs=($('s_obs').value||'').trim(), pid=($('s_pid').value||'').trim();
  if(!obs){ alert('관찰자 ID를 입력하세요.'); $('s_obs').focus(); return; }
  if(!pid){ alert('환자 익명 ID(measurement_code)를 입력하세요.'); $('s_pid').focus(); return; }
  var startState=($('s_start')&&$('s_start').value)||'LIE';
  var enroll=stampSec(Clock.now());                 // 관찰 시작 누른 시각 자동 저장
  S=newSession({obs:obs,pid:pid,set:($('s_set').value||'').trim(),enroll:enroll,serial:($('s_serial').value||'').trim(),start:startState});
  CFG.obs=obs; CFG.set=($('s_set').value||'').trim(); saveCfg();
  persistNow().then(function(){ show('codeScreen'); render(); });
}
function resumeSession(sess){
  S=sess; S.ended=false; var ts=Clock.now();
  S.boutStart=ts; S.boutStartDev=Clock.deviceNow(); S.boutEnter=S.cur; S.boutIsBed=false; S.ctxStart=ts;
  persistNow().then(function(){ show('codeScreen'); render(); });
}

/* ───────── 설정 화면 ───────── */
function openSettings(){
  $('cfg_time').value=CFG.endpoint||''; $('cfg_obs').value=CFG.obs||''; $('cfg_set').value=CFG.set||''; $('cfg_theme').value=CFG.theme||'system';
  paintSync(); show('settingsScreen');
}
function commitCfg(){
  CFG.endpoint=($('cfg_time').value||'').trim(); CFG.obs=($('cfg_obs').value||'').trim();
  CFG.set=($('cfg_set').value||'').trim(); CFG.theme=$('cfg_theme').value;
  Clock.endpoint=CFG.endpoint; applyTheme();
  saveCfg().then(function(){ return Clock.sync(); }).then(backFromSettings);
}
function backFromSettings(){ if(S&&!S.ended){ show('codeScreen'); render(); } else { $('s_obs').value=CFG.obs||''; $('s_set').value=CFG.set||''; show('startScreen'); refreshList(); } }

/* ───────── 이벤트 바인딩 ───────── */
function bind(){
  $('startBtn').addEventListener('click',startSession);
  $('endbtn').addEventListener('click',endSession);
  $('markerBtn').addEventListener('click',tapSyncMarker);
  $('undo').addEventListener('click',doUndo);
  $('undo').addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){doUndo();e.preventDefault();}});
  $('unc').addEventListener('click',function(){if(!S||S.ended)return;S.unc=!S.unc;if(S.unc)S.uncCount++;persist();render();$('memo').focus();});
  $('sensorbtn').addEventListener('click',function(){if(!S||S.ended)return;S.sensor=(S.sensor==='on')?'off':'on';persist();render();});
  $('memo').addEventListener('input',render);
  $('toastok').addEventListener('click',function(){$('toast').classList.remove('show');});
  $('sync').addEventListener('click',function(){Clock.sync();});
  $('sync').addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){Clock.sync();e.preventDefault();}});
  $('gear').addEventListener('click',openSettings);
  $('resume').addEventListener('click',function(){ if(!S)return; S.ended=false; var ts=Clock.now(); S.boutStart=ts;S.boutStartDev=Clock.deviceNow();S.boutEnter=S.cur;S.boutIsBed=false;S.ctxStart=ts; persist(); show('codeScreen'); render(); });
  $('saveCsv').addEventListener('click',function(){ if(!S)return; download('HAIR_'+S.pid+'_'+S.id+'.csv', matrixToCsv(sessRows(S,true,S.endTs||Clock.now()))); });
  $('newsess').addEventListener('click',function(){ S=null; $('s_pid').value=''; $('s_serial').value=''; $('s_obs').value=CFG.obs||''; if($('s_set'))$('s_set').value=CFG.set||''; if($('s_start'))$('s_start').value='LIE'; show('startScreen'); refreshList(); });
  $('exportAll').addEventListener('click',function(){
    idbAll('sessions').then(function(list){
      if(!list.length){ alert('저장된 세션이 없습니다.'); return; }
      list.sort(function(a,b){return a.createdDevice-b.createdDevice;});
      var all=[HEAD.slice()];
      list.forEach(function(s){ sessRows(s,false,s.endTs||Clock.now()).forEach(function(r){ all.push(r); }); });
      download('HAIR_all_sessions_'+dateStr(Date.now())+'.csv', matrixToCsv(all));
    });
  });
  $('saveCfg').addEventListener('click',commitCfg);
  $('closeCfg').addEventListener('click',backFromSettings);
  $('resyncBtn').addEventListener('click',function(){Clock.sync();});
  $('wipeBtn').addEventListener('click',function(){
    if(!confirm('이 폰에 저장된 모든 세션 데이터를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
    idbClear('sessions').then(function(){ S=null; alert('삭제되었습니다.'); backFromSettings(); });
  });
  // 시계 표시(서버기준 단조)
  setInterval(function(){ $('clk').textContent=clock(Clock.now()); if(S&&!S.ended&&!$('codeScreen').classList.contains('hidden')) $('held').innerHTML=fmtDur((Clock.now()-S.boutStart)/1000); },1000);
  // 60초 주기 동기
  setInterval(function(){ Clock.sync(); },60000);
  // 앱 복귀 시 재동기(백그라운드에서 벽시계 점프 대비)
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) Clock.sync(); });
}

/* ───────── 부트 ───────── */
function boot(){
  var mode=('serviceWorker' in navigator)?'설치형(오프라인)':'브라우저';
  $('verMode').textContent=mode;
  Clock.reAnchor();
  idbOpen().then(loadCfg).then(function(){
    buildButtons(); bind();
    $('clk').textContent=clock(Clock.now());
    $('s_obs').value=CFG.obs||''; if($('s_set')) $('s_set').value=CFG.set||'';
    return refreshList();
  }).then(function(){
    return Clock.sync();
  }).catch(function(e){ console.error('boot error',e); alert('초기화 오류: '+(e&&e.message||e)); });
  // service worker 등록(있으면 오프라인)
  if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js').catch(function(){}); }catch(e){} }
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
