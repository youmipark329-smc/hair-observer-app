# HAIR 병동 행동 관찰코딩 앱 (PWA) — 설치·호스팅 안내 · v1.2 · 2026-08-26

> **정체:** 실제로 갤럭시에서 구동되는 **설치형 웹앱(PWA)**. 관찰자가 4-상태(LIE/SIT/STD/WLK)만
> 태핑하면 전환·bed-exit·체류시간이 자동 도출되고, 서버시각 동기·오프라인 저장·CSV 내보내기까지
> 됩니다. **무 PII**(익명 ID `patient_id` 만 입력 — 씨어스 `measurement_code` 가 아닙니다) · 폰의 IMU 센서는 쓰지 않습니다(그건 씨어스 패치/서버 몫).
>
> **검증 완료(2026-08-14):** 세션 시작→상태전이→bed-exit 자동→맥락 잠금→움직임(in_bed_move)→
> 세션요약→IndexedDB 영구저장→CSV 23컬럼 산출, 시각동기 DEVICE/OK 두 경로, ⏱ 동기마커(#8),
> manifest·service worker·아이콘 3종·SW 등록까지 모두 통과.

---

## 1. 구성 파일
```
observer_app_pwa_20260814/
├─ index.html               # 앱 화면(모바일 전체화면 UI)
├─ app.js                   # 로직: 시각동기·IndexedDB·코딩·요약·CSV
├─ manifest.webmanifest     # 설치 메타(이름·아이콘·standalone)
├─ sw.js                    # 서비스워커(오프라인 앱셸 캐시)
├─ icons/                   # 아이콘 192·512·maskable-512 (PNG)
└─ 20260826_README_설치_호스팅_안내.md
```

## 2. 갤럭시에 올리는 방법 — 3가지 (택1)

> **저장소명 변경(2026-08-26):** 연구 애칭 통일에 따라 `beacon-observer-app` → **`hair-observer-app`** 으로 변경.
> 배포 전·수집 데이터 없음을 확인하고 수행했으며, 앱 내부 식별자도 함께 변경(IndexedDB `hair_observer`, SW 캐시 `hair-observer-v18` — 현재값(앱 v1.15). 버전을 올릴 때는 `app.js`(APP_VERSION)·`index.html`(#verApp 폴백)·`sw.js`(CACHE) 세 곳을 함께 바꾸고 `node verify_version.js` 로 확인한다).
> **QR·포스터·퀵가이드는 새 주소로 재생성 완료**(구 QR 파일은 삭제). 구 주소로 만든 인쇄물이 있으면 폐기하세요.
>
> **배포 현황 (2026-08-14):** GitHub Pages 공개 저장소 `youmipark329-smc/hair-observer-app`
> (main/root)로 **배포·라이브 검증까지 완료**(주소 `https://youmipark329-smc.github.io/hair-observer-app/`,
> service worker 제어·오프라인 설치 확인). 이후 **웹주소는 임시 비활성(Pages 비활성화)** 한 상태 —
> **저장소·파일·소스는 그대로 보존**. 파일럿 등에서 필요할 때 **Pages를 다시 켜면 같은 주소로 즉시 복구**됩니다
> (gh: `gh api -X POST repos/youmipark329-smc/hair-observer-app/pages -f "source[branch]=main" -f "source[path]=/"`).
> 이미 설치된 폰의 앱·데이터(IndexedDB)는 주소 비활성과 무관하게 유지됩니다.
> **앱 업데이트:** service worker가 **network-first(v2)** 라, 소스를 고쳐 재호스팅하면
> 설치된 기기도 **다음 온라인 실행 시 자동으로 최신본**을 받습니다(옛 버전 고착 없음). 오프라인이면 마지막 캐시로 동작.

PWA는 **HTTPS 주소로 열어야** "홈 화면에 추가 + 오프라인 설치"가 됩니다.

### 방법 A — GitHub Pages (무료·권장, 무 PII라 공개 저장소 OK)
1. GitHub 계정으로 새 저장소 생성 → 이 폴더의 **파일 6종(+icons)** 업로드.
2. 저장소 **Settings → Pages → Branch: main / root** 선택 → 저장.
3. 몇 분 뒤 `https://<계정>.github.io/<저장소>/` 주소가 생김.
4. **갤럭시 크롬**에서 그 주소 열기 → 아래 3절대로 설치.

### 방법 B — Netlify Drop (계정 후 폴더 드래그)
1. `app.netlify.com/drop` 접속 → 이 폴더를 통째로 드래그.
2. 즉시 `https://<랜덤>.netlify.app` 주소 발급 → 갤럭시에서 열기.

### 방법 C — 병원 인트라넷/사내 정적 호스팅
- 병원 IT가 관리하는 웹 서버(HTTPS)에 파일을 그대로 올림. 폐쇄망이라도
  **HTTPS면 설치·오프라인 동작**. (시각 엔드포인트를 쓰려면 4절 참고.)

> **바로 테스트만:** PC에서 `index.html`을 브라우저로 열거나
> `python -m http.server -d observer_app_pwa_20260814` 로 띄우면 기능은 다 되지만,
> "홈 화면 설치·오프라인"은 HTTPS(또는 localhost)에서만 됩니다.

## 3. 홈 화면에 설치 (갤럭시 크롬)
1. 위 주소를 **크롬**으로 연다.
2. 우상단 **⋮ 메뉴 → "홈 화면에 추가"**(또는 하단에 뜨는 "앱 설치" 배너) 탭.
3. 홈 화면에 **HAIR 관찰** 아이콘 생성 → 탭하면 **주소창 없는 전체화면 앱**으로 실행.
4. 이후 오프라인(와이파이 끊김)에서도 실행·기록되고, 데이터는 폰에 남습니다.

## 4. 시각동기 설정 (⚙ 설정)
- **비워두면(기본):** 폰의 **기기 시계**(안드로이드 "자동 날짜·시각" = 외부망 NTP 동기)를 사용,
  오프셋 0·`sync_flag=DEVICE`로 기록. 외부망 갤럭시라면 이미 UTC에 맞춰져 있어 목표 <250ms 충족.
- **서버 엔드포인트 입력 시:** 앱이 **앱 시작·60초마다·앱 복귀 시** 그 주소로 서버시각을 받아
  **오프셋 + 왕복지연(rtt/2)** 을 계산(Cristian) → `sync_flag=OK`. thynC와 동일 기준시계에 맞추려면
  **연구서버가 삼성 NTP에 동기**돼 있고 `GET /time`이 아래 중 하나를 반환하면 됩니다:
  - JSON: `{ "now": <epoch_ms> }` (권장, ms 정밀) — 또는 `epoch_ms`/`server_time`/`t` 키
  - 또는 표준 **HTTP `Date` 헤더**(초 정밀, 폴백)
  - **CORS 허용 필요**(`Access-Control-Allow-Origin`), HTTPS 권장.
- 모든 이벤트는 **단조시계(performance.now) 앵커** 로 계산되어, 백그라운드에서 벽시계가 튀어도
  세션 내 경과시간이 어긋나지 않습니다. 저장 컬럼: `t_server_start/end`(ISO ms)·`clock_offset_ms`·`sync_flag`.

## 5. 데이터·CSV
- **컬럼(23):** ModeA 코딩시트 17컬럼(`record_id … motion_detail`) + 결합/메타 6컬럼
  (`t_server_start`,`t_server_end`,`clock_offset_ms`,`sync_flag`,`session_id`,`device_serial`).
  `record_id`는 **이벤트 생성 시점에 고정**(undo 후에도 불변) → 서버 재적재 시 `(session_id, record_id)` 로 **멱등(중복0)**.
  `device_serial`(패치 시리얼)은 세션 시작화면 ★필드에서 입력(등록연계, RFP §6-5).
- **`⏱ 동기마커`(v1.1):** 코딩화면 버튼. 패치를 툭툭 두드리는 순간 함께 탭하면 `code=sync_marker` 순간행 기록
  (`t_server`·`clock_offset_ms`·`sync_flag` 포함). **시각정합 #8 실측용** — 서버 IMU 스파이크와 페어링해 폰–서버 시각차 산출(파일럿 SOP §4). `"→"` 미포함이라 κ·정렬 스크립트는 자동 무시.
- **내보내기:** 세션 종료 요약 화면의 **CSV 저장**, 또는 시작화면 **전체 CSV 내보내기**(모든 세션 1파일),
  또는 지난 세션 목록의 **CSV** 버튼(세션별). UTF-8 BOM·CRLF(엑셀 호환).
- **결합:** 서버에서 `patient_id` → (㉠ 연결로그) → `measurement_code` + `t_server`(±매칭창)로
  **행동 스트림 × 부정맥 알람 로그 × 오알람 판정** 3-way. 오알람 true/false 판정은 병원 차트리뷰(제3 의료진)이며 앱/씨어스 대상 아님.
- **무 PII:** 실명·등록번호·주민번호·연락처·생년월일 등은 **입력 금지**. 익명 ID만.
- **(v1.15) ID 입력 규율:** 관찰자 ID 는 `OBS-01`…`OBS-10` **드롭다운**(실명·이니셜 금지 — 대응표는 위임 로그).
  환자 익명 ID 는 `P-16E-001` 형식만 통과하며 소문자는 자동 대문자화됩니다. 씨어스 `measurement_code`
  (예 `STUDY_2607221311_71K6`)는 관찰 시점에 **아직 발급되지 않은 값**이라 여기 입력하지 않습니다.
- **(v1.15) 이중코딩(κ):** 두 관찰자가 같은 환자를 동시에 코딩할 때만 시작화면에서 **[예]** 를 고릅니다
  (CSV `dual_code=1`). **근무 교대는 [아니오]** — 교대는 이어붙이고 이중코딩은 대조하므로 분석이 정반대입니다.

## 6. 사양 근거 / 연계
- 앱 사양서 `20260827_ward_observer_app_spec_v3.md` §4.4(시각동기)·§S2(단일 코딩)·§S4(요약).
- 시각정합 `20260814_시각정합_상세사양_v3.md`(단조앵커·`/v1/time` 계약·flag 규칙).
- κ(이중관찰)는 앱 밖 서버(`dual_observer_kappa.py`) 산출 — 앱은 각자 일반 코딩 후 CSV만 내보냄.

## 7. 한계 (정직 고지)
- 브라우저 기반이라 **UDP NTP 직접 질의는 불가** → HTTP `/time` 폴링으로 대체(사양이 허용한 방식).
  절대 오프셋 정밀도는 서버 엔드포인트 유무·응답 정밀도(JSON ms vs Date 초)에 좌우됨 → 파일럿 실측으로 확정.
- iOS 사파리는 PWA 지원이 제한적(백그라운드·저장). **안드로이드 크롬 기준** 설계.
- 실제 배포 전 **파일럿에서 폰–서버 시각차 실측**으로 매칭창을 확정할 것.
