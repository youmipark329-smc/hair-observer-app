/* HAIR 병동 행동 관찰 코딩 앱 (PWA) · v1.14 · 2026-08-27
   단일 연속 코딩(S2) — 관찰자는 4-상태(LIE/SIT/STD/WLK)만 태핑, 전환·bed-exit 자동 도출.
   시각동기: HTTP /time(옵션) + 단조앵커(performance.now) → t_server/t_device/clock_offset_ms/sync_flag.
   저장: IndexedDB(오프라인·재실행 보존). 결합: 서버 3-way(행동×알람×판정), 무 PII. */
(function(){
'use strict';
/* [D20] 앱 버전 단일 상수 — 아래 세 곳이 모두 이 값에서 파생/일치해야 한다.
     1) app.js  : 이 상수(APP_VERSION) · CSV app_version 컬럼 · 화면 표기(boot 이 #verApp 를 덮어씀)
     2) index.html:296 : <span id="verApp"> 의 **정적 폴백 텍스트**(스크립트 로드 전 표시)
     3) sw.js:6 : var CACHE='hair-observer-vNN'
   버전을 올릴 때는 세 곳을 함께 바꾸고 `node verify_version.js` 로 확인한다.
   v1.14 변경: 전이 bout 을 전이행(TRANS_SEC) + 도착 자세행 2행으로 분리 [D9],
               bout 행 in_bed_move 파생 [D11], 시계 slew [D6], 재개 gap 보존 [D2]. */
var APP_VERSION='1.14';
/* [D9] 전이창(초) — 관찰자 탭은 '순간' 1개뿐이므로 전이 구간 길이는 **사전지정 상수**다.
   전이행 = [탭, 탭+TRANS_SEC), 그 뒤는 도착 자세의 state 행. 이 상수를 바꾸면
   테이블 A 의 bed-exit 라벨 폭과 테이블 C 의 transition/state 배분이 함께 바뀐다
   (분석단 픽스처 hair_join/tests/make_fixtures.py APP_BOUTS 와 동일 값이어야 한다). */
var TRANS_SEC=5, TRANS_MS=TRANS_SEC*1000;
var $=function(id){return document.getElementById(id);};

/* ───────── 어휘 (코딩시트 목록과 정합) ───────── */
var STATES=[{c:'LIE',k:'누움'},{c:'SIT',k:'앉음'},{c:'STD',k:'일어섬'},{c:'WLK',k:'걸음'}];
var CTX=[{c:'none',k:'관찰 중'},{c:'toilet',k:'화장실'},{c:'procedure',k:'처치중'},{c:'off_view',k:'시야이탈'},{c:'off_ward',k:'병동밖'}];
var MOT=[{c:'tremor',k:'떨림'},{c:'brush_repeat',k:'반복상지'},{c:'scratch',k:'긁기'},{c:'eat',k:'식사'},{c:'turn',k:'뒤척임'},{c:'care',k:'처치받음'},{c:'other',k:'기타'}];
/* [D7] 전이코드는 4×3=12 전이 모두 FROM→TO 로 통일한다(WLK 포함).
   예전처럼 WLK 가 끼면 도착코드로 뭉개면 LIE→WLK 가 'WLK' 로 사라져 이중검증이 불가능해진다.
   bed-exit 판정은 transCode 가 아니라 (from==='LIE' && to∈{SIT,STD}) 로만 한다(io_load.py:576 과 동일 규칙). */
function transCode(from,to){ return from+'→'+to; }
/* ModeA 17컬럼(코딩시트 스키마 동일 순서) + 시각동기 6컬럼(결합키) + [D20] 신설 2컬럼 = 25컬럼
   ※ 기존 23컬럼의 이름·순서는 절대 바꾸지 않는다. 신설분은 반드시 맨 뒤에 덧붙인다. */
var HEAD_CORE=['record_id','observer_id','patient_id','date','time_start','time_end','code','is_bed_exit',
  'context','in_bed_move','sensor_status','uncertain','duration_sec','note','enroll_date','set_assign','motion_detail'];
var HEAD_TIME=['t_server_start','t_server_end','clock_offset_ms','sync_flag','session_id','device_serial'];
var HEAD_EXT=['app_version','rtt_ms'];                          // [D20] 신설 — 맨 뒤 고정
var HEAD=HEAD_CORE.concat(HEAD_TIME).concat(HEAD_EXT);

/* ───────── 시각동기 모듈 (단조앵커 + Cristian) ───────── */
var Clock={
  offsetMs:0, flag:'DEVICE', rtt:null, endpoint:'', lastSync:0,
  anchorMono:0, anchorServer:0,     // t_server = anchorServer + (performance.now()-anchorMono)
  anchored:false,
  lastNow:0,                        // [D6] 마지막 반환값(단조 보장용)
  /* [D6] 아직 반영하지 못한 '뒤로 가는' 보정량(ms, 음수). 0 이면 보정 대기 없음. */
  skewRemain:0, skewMono:0, lastStepMs:0, stepWarned:false,
  /* 보정 흡수 속도 상한. 이 구간에서 시계는 최대 10% 느려질 뿐 **멈추지 않는다**. */
  SLEW_RATE:0.10, STEP_WARN_MS:1000,
  /* [D6] 앵커 갱신 — 재동기로 offset 이 바뀌면 여기서만 앵커를 옮긴다.
     이미 기록된 이벤트의 t_server 는 절대 소급 변경하지 않는다(절대 ms 로 저장돼 있음).

     ★ 앵커를 **뒤로** 옮기면 안 된다. 예전 구현은 offset 이 하향 수정될 때
       anchorServer 를 그대로 Δ 만큼 되돌렸고, now() 의 단조 클램프가 그 Δ 동안
       매 호출 +1 ms 만 돌려주어 시계가 **정지**했다(실측: offset 8000→200 수정 후
       5 실초 동안 1 ms 진행). 그 사이 기록된 bout 은 duration 0.0s·sync_flag=OK 로
       나가 CSV 만 봐서는 알 수 없다. 그래서:
         · Δ>=0 (앞으로) → 즉시 반영(단조 위반 없음)
         · Δ<0  (뒤로)  → 앵커는 그대로 두고 skewRemain 에 적립해 now() 가
                          SLEW_RATE 속도로 **서서히** 흡수한다(정지·역행 없음). */
  reAnchor:function(){
    var mono=performance.now(), target=Date.now()+this.offsetMs;
    if(!this.anchored){
      this.anchorMono=mono; this.anchorServer=target; this.anchored=true;
      this.skewRemain=0; this.skewMono=mono; this.lastStepMs=0; return;
    }
    var cur=this.now();                    // 대기 중이던 slew 를 먼저 반영한 현재값
    var delta=target-cur;
    this.anchorMono=performance.now(); this.skewMono=this.anchorMono;
    if(delta>=0){ this.anchorServer=target; this.skewRemain=0; }
    else        { this.anchorServer=cur;    this.skewRemain=delta; }
    this.lastStepMs=delta;
    // 큰 되돌림은 흡수에 오래 걸린다 → 관찰자에게 즉시 알린다(조용히 넘기지 않는다).
    if(delta<=-this.STEP_WARN_MS && !this.stepWarned){ this.stepWarned=true; clockStepWarn(delta); }
  },
  /* [D6] 단조 보장 + slew. 뒤로 가는 보정은 여기서 조금씩만 흡수하므로
     값이 뒤로 가지도, 멈추지도 않는다. */
  now:function(){
    var mono=performance.now();
    if(this.skewRemain<0){
      var dt=mono-this.skewMono; if(!(dt>0)) dt=0;
      var apply=Math.min(dt*this.SLEW_RATE, -this.skewRemain);
      if(apply>0){ this.anchorServer-=apply; this.skewRemain+=apply; }
      this.skewMono=mono;
    }
    var t=Math.round(this.anchorServer + (mono-this.anchorMono));
    if(t<this.lastNow) t=this.lastNow+1;   // 최후 보루(performance.now 이상동작 대비)
    this.lastNow=t; return t;
  },
  /* [D2] 시간축을 floor 이상으로 **앞으로** 끌어올린다(뒤로는 절대 가지 않는다).
     저장된 세션의 시각이 재개 기기의 시계보다 앞설 때 세션 시간축을 채택하는 데 쓴다. */
  adoptFloor:function(floor){
    var t=this.now();
    if(typeof floor==='number'&&isFinite(floor)&&floor>t){
      this.anchorServer+=(floor-t); this.lastStepMs=floor-t; this.lastNow=floor;
      this.skewRemain=0; this.skewMono=performance.now(); t=floor;
    }
    return t;
  },
  /* [D5/D6] 이 행의 t_server 를 실제로 설명하는 오프셋(= now() - 기기시계).
     slew 중에는 측정값(offsetMs)과 다르며, **적용된 값**을 적는 것이 정직하다. */
  appliedOffset:function(){ return Math.round(this.now()-Date.now()); },
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
    }).catch(function(){
      /* [D5] 동기 실패 경로에서도 반드시 재앵커 — 안 하면 절전(백그라운드) 동안 performance.now 가
         멈추거나 늘어져 앵커가 실제 벽시계와 어긋난 채 계속 누적된다(드리프트). */
      self.flag='FAIL'; self.reAnchor(); self.lastSync=Date.now(); paintSync();
    });
  }
};
/* [D5] 시각 스냅샷 — clock_offset_ms·rtt_ms 는 OK 모드에서만 값을 남긴다.
   DEVICE/FAIL 은 '측정하지 않음'이지 '오프셋 0'이 아니므로 빈 값으로 둔다. */
function snapT(){
  /* [D6] offset 은 **측정값(offsetMs)이 아니라 적용값**을 적는다. slew 중에는 둘이
     다르며, t_server 를 설명하는 것은 적용값이다(K7 잔차 게이트도 이 값을 본다). */
  return {offset:(Clock.flag==='OK'?Clock.appliedOffset():null),
          rtt:(Clock.flag==='OK'?Clock.rtt:null),
          flag:Clock.flag};
}
/* CSV 출력 가드 — 구형 세션(offset:0/DEVICE 로 저장된 것)도 빈 값으로 정규화 */
function offOut(x){ return (x&&x.flag==='OK'&&x.offset!=null)?x.offset:''; }
function rttOut(x){ return (x&&x.flag==='OK'&&x.rtt!=null)?x.rtt:''; }
/* [D8] sensor_status 허용값은 on/off/unknown 뿐. 스냅샷이 없는 구형 행은 unknown. */
function senOut(x){ var v=x&&x.sensor; return (v==='on'||v==='off')?v:'unknown'; }
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
/* [D4] onabort 누락 시 QuotaExceeded·스토리지 축출로 트랜잭션이 abort 되면
   promise 가 영원히 pending 이라 실패가 조용히 묻힌다 → onabort 도 reject. */
function idbPut(store,val){ return new Promise(function(res,rej){
  var tx;
  try{ tx=DB.transaction(store,'readwrite'); }catch(e){ rej(e); return; }
  try{ tx.objectStore(store).put(val); }catch(e){ rej(e); return; }
  tx.oncomplete=function(){res();};
  tx.onerror=function(){rej(tx.error||new Error('idb error'));};
  tx.onabort=function(){rej(tx.error||new Error('idb abort'));};
}); }
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
    /* [D3] record_id 는 구간이 '열릴 때' 부여한다(seq 3 소비: 전이행=r1, 상태행=r2, ctx=r3).
       [D9] 한 bout 은 전이행+상태행 최대 2행으로 나가므로 rid 를 2개 예약한다.
       열린 채로 export 해도 같은 값이 나오고, undo 해도 번호를 되돌리지 않아 영구 유일하다. */
    seq:3, boutRid:'r1', boutRid2:'r2', ctxRid:'r3',
    bouts:[], ctxStart:ts, ctxBouts:[], motions:[], markers:[], log:[], undoCount:0, uncCount:0
  };
}
/* [D2][D3] 구형(이전 버전) 세션을 신설 필드로 올린다.
   ★ 이어하기 경로뿐 아니라 **모든 export 경로(sessRows)** 가 먼저 호출한다.
     예전에는 구형 세션이 migrate 를 거치지 않고 export 되면 열린 bout 행과 열린
     context 행이 같은 폴백식 'r'+(seq+1) 을 써 record_id 가 충돌했고,
     로더의 _dedup(keep=last) 이 자세행을 조용히 지웠다. */
function migrate(sess){
  if(typeof sess.seq!=='number'||!isFinite(sess.seq)) sess.seq=0;
  if(!sess.boutRid) sess.boutRid='r'+(++sess.seq);
  if(!sess.boutRid2) sess.boutRid2='r'+(++sess.seq);   // [D9] 상태행 몫
  if(!sess.ctxRid) sess.ctxRid='r'+(++sess.seq);
  if(!sess.sensor) sess.sensor='unknown';
  if(!sess.bouts) sess.bouts=[]; if(!sess.ctxBouts) sess.ctxBouts=[];
  if(!sess.motions) sess.motions=[]; if(!sess.markers) sess.markers=[]; if(!sess.log) sess.log=[];
  return sess;
}
/* [D4] 치명 경고 배너 — 지워지지 않는다(닫기 버튼 없음). 모든 화면 위에 고정되며
   배너 안의 [CSV 저장] 버튼이 **메모리의 현재 세션**을 그대로 내보낸다.
   (예전에는 [CSV 저장] 이 요약화면 안에만 있어, 저장 실패로 코딩화면에 갇히면
    탈출구가 없었다 — 도달 가능한 유일한 export 는 IndexedDB 의 낡은 사본이었다.) */
function showFatalBanner(msg){
  var el=$('savebanner'); if(!el) return;
  var tx=$('savebannertxt');
  if(tx) tx.textContent=msg; else el.textContent=msg;
  el.className='savebanner show';
}
function saveFail(err){
  try{ console.error('persist error',err); }catch(e){}
  showFatalBanner('⛔ 저장 실패 — 이 기기에 기록이 저장되지 않았습니다('+((err&&(err.name||err.message))||'error')+
                 '). 아래 [CSV 저장] 을 지금 누르고 연구담당자에게 알리세요.');
}
/* [D6] 시계가 크게 되돌려졌다 — slew 로 흡수 중이라 기록은 멈추지도 역행하지도
   않지만, 흡수가 끝날 때까지 t_server 오차가 남는다. 조용히 넘기지 않는다. */
function clockStepWarn(delta){
  showFatalBanner('⚠ 시계 되돌림 '+Math.round(-delta)+' ms 감지 — 기록은 계속되지만 '+
                  '시각 정합에 오차가 남습니다. 아래 [CSV 저장] 으로 내보내고 연구담당자에게 알리세요.');
}
var _saveT=null;
function persist(){ if(!S) return; clearTimeout(_saveT); _saveT=setTimeout(function(){ if(S) idbPut('sessions',S).catch(saveFail); },250); }
function persistNow(){ clearTimeout(_saveT); if(S) return idbPut('sessions',S); return Promise.resolve(); }

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
  var ts=Clock.now(), dev=Clock.deviceNow(), nt=memoVal(), sn=snapT();
  // [D3] 닫히는 bout 은 '열릴 때' 받아둔 rid 를 그대로 쓴다(새로 뽑지 않는다).
  // [D8] sensor 는 push 시점 스냅샷 — 세션 전역값을 export 때 소급 적용하지 않는다.
  S.bouts.push({rid:S.boutRid,rid2:S.boutRid2,state:S.cur,enter:S.boutEnter,isBed:S.boutIsBed,start:S.boutStart,startDev:S.boutStartDev,
    end:ts,endDev:dev,dur:Math.max(0,(ts-S.boutStart)/1000),ctx:S.ctx,unc:S.unc,note:nt,
    offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});
  // [D7] bed-exit 은 오직 LIE→SIT/STD. LIE→WLK 는 막지 않고 전이로 남기되 bed_exit=0.
  var isBed=(S.cur==='LIE'&&(c==='SIT'||c==='STD'));
  S.log.push({t:clock(ts),kind:'transition',code:transCode(S.cur,c),bed:isBed,dur:Math.max(0,(ts-S.boutStart)/1000),from:S.cur});
  S.cur=c; S.boutStart=ts; S.boutStartDev=dev;
  S.boutRid='r'+(++S.seq); S.boutRid2='r'+(++S.seq);   // [D3][D9] 전이행·상태행 몫을 함께 부여
  S.boutEnter=S.log[S.log.length-1].code; S.boutIsBed=isBed; S.reminded=false;
  if(nt)$('memo').value=''; persist(); render();
}
function tapMotion(m,b){
  if(!S||S.ended||LOCKED()||S.cur==='WLK')return;
  var ts=Clock.now(), ibm=(S.cur==='LIE'&&m.c==='turn'), nt=memoVal(), sn=snapT();
  S.motions.push({rid:'r'+(++S.seq),t:ts,tDev:Clock.deviceNow(),state:S.cur,code:m.c,ibm:ibm,unc:S.unc,note:nt,
    offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});   // [D8] 스냅샷
  S.log.push({t:clock(ts),kind:'motion',code:'motion:'+m.c+(ibm?' (in_bed_move=1)':''),bed:false});
  b.classList.add('on'); setTimeout(function(){b.classList.remove('on');},420);
  if(nt)$('memo').value=''; persist(); render();
}
function tapContext(x){
  if(!S||S.ended)return;
  var leaving=(x.c==='toilet'||x.c==='off_view'||x.c==='off_ward');
  if(leaving&&S.cur==='LIE'&&!S.reminded){ showToast(); S.reminded=true; }
  var newc=(x.c===S.ctx)?'none':x.c, ts=Clock.now(), sn=snapT();
  // [D1] 이 구간이 그대로 CSV 의 code='context' 행 1개가 된다 → rid·시각·스냅샷을 모두 갖춘다.
  S.ctxBouts.push({rid:S.ctxRid,ctx:S.ctx,start:S.ctxStart,end:ts,dur:Math.max(0,(ts-S.ctxStart)/1000),
    offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});
  S.ctx=newc; S.ctxStart=ts; S.ctxRid='r'+(++S.seq);   // [D3] 새 ctx 구간이 열리는 시점에 부여
  S.log.push({t:clock(ts),kind:'context',code:'context='+newc,bed:false});
  persist(); render();
}
function tapSyncMarker(){
  if(!S||S.ended)return;
  var ts=Clock.now(), sn=snapT();
  S.markers.push({rid:'r'+(++S.seq),t:ts,tDev:Clock.deviceNow(),
    offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});   // [D8] 스냅샷
  S.log.push({t:clock(ts),kind:'marker',code:'⏱ sync_marker',bed:false});
  var b=$('markerBtn'); b.classList.add('flash'); setTimeout(function(){b.classList.remove('flash');},450);
  persist(); render();
}
function showToast(){var t=$('toast');t.classList.add('show');clearTimeout(showToast._h);showToast._h=setTimeout(function(){t.classList.remove('show');},6000);}
function doUndo(){
  if(!S||S.ended||!S.log.length)return;
  // [D2] 세션 재개 마커는 되돌릴 수 없다 — 미관찰 구간을 '관찰한 것'으로 되살릴 수는 없기 때문.
  if(S.log[S.log.length-1].kind==='resume') return;
  var e=S.log.pop(); S.undoCount++;
  /* [D3] S.seq 는 되돌리지 않는다. 되돌리면 이미 export 된 record_id 와 충돌하므로,
     번호를 소비된 채로 두어 영구 유일성을 지킨다(중간에 번호 구멍이 생겨도 무방). */
  if(e.kind==='transition'){ var b=S.bouts.pop(); if(b){S.cur=b.state;S.boutStart=b.start;S.boutStartDev=b.startDev;S.boutEnter=b.enter;S.boutIsBed=b.isBed;S.boutRid=b.rid;S.boutRid2=b.rid2;} }
  else if(e.kind==='motion'){ S.motions.pop(); }
  else if(e.kind==='marker'){ S.markers.pop(); }
  else if(e.kind==='context'){ var cb=S.ctxBouts.pop(); if(cb){S.ctx=cb.ctx;S.ctxStart=cb.start;S.ctxRid=cb.rid;} }
  else if(e.kind==='sensor'){ S.sensor=e.prev; }   // [D8] 센서 토글도 undo 대상
  /* [D6] 되살린 구간 시작이 '미래'면(시계 되돌림 이력이 있는 세션) 그대로 두면
     다음 export 가 음수 duration_sec 을 낸다 — 현재 시각으로 클램프한다. */
  var nw=Clock.now();
  if(typeof S.boutStart==='number'&&S.boutStart>nw) S.boutStart=nw;
  if(typeof S.ctxStart==='number'&&S.ctxStart>nw) S.ctxStart=nw;
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
  var rows=(sess.bouts||[]).slice();
  if(!sess.ended){ var sn=snapT();
    // [D3] 열린 bout 은 열릴 때 받아둔 rid 를 쓴다 → 몇 번을 export 해도 record_id 가 같다.
    rows=rows.concat([{rid:sess.boutRid||('r'+((sess.seq||0)+1)),rid2:sess.boutRid2||('r'+((sess.seq||0)+2)),
      state:sess.cur,enter:sess.boutEnter,isBed:sess.boutIsBed,
      start:sess.boutStart,startDev:sess.boutStartDev,end:nowTs,endDev:Clock.deviceNow(),dur:Math.max(0,(nowTs-sess.boutStart)/1000),
      ctx:sess.ctx,unc:sess.unc,note:'',offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:sess.sensor,open:true}]); }
  return rows;
}
/* [D11] 이 구간(=출력 1행)이 'LIE 중 뒤척임' 을 포함하는가.
   분석단 join_3way._derive_in_bed_move 와 **문자 그대로 같은 규칙**을 쓴다:
   행의 state 가 LIE 이고, motion_detail=='turn' point 이벤트가 [t0,t1) 안에 있으면 1.
   (예전 앱은 bout 행에 상수 0 을 적고 motion 행에만 1 을 적어, 분석단이 대조할 대상이
    아예 없었고 in_bed_move_drift 가 구조적으로 상시 1 이었다.) */
function rowIbm(sess,state,t0,t1){
  if(state!=='LIE') return 0;
  var ms=sess.motions||[];
  for(var i=ms.length-1;i>=0;i--){ var m=ms[i];
    if(m.t<t0) break;
    if(m.code==='turn'&&m.t>=t0&&m.t<t1) return 1; }
  return 0;
}
/* [D9] bout 1개 → 출력 행 1~2개.
     (1) 전이행  code=FROM→TO · is_bed_exit · [start, min(start+TRANS_MS, end))
     (2) 상태행  code=도착자세 · is_bed_exit=0 · [min(start+TRANS_MS,end), end)
   전이코드를 도착 자세 체류 전체에 붙이면 (a) 테이블 C 의 4-state 분모가 사실상
   사라지고(전이 pseudo-state 가 노출의 대부분을 차지), (b) 테이블 A 의 bed-exit
   라벨이 체류 전체(수백 초)로 번져 학습·평가셋이 오염된다. 분석단 픽스처
   (make_fixtures.APP_BOUTS r002/r003)와 같은 2행 구조로 맞춘다. */
function boutOutRows(sess,b){
  var s=b.start, e=Math.max(b.start,b.end), out=[];
  var isTrans=((''+(b.enter||'')).indexOf('→')>=0);
  if(!isTrans){
    out.push({rid:b.rid,code:b.state,bed:0,ibm:rowIbm(sess,b.state,s,e),start:s,end:e,open:!!b.open,src:b});
    return out;
  }
  var tEnd=Math.min(s+TRANS_MS,e);
  out.push({rid:b.rid,code:b.enter,bed:b.isBed?1:0,ibm:0,start:s,end:tEnd,
            open:(!!b.open&&!(e>tEnd)),src:b});
  if(e>tEnd) out.push({rid:b.rid2,code:b.state,bed:0,ibm:rowIbm(sess,b.state,tEnd,e),
            start:tEnd,end:e,open:!!b.open,src:b});
  return out;
}
/* 메모는 bout 이 닫히는 순간 입력된 것이므로 **마지막 행에만** 싣는다
   (두 행에 같은 자유문을 복사하면 자유문 노출면만 2배가 된다). */
function withNoteFlag(rows){ if(rows.length) rows[rows.length-1].last=true; return rows; }
/* [D1] 맥락 구간 행 — code='context' 로 1구간 1행. 자세 bout 이 아니므로
   파이프라인 behavior_bouts 는 이 행으로 bout 을 만들지 않고, validity 가 off_view/off_ward 를 직접 만든다. */
function ctxRows(sess,nowTs){
  var rows=(sess.ctxBouts||[]).slice();
  if(!sess.ended){ var sn=snapT();
    // [D3] 폴백 번호는 열린 bout(seq+1·seq+2)과 겹치지 않게 seq+3 부터 쓴다.
    //      (실제로는 sessRows 가 migrate 를 먼저 돌려 폴백이 발동하지 않는다.)
    rows=rows.concat([{rid:sess.ctxRid||('r'+((sess.seq||0)+3)),ctx:sess.ctx,start:sess.ctxStart,end:nowTs,
      dur:Math.max(0,(nowTs-sess.ctxStart)/1000),offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:sess.sensor,open:true}]); }
  return rows;
}
function csvEscape(v){v=String(v==null?'':v);return /[",\n]/.test(v)?('"'+v.replace(/"/g,'""')+'"'):v;}
function sessRows(sess,includeHead,nowTs){
  /* [D3] 어떤 export 경로로 들어와도 구형 세션의 rid 를 먼저 확정한다
     (열린 bout 행과 열린 context 행이 같은 폴백 번호를 써 충돌하던 경로 차단). */
  migrate(sess);
  var out=includeHead?[HEAD.slice()]:[];
  /* rid 폴백은 구형 세션의 motion/marker 전용. seq 뒤 번호부터 매긴다. */
  var n=(sess.seq||0)+3;
  function rid(v){ return v||('r'+(++n)); }
  boutRows(sess,nowTs).forEach(function(b){
    withNoteFlag(boutOutRows(sess,b)).forEach(function(r){
      out.push([rid(r.rid),sess.obs,sess.pid,dateStr(r.start),clock(r.start),r.open?'(진행중)':clock(r.end),
        r.code,r.bed,b.ctx,r.ibm,senOut(b),b.unc?1:0,Math.max(0,(r.end-r.start)/1000).toFixed(1),(r.last?(b.note||''):''),
        sess.enroll,sess.set||'','',
        isoMs(r.start),r.open?'':isoMs(r.end),offOut(b),b.flag||'',sess.id,sess.serial||'',
        APP_VERSION,rttOut(b)]);
    });
  });
  // [D1] context 행종: is_bed_exit=0 · motion_detail·in_bed_move 공란 · 시각은 구간 경계
  ctxRows(sess,nowTs).forEach(function(cb){
    out.push([rid(cb.rid),sess.obs,sess.pid,dateStr(cb.start),clock(cb.start),cb.open?'(진행중)':clock(cb.end),
      'context',0,cb.ctx,'',senOut(cb),0,cb.dur.toFixed(1),'',sess.enroll,sess.set||'','',
      isoMs(cb.start),cb.open?'':isoMs(cb.end),offOut(cb),cb.flag||'',sess.id,sess.serial||'',
      APP_VERSION,rttOut(cb)]);
  });
  (sess.motions||[]).forEach(function(m){
    out.push([rid(m.rid),sess.obs,sess.pid,dateStr(m.t),clock(m.t),clock(m.t),
      'motion',0,'',m.ibm?1:0,senOut(m),m.unc?1:0,'0.0',m.note||'',sess.enroll,sess.set||'',m.code,
      isoMs(m.t),isoMs(m.t),offOut(m),m.flag||'',sess.id,sess.serial||'',
      APP_VERSION,rttOut(m)]);
  });
  (sess.markers||[]).forEach(function(k){
    out.push([rid(k.rid),sess.obs,sess.pid,dateStr(k.t),clock(k.t),clock(k.t),
      'sync_marker',0,'',0,senOut(k),0,'0.0','',sess.enroll,sess.set||'','',
      isoMs(k.t),isoMs(k.t),offOut(k),k.flag||'',sess.id,sess.serial||'',
      APP_VERSION,rttOut(k)]);
  });
  return out;
}
function matrixToCsv(rows){ return '﻿'+rows.map(function(r){return r.map(csvEscape).join(',');}).join('\r\n'); }
function download(name,text){ var blob=new Blob([text],{type:'text/csv;charset=utf-8'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1500); }

/* ───────── 세션 요약 ───────── */
function endSession(){
  if(!S)return;
  if(!S.ended){
    var ts=Clock.now(), sn=snapT();
    S.bouts.push({rid:S.boutRid,rid2:S.boutRid2,state:S.cur,enter:S.boutEnter,isBed:S.boutIsBed,start:S.boutStart,startDev:S.boutStartDev,
      end:ts,endDev:Clock.deviceNow(),dur:Math.max(0,(ts-S.boutStart)/1000),ctx:S.ctx,unc:S.unc,note:memoVal(),
      offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});                       // [D3][D8][D9]
    S.ctxBouts.push({rid:S.ctxRid,ctx:S.ctx,start:S.ctxStart,end:ts,dur:Math.max(0,(ts-S.ctxStart)/1000),
      offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});                       // [D1]
    S.ended=true; S.endTs=ts;
  }
  /* [D4] 저장이 확인된 뒤에만 요약화면으로 넘어간다. 실패하면 배너를 띄우고 코딩화면에 머문다
     — 종료 버튼을 다시 누르면 (행 중복 없이) 저장만 재시도한다. */
  var endTs=S.endTs;
  persistNow().then(function(){ buildSummary(S,endTs); show('summaryScreen'); }).catch(saveFail);
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
/* [D4] IndexedDB 사본보다 **메모리의 현재 세션**이 항상 최신이다(저장 실패 중일 수도 있다). */
function mergeCurrent(list){
  list=(list||[]).slice();
  if(!S) return list;
  for(var i=0;i<list.length;i++){ if(list[i]&&list[i].id===S.id){ list[i]=S; return list; } }
  list.push(S); return list;
}
function exportCurrent(){
  if(!S){ alert('진행 중인 세션이 없습니다.'); return; }
  download('HAIR_'+S.pid+'_'+S.id+'.csv', matrixToCsv(sessRows(S,true,S.endTs||Clock.now())));
}
function refreshList(){
  return idbAll('sessions').then(function(list){
    list=mergeCurrent(list);
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
  // [D4] 설정 저장 실패가 세션 시작을 막지는 않지만, 미처리 rejection 으로 새지 않게 한다
  CFG.obs=obs; CFG.set=($('s_set').value||'').trim(); saveCfg().catch(function(){});
  persistNow().then(function(){ show('codeScreen'); render(); }).catch(saveFail);
}
/* [D2] 마지막으로 '관찰이 살아 있었다'고 말할 수 있는 시각 */
function lastKnownTs(sess){
  var t=sess.sessionStart||0;
  function up(v){ if(typeof v==='number'&&isFinite(v)&&v>t) t=v; }
  up(sess.endTs); up(sess.boutStart); up(sess.ctxStart);
  (sess.bouts||[]).forEach(function(b){ up(b.end); });
  (sess.ctxBouts||[]).forEach(function(c){ up(c.end); });
  (sess.motions||[]).forEach(function(m){ up(m.t); });
  (sess.markers||[]).forEach(function(k){ up(k.t); });
  return t;
}
/* [D2] 같은 것을 **기기시계(Date.now) 축**에서 구한다. 서버 시간축과 독립이므로
   재개 기기의 시계가 저장된 세션보다 뒤에 있어도(오프라인 복귀·오프셋 하향)
   '얼마나 지났는가' 를 잴 수 있다. */
function lastKnownDev(sess){
  var t=sess.createdDevice||0;
  function up(v){ if(typeof v==='number'&&isFinite(v)&&v>t) t=v; }
  up(sess.boutStartDev);
  (sess.bouts||[]).forEach(function(b){ up(b.startDev); up(b.endDev); });
  (sess.motions||[]).forEach(function(m){ up(m.tDev); });
  (sess.markers||[]).forEach(function(k){ up(k.tDev); });
  return t;
}
/* [D2] 세션 재개(앱 강제종료·재부팅 후 '이어하기', 요약화면의 '코딩 계속' 공통 경로)
   - 열린 bout 을 '마지막 알려진 시각'으로 닫아 push  → 열려 있던 bed-exit 행이 유실되지 않는다
   - [마지막 시각, 재개) 구간은 code='context' / context='off_view' 로 남긴다 → 유효 커버리지에서 정직하게 빠진다 */
function resumeSession(sess){
  S=migrate(sess);
  var last=lastKnownTs(S), lastDev=lastKnownDev(S), devNow=Clock.deviceNow();
  var elapsed=(lastDev>0&&devNow>lastDev)?(devNow-lastDev):0;
  /* [D2] ★ 예전에는 `if(last>ts) last=ts;` 로 시계 역전을 '방어'했는데, 그러면
     last==ts 가 되어 미관찰 gap 행도 resume 마커도 만들어지지 않았다 —
     실제로 600초를 못 본 세션이 커버리지 100% 로 보고됐다.
     시계가 뒤에 있다는 것은 '시간이 안 갔다' 는 뜻이 아니라 **재개 기기의 시계가
     뒤처져 있다** 는 뜻이므로, 세션 시간축을 그대로 채택하고 기기시계로 잰
     경과시간만큼 앞으로 끌어올린다(뒤로는 가지 않는다). */
  var before=Clock.now();
  var ts=Clock.adoptFloor(last+elapsed);
  /* 저장된 세션의 시간축이 현재 시계와 크게 어긋나 있으면(오프셋이 달라진 채 재개)
     세션 시간축을 이어 쓰는 쪽을 택하지만, 그 사실을 조용히 넘기지는 않는다 —
     이후 t_server 는 서버 실제 시각과 (ts-before) 만큼 어긋난 채로 간다. */
  if(ts-before>=Clock.STEP_WARN_MS){
    showFatalBanner('⚠ 재개한 세션의 시각이 이 기기 시계보다 '+Math.round((ts-before)/1000)+
      '초 앞서 있습니다 — 세션 시간축을 그대로 이어 씁니다. 시각 정합에 오차가 남으니 '+
      '아래 [CSV 저장] 으로 내보내고 연구담당자에게 알리세요.');
  }
  var dev=Clock.deviceNow(), sn=snapT();
  /* [D10] 전이 직후 앱이 죽으면 마지막 알려진 시각 == bout 시작이 되어 목격한
     bed-exit 이 0초 bout 으로 남고 테이블 A(1차 지표 ground truth)에서 사라진다.
     전이 bout 은 **선언된 전이창(TRANS_SEC)** 까지는 닫아 준다 — 그 이상은 추정하지 않는다. */
  var minEnd=((''+(S.boutEnter||'')).indexOf('→')>=0&&S.boutStart!=null)
             ? Math.min(S.boutStart+TRANS_MS,ts) : -Infinity;
  var closeTs=Math.max(last,minEnd);
  if(closeTs>ts) closeTs=ts;
  if(S.boutStart!=null&&closeTs<S.boutStart) closeTs=S.boutStart;
  if(S.ctxStart!=null&&closeTs<S.ctxStart) closeTs=S.ctxStart;
  if(!S.ended){                                         // 종료 처리된 세션은 endSession 이 이미 push 했다
    S.bouts.push({rid:S.boutRid,rid2:S.boutRid2,state:S.cur,enter:S.boutEnter,isBed:S.boutIsBed,
      start:S.boutStart,startDev:S.boutStartDev,end:closeTs,endDev:dev,dur:Math.max(0,(closeTs-S.boutStart)/1000),
      ctx:S.ctx,unc:S.unc,note:'',offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});
    S.ctxBouts.push({rid:S.ctxRid,ctx:S.ctx,start:S.ctxStart,end:closeTs,dur:Math.max(0,(closeTs-S.ctxStart)/1000),
      offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor});
  }
  var gapSec=(ts-closeTs)/1000;
  if(ts>closeTs){                                       // 0초 유령 구간은 만들지 않는다
    S.ctxBouts.push({rid:'r'+(++S.seq),ctx:'off_view',start:closeTs,end:ts,dur:gapSec,
      offset:sn.offset,rtt:sn.rtt,flag:sn.flag,sensor:S.sensor,gap:true});
  }
  /* [D2] resume 마커는 **무조건** 남긴다. doUndo 가 이 마커에서 멈추는 것이
     재개가 push 한 bout 을 되살리지 못하게 막는 유일한 장치다
     (예전에는 gap 이 0 이면 마커가 없어, undo 한 번으로 미래 시각의 bout 이
      되살아나 음수 duration_sec 이 export 됐다). */
  S.log.push({t:clock(ts),kind:'resume',bed:false,
    code:'▷ 재개 · 미관찰 '+fmtDur(gapSec)+(gapSec>0?' (context=off_view)':'')});
  S.ended=false; S.endTs=null;                          // [D2] endTs 도 반드시 되돌린다
  S.boutStart=ts; S.boutStartDev=dev; S.boutRid='r'+(++S.seq); S.boutRid2='r'+(++S.seq);
  /* [D2] 아래 두 줄은 '직전 bout 을 push 한 뒤'로 옮긴 것이다(예전에는 push 전이라 bed-exit 이 증발했다).
     재개 직후 bout 은 관찰자가 목격한 전이가 아니므로 enter=현재상태·isBed=false 로 시작해야 한다
     — 그대로 두면 방금 push 한 bed-exit 이 다음 행에서 한 번 더 계상된다. */
  S.boutEnter=S.cur; S.boutIsBed=false;
  S.ctxStart=ts; S.ctxRid='r'+(++S.seq);
  persistNow().then(function(){ show('codeScreen'); render(); })
              .catch(function(e){ saveFail(e); show('codeScreen'); render(); });
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
  // [D4] 설정 저장이 실패해도 화면은 닫아 주되(입력값은 메모리에 반영됨) 실패는 배너로 알린다
  saveCfg().catch(function(e){ saveFail(e); }).then(function(){ return Clock.sync(); }).then(backFromSettings);
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
  // [D8] 센서 토글을 로그에 남겨 undo 가능하게 한다(값은 이후 push 되는 행부터 반영).
  $('sensorbtn').addEventListener('click',function(){
    if(!S||S.ended)return;
    var prev=S.sensor; S.sensor=(prev==='on')?'off':'on';
    S.log.push({t:clock(Clock.now()),kind:'sensor',code:'sensor='+S.sensor,prev:prev,bed:false});
    persist();render();
  });
  $('memo').addEventListener('input',render);
  $('toastok').addEventListener('click',function(){$('toast').classList.remove('show');});
  $('sync').addEventListener('click',function(){Clock.sync();});
  $('sync').addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){Clock.sync();e.preventDefault();}});
  $('gear').addEventListener('click',openSettings);
  // [D2] 요약화면 '코딩 계속' 도 재개 경로를 그대로 탄다(직전 bout 보존 + 미관찰 gap 기록)
  $('resume').addEventListener('click',function(){ if(!S)return; resumeSession(S); });
  $('saveCsv').addEventListener('click',exportCurrent);
  /* [D4] 배너 안의 탈출구 — 저장 실패로 요약화면에 못 가도 여기서 메모리 그대로 내보낸다. */
  if($('bannerCsv')) $('bannerCsv').addEventListener('click',exportCurrent);
  $('newsess').addEventListener('click',function(){ S=null; $('s_pid').value=''; $('s_serial').value=''; $('s_obs').value=CFG.obs||''; if($('s_set'))$('s_set').value=CFG.set||''; if($('s_start'))$('s_start').value='LIE'; show('startScreen'); refreshList(); });
  $('exportAll').addEventListener('click',function(){
    idbAll('sessions').then(function(list){
      /* [D4] 저장이 실패한 상태에서도 이 버튼이 낡은 IndexedDB 사본을 내보내지 않도록
         메모리의 현재 세션을 우선 반영한다(실측: 6행 중 3행만 나가던 경로). */
      list=mergeCurrent(list);
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
  // 앱 복귀 시 재동기(백그라운드에서 벽시계 점프 대비) · [D4] 화면을 벗어날 땐 즉시 저장
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){ persistNow().catch(saveFail); }
    else { Clock.sync(); }
  });
  // [D4] 안드로이드는 pagehide 이후 프로세스를 예고 없이 죽인다 — 디바운스를 건너뛰고 마지막 저장
  window.addEventListener('pagehide',function(){ persistNow().catch(saveFail); });
}

/* ───────── 부트 ───────── */
function boot(){
  var mode=('serviceWorker' in navigator)?'설치형(오프라인)':'브라우저';
  $('verMode').textContent=mode;
  if($('verApp')) $('verApp').textContent=APP_VERSION;   // [D20] 화면 표기도 상수에서 파생
  /* [D4] 축출(eviction) 방지 — 브라우저에 영구 저장소를 요청. 거부돼도 그대로 진행한다. */
  try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().catch(function(){}); }catch(e){}
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
