require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8787;
const RAW_SERVICE_KEY = (process.env.SBIZ_SERVICE_KEY || '').trim();
// 공공데이터포털은 Encoding 키(%가 섞인 값)와 Decoding 키(원본 값) 두 가지를 주는데,
// 어떤 걸 넣었는지 몰라도 되게 여기서 한 번 원본 형태로 되돌려 둠 (그래야 요청 시 정확히 한 번만 인코딩됨)
function normalizeServiceKey(key) {
  if (/%[0-9A-Fa-f]{2}/.test(key)) {
    try {
      return decodeURIComponent(key);
    } catch (e) {
      return key;
    }
  }
  return key;
}
const SERVICE_KEY = normalizeServiceKey(RAW_SERVICE_KEY);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!SERVICE_KEY) {
  console.warn('[경고] SBIZ_SERVICE_KEY가 설정되지 않았어요. .env 파일을 확인하세요.');
} else {
  const wasEncoded = RAW_SERVICE_KEY !== SERVICE_KEY;
  console.log(`[정보] 서비스키 인식됨 (길이 ${SERVICE_KEY.length}자, 앞 6글자: ${SERVICE_KEY.slice(0, 6)}...)${wasEncoded ? ' — Encoding 키를 감지해서 자동으로 원본 형태로 변환했어요.' : ''}`);
}

const SEOUL_POP_KEY = (process.env.SEOUL_POP_KEY || '').trim();
if (!SEOUL_POP_KEY) {
  console.warn('[경고] SEOUL_POP_KEY가 설정되지 않았어요 — 실시간 인구 혼잡도 기능은 꺼진 채로 동작해요.');
} else {
  console.log(`[정보] 서울 실시간 인구데이터 키 인식됨 (길이 ${SEOUL_POP_KEY.length}자)`);
}

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));

// -----------------------------------------------------------------------
// 데모용 동네 프리셋 (대략적인 위경도 범위 — 필요하면 더 정밀하게 다듬으세요)
// -----------------------------------------------------------------------
const AREA_BOUNDS = {
  hongdae:  { minx: 126.9180, maxx: 126.9280, miny: 37.5500, maxy: 37.5600 },
  gangnam:  { minx: 127.0230, maxx: 127.0330, miny: 37.4930, maxy: 37.5010 },
  seongsu:  { minx: 127.0480, maxx: 127.0620, miny: 37.5400, maxy: 37.5480 },
  itaewon:  { minx: 126.9880, maxx: 126.9980, miny: 37.5310, maxy: 37.5390 },
  myeongdong:{ minx: 126.9800, maxx: 126.9900, miny: 37.5590, maxy: 37.5660 },
  jamsil:   { minx: 127.0950, maxx: 127.1080, miny: 37.5080, maxy: 37.5160 },
  apgujeong: { minx: 127.0280, maxx: 127.0420, miny: 37.5220, maxy: 37.5300 },
  yeouido:   { minx: 126.9100, maxx: 126.9350, miny: 37.5200, maxy: 37.5300 },
  sinchon:   { minx: 126.9350, maxx: 126.9500, miny: 37.5550, maxy: 37.5620 },
  konkuk:    { minx: 127.0650, maxx: 127.0750, miny: 37.5380, maxy: 37.5450 },
  jongno:    { minx: 126.9850, maxx: 126.9950, miny: 37.5670, maxy: 37.5720 },
  ikseondong:{ minx: 126.9870, maxx: 126.9920, miny: 37.5720, maxy: 37.5760 },
  dongdaemun:{ minx: 127.0070, maxx: 127.0150, miny: 37.5650, maxy: 37.5720 },
  sillim:    { minx: 126.9280, maxx: 126.9350, miny: 37.4820, maxy: 37.4870 },
  sadang:    { minx: 126.9800, maxx: 126.9850, miny: 37.4750, maxy: 37.4800 },
  snu:       { minx: 126.9500, maxx: 126.9550, miny: 37.4800, maxy: 37.4850 },
  yeonnam:   { minx: 126.9200, maxx: 126.9280, miny: 37.5600, maxy: 37.5650 },
};

// -----------------------------------------------------------------------
// 아주 단순한 인메모리 캐시 (TTL 기본 6시간)
// 가게 데이터는 자주 안 바뀌니까, 같은 범위를 계속 호출하지 않게 막아줌
// -----------------------------------------------------------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cacheGet(key, ttl = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}

// -----------------------------------------------------------------------
// 상권정보 API 호출 (사각형 범위 안의 가게 목록, 페이지네이션 처리)
// 문서: 소상공인시장진흥공단_상가(상권)정보_API - storeListInRectangle
// -----------------------------------------------------------------------
const BASE_URL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRectangle';
const MAX_PAGES = 8;       // 안전장치: 한 번 호출에 최대 8페이지(=numOfRows*8건)까지만
const NUM_OF_ROWS = 1000;  // 페이지당 최대 요청 건수

async function fetchStoresInRectangle({ minx, maxx, miny, maxy }) {
  const allItems = [];
  let pageNo = 1;
  let totalCount = Infinity;

  while ((pageNo - 1) * NUM_OF_ROWS < totalCount && pageNo <= MAX_PAGES) {
    const params = new URLSearchParams({
      serviceKey: SERVICE_KEY,
      minx: String(minx),
      maxx: String(maxx),
      miny: String(miny),
      maxy: String(maxy),
      type: 'json',
      numOfRows: String(NUM_OF_ROWS),
      pageNo: String(pageNo),
    });

    const url = `${BASE_URL}?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`상권정보 API 응답 오류: HTTP ${res.status} / 응답 내용: ${bodyText.slice(0, 300)}`);
    }
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // 서비스키가 잘못됐거나 신청이 아직 승인 전이면 API가 XML 에러 메시지를 줄 수 있음
      throw new Error(`상권정보 API가 JSON이 아닌 응답을 줬어요. 서비스키/승인 상태를 확인하세요. 응답 앞부분: ${text.slice(0, 200)}`);
    }

    const body = json?.body;
    if (!body) {
      const header = json?.header;
      throw new Error(`상권정보 API 오류: ${header?.resultMsg || '알 수 없는 오류'} (코드 ${header?.resultCode})`);
    }
    if (json?.header && json.header.resultCode && json.header.resultCode !== '00') {
      throw new Error(`상권정보 API 오류: ${json.header.resultMsg} (코드 ${json.header.resultCode})`);
    }

    // items가 배열로 오거나 {item: [...]} 형태로 오는 두 경우 모두 방어적으로 처리
    let items = body.items;
    if (items && !Array.isArray(items)) items = items.item || [];
    if (!Array.isArray(items)) items = [];

    allItems.push(...items);
    totalCount = Number(body.totalCount) || items.length;
    if (items.length < NUM_OF_ROWS) break; // 마지막 페이지
    pageNo += 1;
  }

  return allItems;
}

// -----------------------------------------------------------------------
// "놀 공간"만 걸러내기: 상권정보에는 부동산·세무사·디자인 사무실 같은 것도
// 다 섞여있어서, 식당/카페/술집/오락 계열만 골라내야 실제로 놀러갈 만한
// 밀집도가 나옴
// -----------------------------------------------------------------------
const FUN_KEYWORDS = [
  '음식', '한식', '중식', '일식', '양식', '분식', '치킨', '패스트푸드', '뷔페',
  '주점', '호프', '요리주점', '이자카야', '와인바', '포장마차', '술집', '펍', '바(',
  '카페', '커피', '베이커리', '제과', '디저트', '전통찻집',
  '클럽', '무도', '유흥',
  '노래', '오락', '게임', 'PC방', '당구장', '볼링장', '스크린골프', '보드게임', '만화방',
  '찜질방', '테마', '관광', '여가',
];

function isFunVenue(it){
  const text = [it.indsLclsNm, it.indsMclsNm, it.indsSclsNm].filter(Boolean).join(' ');
  return FUN_KEYWORDS.some(kw => text.includes(kw));
}

function simplifyCategory(it){
  const text = [it.indsMclsNm, it.indsSclsNm].filter(Boolean).join(' ');
  if (/카페|커피|베이커리|제과|디저트|찻집/.test(text)) return '카페';
  if (/클럽|무도/.test(text)) return '클럽';
  if (/유흥/.test(text)) return '유흥';
  if (/주점|호프|이자카야|와인바|포장마차|펍|바\(/.test(text)) return '술집';
  if (/노래|오락|게임|당구|볼링|PC방|보드게임|만화방/.test(text)) return '오락';
  if (/음식|한식|중식|일식|양식|분식|치킨|패스트푸드|뷔페/.test(text)) return '식당';
  return '기타';
}

// -----------------------------------------------------------------------
// 격자 밀집도 계산: 가게 좌표 목록 -> 작은 칸으로 나눠 칸별 개수 세기
// -----------------------------------------------------------------------
// "서울특별시 마포구 성미산로16길" 같은 긴 주소에서 "성미산로16길"만 뽑아냄
function cleanRoadName(name){
  if (!name) return '';
  return name.replace(/^.*?(시|도)\s+.*?(구|군)\s+/, '').trim();
}

function computeGrid(items, bounds, cellSize) {
  const { minx, maxx, miny, maxy } = bounds;
  const counts = new Map();
  const roadNameCounts = new Map(); // key -> Map(roadName -> count)
  const categoryCounts = new Map(); // key -> Map(category -> count)

  for (const it of items) {
    const lon = Number(it.lon ?? it.longitude ?? it.x);
    const lat = Number(it.lat ?? it.latitude ?? it.y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minx || lon > maxx || lat < miny || lat > maxy) continue;

    const gx = Math.floor((lon - minx) / cellSize);
    const gy = Math.floor((lat - miny) / cellSize);
    const key = `${gx}_${gy}`;
    counts.set(key, (counts.get(key) || 0) + 1);

    const roadName = it.rdnm || it.lnoAdr || '';
    if (roadName) {
      if (!roadNameCounts.has(key)) roadNameCounts.set(key, new Map());
      const m = roadNameCounts.get(key);
      m.set(roadName, (m.get(roadName) || 0) + 1);
    }

    const category = simplifyCategory(it);
    if (!categoryCounts.has(key)) categoryCounts.set(key, new Map());
    const cm = categoryCounts.get(key);
    cm.set(category, (cm.get(category) || 0) + 1);
  }

  const cells = [...counts.entries()].map(([key, count]) => {
    const [gx, gy] = key.split('_').map(Number);
    // 이 칸에서 가장 많이 등장한 도로명을 대표 이름으로 사용
    let roadName = '';
    const rn = roadNameCounts.get(key);
    if (rn) {
      roadName = cleanRoadName([...rn.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    let mainCategory = '';
    const cc = categoryCounts.get(key);
    if (cc) {
      mainCategory = [...cc.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return {
      gx, gy,
      lon: minx + (gx + 0.5) * cellSize,
      lat: miny + (gy + 0.5) * cellSize,
      count,
      roadName,
      mainCategory,
    };
  });

  const maxCount = cells.reduce((m, c) => Math.max(m, c.count), 0);
  // 0~100 스케일 intensity로도 같이 내려줌 (프론트에서 바로 색칠하기 편하게)
  cells.forEach(c => { c.intensity = maxCount ? Math.round((c.count / maxCount) * 100) : 0; });

  return { cells, maxCount, totalStores: items.length };
}

// -----------------------------------------------------------------------
// 라우트
// -----------------------------------------------------------------------
// -----------------------------------------------------------------------
// 서울 실시간 인구데이터 (서울 열린데이터광장, apis.data.go.kr이 아닌
// 완전히 다른 호스트/키 체계를 씀 — 상권정보 API와는 별개)
// -----------------------------------------------------------------------
const POP_CACHE_TTL_MS = 5 * 60 * 1000; // 실제 데이터가 5분마다 갱신되니 그에 맞춤

// 혼잡도 등급을 "평소 대비 배율"로 바꿔서 골목 밀집도에 곱해줄 때 씀
const CONGEST_FACTOR = {
  '여유': 0.7,
  '보통': 1.0,
  '약간 붐빔': 1.3,
  '붐빔': 1.6,
  '매우 붐빔': 1.9,
};

async function fetchPopulation(areaNm) {
  if (!SEOUL_POP_KEY) throw new Error('SEOUL_POP_KEY가 설정되지 않았어요.');

  const cacheKey = `pop:${areaNm}`;
  const cached = cacheGet(cacheKey, POP_CACHE_TTL_MS);
  if (cached) return cached;

  const url = `http://openapi.seoul.go.kr:8088/${SEOUL_POP_KEY}/json/citydata_ppltn/1/5/${encodeURIComponent(areaNm)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' },
  });
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`서울 실시간 인구데이터 응답이 JSON이 아니에요. 응답 앞부분: ${text.slice(0, 200)}`);
  }

  // 응답 최상위 키 이름이 문서마다 조금씩 다르게 소개돼서 방어적으로 찾음
  const rows = json?.['SeoulRtd.citydata_ppltn']
    || json?.['citydata_ppltn']
    || json?.['CITYDATA_PPLTN'];

  if (!Array.isArray(rows) || rows.length === 0) {
    // 에러 응답은 보통 RESULT 코드/메시지를 담고 있음
    const result = json?.['RESULT'] || json?.['SeoulRtd.citydata_ppltn']?.RESULT;
    throw new Error(`서울 실시간 인구데이터 오류: ${result?.MESSAGE || result?.['RESULT.MESSAGE'] || text.slice(0, 200)}`);
  }

  const row = rows[0];
  const congestLevel = row.AREA_CONGEST_LVL || '';
  const parsed = {
    areaNm: row.AREA_NM || areaNm,
    congestLevel,
    congestMsg: row.AREA_CONGEST_MSG || '',
    ppltnMin: Number(row.AREA_PPLTN_MIN) || null,
    ppltnMax: Number(row.AREA_PPLTN_MAX) || null,
    malePct: row.MALE_PPLTN_RATE != null ? Number(row.MALE_PPLTN_RATE) : null,
    femalePct: row.FEMALE_PPLTN_RATE != null ? Number(row.FEMALE_PPLTN_RATE) : null,
    updatedAt: row.PPLTN_TIME || null,
    congestFactor: CONGEST_FACTOR[congestLevel] ?? 1.0,
  };

  cacheSet(cacheKey, parsed);
  return parsed;
}



app.get('/api/density', async (req, res) => {
  try {
    let bounds;
    if (req.query.area) {
      bounds = AREA_BOUNDS[req.query.area];
      if (!bounds) {
        return res.status(400).json({ error: `알 수 없는 area예요. 가능한 값: ${Object.keys(AREA_BOUNDS).join(', ')}` });
      }
    } else {
      const { minx, maxx, miny, maxy } = req.query;
      if (!minx || !maxx || !miny || !maxy) {
        return res.status(400).json({ error: 'area 파라미터를 쓰거나, minx/maxx/miny/maxy를 모두 넘겨주세요.' });
      }
      bounds = { minx: Number(minx), maxx: Number(maxx), miny: Number(miny), maxy: Number(maxy) };
    }

    const cellSize = Number(req.query.cell) || 0.0005; // 대략 50m
    const cacheKey = JSON.stringify({ bounds, cellSize });

    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const allItems = await fetchStoresInRectangle(bounds);
    const items = allItems.filter(isFunVenue);
    const grid = computeGrid(items, bounds, cellSize);
    grid.totalAllStores = allItems.length; // 참고용: 필터링 전 전체 가게 수
    const result = { bounds, cellSize, ...grid, cached: false, fetchedAt: new Date().toISOString() };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/areas', (req, res) => {
  res.json({ areas: Object.keys(AREA_BOUNDS) });
});

app.get('/api/population', async (req, res) => {
  try {
    const areaNm = req.query.area;
    if (!areaNm) {
      return res.status(400).json({ error: 'area 파라미터로 정확한 장소명을 넘겨주세요 (예: 홍대 관광특구).' });
    }
    const data = await fetchPopulation(areaNm);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`오늘어디 프록시 서버 실행 중: http://localhost:${PORT}`);
  console.log(`예시 호출: http://localhost:${PORT}/api/density?area=hongdae`);
});
