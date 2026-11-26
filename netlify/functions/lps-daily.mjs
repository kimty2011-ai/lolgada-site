// 매일 오전 10시(KST) lol.ps 한국 마스터+ 라인별 승률을 받아 Firestore(lolgadaCenter/lps_tier)에 저장한다.
// 사이트는 이 문서를 읽어 챔피언 티어의 참고값으로 쓴다 → 재배포 없이 참고 데이터만 바뀐다.
const FB = { project: 'lolgada2-2c086', apiKey: 'AIzaSyBttN0Ecf3VNx6UwG72AIR6v8T_zkkwPJI', doc: 'lolgadaCenter/lps_tier' };
const LANES = ['TOP', 'JGL', 'MID', 'ADC', 'SUP']; // lol.ps lane 0~4
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; lolgada-tier-bot/1.0)' };

// 최신 패치: 통계 페이지 데이터(SvelteKit __data.json)의 versionInfo 첫 항목
export async function latestVersion() {
  const j = await (await fetch('https://lol.ps/statistics/__data.json', { headers: UA })).json();
  const d = j.nodes.find(n => n?.data?.[0]?.versionInfo != null).data;
  const v = d[d[d[0].versionInfo][0]];
  return { id: d[v.versionId], patch: d[v.description] };
}

export async function fetchLps() {
  const ver = await latestVersion();
  if (!Number.isInteger(ver.id)) throw new Error('lol.ps 패치 정보를 못 읽었어요');
  const lanes = {};
  for (let i = 0; i < LANES.length; i++) {
    const r = await fetch(`https://lol.ps/api/statistics/tierlist.json?region=0&version=${ver.id}&tier=3&lane=${i}`, { headers: UA });
    if (!r.ok) throw new Error(`lol.ps ${LANES[i]} ${r.status}`);
    const rows = (await r.json()).data || [];
    lanes[LANES[i]] = rows.filter(x => x.championInfo?.nameKr && x.winRate != null)
      .map(x => `${x.championInfo.nameKr}:${+x.winRate}:${+x.pickRate}`).join(',');
  }
  // 패치 초반 등으로 데이터가 비면 덮어쓰지 않는다
  if (Object.values(lanes).some(s => s.split(',').length < 20)) throw new Error('lol.ps 데이터가 너무 적어요 — 이번 주는 건너뜀');
  return { patch: ver.patch, version: ver.id, at: Date.now(), lanes };
}

export async function saveLps(data, doc = FB.doc) {
  const s = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB.apiKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  const tok = (await s.json()).idToken;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FB.project}/databases/(default)/documents/${doc}?key=${FB.apiKey}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(data) } } }) });
  if (!r.ok) throw new Error(`Firestore 저장 실패 ${r.status} ${await r.text()}`);
}

export default async () => {
  try {
    const data = await fetchLps(); await saveLps(data);
    console.log('lol.ps 티어 갱신', data.patch, Object.fromEntries(Object.entries(data.lanes).map(([k, v]) => [k, v.split(',').length])));
  } catch (e) { console.error('lol.ps 티어 갱신 실패:', e.message) } // 실패하면 지난주 값을 그대로 쓴다
};

export const config = { schedule: '0 1 * * *' }; // UTC 매일 01:00 = KST 매일 10:00
