/* HAIR 관찰코딩 · Service Worker · app v1.36 (2026-08-29)
   [D20] CACHE 이름은 app.js 의 APP_VERSION 과 함께 올린다(v1.36 ↔ hair-observer-v39).

   [D26] v1.20 — **cache-first(셸 원자성)**. v1.16~v1.19 의 network-first + 1.5초 상한을 걷어낸다.
   왜 바꾸나: 상한이 **파일마다 따로** 판정되다 보니 index.html 은 캐시(옛 판),
   app.js 는 네트워크(새 판)에서 오는 조합이 실제로 발생했다. 새 JS 가 옛 HTML 의
   없는 엘리먼트를 만져 부팅이 통째로 죽었다.
   지금 구조: 캐시는 install 의 addAll 로만 채워진다. addAll 은 **전부 성공해야 커밋**되므로
   한 캐시에는 언제나 **정합한 셸 한 벌**만 들어 있다. 요청은 그 캐시에서만 답한다
   → 판본이 섞일 수 없다.
   갱신 경로: 브라우저가 sw.js 를 재검증(app.js 가 updateViaCache:'none' 로 등록) →
   CACHE 이름이 바뀌었으면 새 SW 가 새 캐시를 통째로 받고 skipWaiting →
   app.js 의 controllerchange 핸들러가 **세션 중이 아닐 때만** 리로드한다.
   덤: 네트워크를 기다리는 구간이 아예 없다. 병동망이 패킷을 버려도 대기 0초다
   (v1.16 이 1.5초로 줄인 것을 0으로 만든다).

   관찰 데이터는 IndexedDB(캐시와 무관). 시각 엔드포인트 등 외부 API는 항상 네트워크. */
var CACHE='hair-observer-v39';
var SHELL=['./','./index.html','./app.js','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];

/* [D36] v1.30 — `cache.addAll` 은 **브라우저 HTTP 캐시를 그대로 탄다.**
   GitHub Pages 가 `Cache-Control: max-age=600` 이라, 배포 직후 10분 안에 앱을 열면
   새 SW 가 **옛 app.js/index.html 을 캐시에 담아** 판본이 올라가지 않는다
   (실측: v1.29 배포 후 폰이 v1.28 을 받음).
   → `fetch(u,{cache:'reload'})` 로 HTTP 캐시를 우회해 받는다.
   원자성은 유지한다: **전부 받은 뒤에만** put 하므로, 하나라도 실패하면 이 캐시는
   만들어지지 않고 옛 SW 가 계속 산다(= addAll 과 같은 보장). */
self.addEventListener('install',function(e){
  e.waitUntil(
    Promise.all(SHELL.map(function(u){
      return fetch(u,{cache:'reload'}).then(function(r){
        if(!r || !r.ok) throw new Error('shell fetch 실패: '+u);
        return [u,r];
      });
    })).then(function(pairs){
      return caches.open(CACHE).then(function(c){
        return Promise.all(pairs.map(function(p){ return c.put(p[0],p[1]); }));
      });
    }).then(function(){ return self.skipWaiting(); })
  );
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
  e.respondWith(
    caches.match(req).then(function(hit){
      if(hit) return hit;                            // [D26] 셸은 캐시에서만 — 대기 0초
      // 셸에 없는 자원(있다면)만 네트워크로. 성공분은 담아 두되 셸 정합성과는 무관하다.
      return fetch(req).then(function(res){
        if(res && res.ok && res.type==='basic'){
          var copy=res.clone();
          caches.open(CACHE).then(function(c){ try{ c.put(req,copy); }catch(_){} });
        }
        return res;
      }).catch(function(){
        return req.mode==='navigate'
          ? caches.match('./index.html').then(function(x){ return x || Response.error(); })
          : Response.error();
      });
    })
  );
});
