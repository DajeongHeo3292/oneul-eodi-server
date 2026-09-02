# 오늘어디 프록시 서버

소상공인시장진흥공단 상권정보 API를 대신 호출해서, 특정 동네의 가게 좌표를
50m 격자로 묶어 "어느 칸(=대략 어느 골목)에 가게가 몰려있는지" 계산해주는
작은 서버예요.

## 1. 로컬에서 실행해보기

```bash
npm install
cp .env.example .env
```

`.env` 파일을 열어서 `SBIZ_SERVICE_KEY`에 공공데이터포털에서 받은 서비스키를
붙여넣으세요. **"일반 인증키(Decoding)"** 값을 넣어야 해요 (Encoding 값을
넣으면 키가 두 번 인코딩돼서 오류가 나요).

```bash
npm start
```

브라우저나 curl로 확인:

```bash
curl "http://localhost:8787/api/density?area=hongdae"
```

정상이면 이런 형태의 JSON이 와요:

```json
{
  "bounds": { "minx": 126.918, "maxx": 126.928, "miny": 37.55, "maxy": 37.56 },
  "cellSize": 0.0005,
  "cells": [
    { "gx": 4, "gy": 4, "lon": 126.9203, "lat": 37.5522, "count": 38, "intensity": 100 },
    { "gx": 5, "gy": 4, "lon": 126.9208, "lat": 37.5522, "count": 12, "intensity": 31 }
  ],
  "maxCount": 38,
  "totalStores": 812,
  "fetchedAt": "2026-09-01T12:00:00.000Z"
}
```

`intensity`가 0~100 값이라, 지금 oneul-eodi.html의 혼잡도 색상 로직에
그대로 꽂을 수 있어요.

## 2. 직접 범위 지정하기

`area` 파라미터 대신 좌표 범위를 직접 줄 수도 있어요:

```
GET /api/density?minx=126.918&maxx=126.928&miny=37.55&maxy=37.56&cell=0.0005
```

## 3. 미리 등록된 동네 (`area` 파라미터)

`hongdae`, `gangnam`, `seongsu`, `itaewon`, `myeongdong`, `jamsil`

이 범위들은 **대략적인 값**이에요. 실제로 써보면서 너무 넓거나 좁으면
`server.js`의 `AREA_BOUNDS`에서 숫자를 직접 조정하세요.

## 4. 캐싱

같은 범위를 계속 부르면 상권정보 API를 매번 호출하게 되니, 서버 메모리에
6시간 동안 결과를 캐싱해요 (가게 데이터는 하루 안에 자주 바뀌지 않으니
충분해요). 서버를 재시작하면 캐시는 초기화돼요 — 트래픽이 많아지면
Redis 같은 외부 캐시로 바꾸는 걸 고려하세요.

## 5. 배포하기

Render, Railway, Fly.io 같은 곳에 무료/저가로 올릴 수 있어요. 공통 순서:

1. 이 폴더를 GitHub 저장소로 올리기
2. Render/Railway에서 "New Web Service" → 그 저장소 연결
3. Start Command: `npm start`
4. 환경변수에 `SBIZ_SERVICE_KEY`, `ALLOWED_ORIGIN`(오늘어디 사이트 주소) 등록
5. 배포되면 `https://oneul-eodi-server.onrender.com` 같은 주소가 생김

이 주소를 oneul-eodi.html의 지도 코드에서 fetch하도록 연결하면 실제 데이터가
들어와요. 배포되면 알려주시면 그 연결 코드도 바로 만들어드릴게요.

## 참고: 아직 확인 못 한 부분

상권정보 API 응답의 정확한 필드 구조는 공식 문서와 커뮤니티 자료를 참고해서
작성했지만, 이 환경에서는 네트워크 접근이 막혀 있어 실제 응답으로 직접
테스트하지는 못했어요. `server.js`의 `fetchStoresInRectangle` 함수가
JSON 파싱이나 필드명(`lon`/`lat`)이 다르면 에러 메시지에 응답 앞부분을
같이 출력하도록 해뒀으니, 처음 실행했을 때 에러가 나면 그 메시지를
공유해주세요 — 바로 고쳐드릴게요.
