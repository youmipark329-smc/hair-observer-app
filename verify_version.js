/* [D20/C8] 배포 전 버전 정합 점검 — `node verify_version.js`
   app.js 의 APP_VERSION 이 정본이고, 아래 두 곳이 여기서 파생/일치해야 한다.
     · index.html : <span id="verApp"> 의 정적 폴백 텍스트(스크립트 로드 전 표시)
     · sw.js      : var CACHE='hair-observer-vNN'  (버전을 올리면 NN 도 올린다)
   불일치면 exit 1. CI/pre-commit 훅에 걸어 세 곳이 손으로 갈라지는 것을 막는다. */
'use strict';
var EXPECTED_CACHE={'1.13':16,'1.14':17,'1.15':18,'1.16':19,'1.17':20,'1.18':21,'1.19':22,'1.20':23,'1.21':24,'1.22':25,'1.23':26,'1.24':27,'1.25':28,'1.26':29,'1.27':30,'1.28':31,'1.29':32,'1.30':33,'1.31':34,'1.32':35,'1.33':36,'1.34':37};   // 버전 ↔ SW 캐시 번호 정본 매핑
var fs=require('fs'), path=require('path'), d=__dirname;
function read(f){ return fs.readFileSync(path.join(d,f),'utf8'); }
var app=read('app.js'), html=read('index.html'), sw=read('sw.js');
var mApp=app.match(/var\s+APP_VERSION\s*=\s*'([^']+)'/);
var mHtml=html.match(/id="verApp"\s*>\s*([^<]*?)\s*</);
var mSw=sw.match(/var\s+CACHE\s*=\s*'hair-observer-v(\d+)'/);
var errs=[];
if(!mApp) errs.push("app.js: var APP_VERSION='x.y' 를 찾지 못했다");
if(!mHtml) errs.push('index.html: <span id="verApp"> 를 찾지 못했다');
if(!mSw) errs.push("sw.js: var CACHE='hair-observer-vNN' 를 찾지 못했다");
if(!errs.length){
  if(mHtml[1]!==mApp[1]) errs.push('index.html #verApp 폴백 '+JSON.stringify(mHtml[1])+
    ' != app.js APP_VERSION '+JSON.stringify(mApp[1]));
  var expect=EXPECTED_CACHE[mApp[1]];
  if(expect===undefined) errs.push('verify_version.js: APP_VERSION '+mApp[1]+
    ' 에 대응하는 SW 캐시 번호가 EXPECTED_CACHE 에 등록되지 않았다 — 버전을 올렸으면 여기도 등록하라');
  else if(mSw[1]!==String(expect)) errs.push('sw.js CACHE=hair-observer-v'+mSw[1]+
    ' != 기대값 hair-observer-v'+expect+' (APP_VERSION '+mApp[1]+')');
}
if(errs.length){ errs.forEach(function(e){ console.error('FAIL '+e); }); process.exit(1); }
console.log('OK app_version='+mApp[1]+' · index.html fallback='+mHtml[1]+' · sw CACHE=hair-observer-v'+mSw[1]);
