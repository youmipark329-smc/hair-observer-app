/* HAIR 관찰코딩 · Service Worker · app v1.19 (2026-08-28)
   [D20] CACHE 이름은 app.js 의 APP_VERSION 과 함께 올린다(v1.19 ↔ hair-observer-v22).
   전략: 앱 셸(HTML/JS/매니페스트/아이콘)은 network-first — 온라인이면 항상 최신,
   오프라인이면 캐시로 폴백. → 앱을 갱신·재배포하면 다음 접속 시 자동 반영(옛 버전 고착 방지).
   관찰 데이터는 IndexedDB(캐시와 무관). 시각 엔드포인트 등 외부 API는 항상 네트워크.

   [D22] v1.16 — network-first 에 NET_TIMEOUT 상한을 건다.
   종전에는 fetch 프라미스가 끝날 때까지 respondWith 가 매달렸다. 와이파이를 끄면
   fetch 가 즉시 reject 되어 문제가 없지만, **병동 와이파이에 붙어 있는데 그 망이
   github.io 로 나가는 패킷을 조용히 버리는 경우**(폐쇄망 기본 DROP·캡티브 포털)
   TCP/TLS 타임아웃까지 수십 초를 기다린다. 그 대상이 문서(index.html)라 앱 코드가
   한 줄도 돌기 전이고, CRC 는 앱이 죽은 줄 알고 강제종료를 반복하게 된다.
   Pages 는 설치 직후 꺼두므로 네트워크에서 얻을 이득이 0인데 대기 비용만 문다.
   → 캐시 적중이 있으면 네트워크에 1.5초만 준다. 늦게 온 응답도 캐시에는 반영되므로
     '다음 실행 시 최신' 이라는 network-first 의 목적은 그대로 유지된다. */
var CACHE='hair-observer-v22';
var NET_TIMEOUT=1500;
var SHELL=['./','./index.html','./app.js','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET'){ return; }
  var url=new URL(req.url);
  if(url.origin!==self.location.origin){ return; }   // 외부 API(시각 등)는 우회
  // network-first(최신 우선) + 강한 캐시 폴백: 오프라인이든 서버 비정상(예: Pages off=404)이든 캐시된 앱으로 구동
  // [D22] 단, 캐시 적중이 있으면 네트워크에 NET_TIMEOUT 만 준다(조용히 버리는 망에서 매달리지 않는다).
  e.respondWith(
    caches.match(req).then(function(hit){
      // 네트워크 시도. 실패·비정상은 null 로 접어 race 를 단순하게 유지한다.
      var net=fetch(req).then(function(res){
        if(res && res.ok){                                // 정상 응답만 캐시·사용
          var copy=res.clone();
          caches.open(CACHE).then(function(c){ try{ c.put(req,copy); }catch(_){} });
          return res;
        }
        return null;                                      // 404 등 비정상 → 캐시로
      }).catch(function(){ return null; });               // 완전 오프라인 → 캐시로

      // 캐시가 없으면 기다릴 수밖에 없다(첫 설치·미캐시 자원).
      if(!hit){
        return net.then(function(res){
          if(res) return res;
          return req.mode==='navigate' ? caches.match('./index.html').then(function(h){
            return h || Response.error();
          }) : Response.error();
        });
      }

      // 캐시가 있으면 상한을 건다. 늦게 도착한 응답도 위 then 에서 캐시에 들어가므로
      // 다음 실행 때 최신본이 뜬다 — 갱신이 유실되는 게 아니라 한 번 미뤄질 뿐이다.
      var timer=new Promise(function(r){ setTimeout(function(){ r(null); },NET_TIMEOUT); });
      return Promise.race([net,timer]).then(function(res){ return res || hit; });
    })
  );
});
