/* HAIR 관찰코딩 · Service Worker · app v1.14 (2026-08-27)
   [D20] CACHE 이름은 app.js 의 APP_VERSION 과 함께 올린다(v1.14 ↔ hair-observer-v17).
   전략: 앱 셸(HTML/JS/매니페스트/아이콘)은 network-first — 온라인이면 항상 최신,
   오프라인이면 캐시로 폴백. → 앱을 갱신·재배포하면 다음 접속 시 자동 반영(옛 버전 고착 방지).
   관찰 데이터는 IndexedDB(캐시와 무관). 시각 엔드포인트 등 외부 API는 항상 네트워크. */
var CACHE='hair-observer-v17';
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
  e.respondWith(
    fetch(req).then(function(res){
      if(res && res.ok){                                  // 정상 응답만 캐시·사용
        var copy=res.clone();
        caches.open(CACHE).then(function(c){ try{ c.put(req,copy); }catch(_){} });
        return res;
      }
      // 비정상 응답(404 등) → 캐시 폴백(내비게이션은 index.html)
      return caches.match(req).then(function(hit){
        return hit || (req.mode==='navigate' ? caches.match('./index.html') : res);
      });
    }).catch(function(){
      // 네트워크 실패(완전 오프라인) → 캐시
      return caches.match(req).then(function(hit){ return hit || caches.match('./index.html'); });
    })
  );
});
