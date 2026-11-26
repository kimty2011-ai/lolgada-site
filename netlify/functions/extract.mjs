// 내전 결과 스크린샷 → 숫자·닉네임 추출 (Claude Haiku) + 하루 업로드 한도
// 챔피언은 브라우저에서 공식 아이콘과 대조하므로 여기서는 읽지 않는다.
import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';

const MODEL = 'claude-haiku-5-5';
const DEFAULT_LIMIT = 10;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// 운영진 확인용: 사이트가 쓰는 공개 Firebase 설정과 같은 값
const FB = { project: 'lolgada2-2c086', apiKey: 'AIzaSyBttN0Ecf3VNx6UwG72AIR6v8T_zkkwPJI', doc: 'lolgadaCenter/season4' };

const int = { type: 'integer' };
const PLAYER = {
  type: 'object', additionalProperties: false,
  required: ['name', 'level', 'kills', 'deaths', 'assists', 'cs', 'gold'],
  properties: { name: { type: 'string' }, level: int, kills: int, deaths: int, assists: int, cs: int, gold: int },
};
const TEAM = {
  type: 'object', additionalProperties: false,
  required: ['kills', 'deaths', 'assists', 'gold', 'players'],
  properties: { kills: int, deaths: int, assists: int, gold: int, players: { type: 'array', items: PLAYER } },
};
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['result', 'duration', 'date', 'highlighted', 'teams'],
  properties: {
    result: { type: 'string' }, duration: { type: 'string' }, date: { type: 'string' },
    highlighted: { type: 'string' }, teams: { type: 'array', items: TEAM },
  },
};
const PROMPT = `This is a League of Legends post-game scoreboard screenshot from the Korean client.
Extract it as JSON:
- result: the big header word exactly as shown (승리 = victory, 패배 = defeat).
- duration: game length shown in the header, mm:ss. date: as shown (YYYY/MM/DD).
- highlighted: the summoner name written in gold/yellow text (the player who took the screenshot). Empty string if none.
- teams: two entries in order: team 1 (top block) then team 2 (bottom block).
  For each team: kills/deaths/assists from the team's header line (e.g. "14 / 4 / 20"), gold = the team total gold in the header (digits only),
  and its 5 players in on-screen order.
- name: the summoner name exactly as shown, including spaces and capitalization.
- level: the number left of the portrait. kills/deaths/assists from the K / D / A column. cs: minions column. gold: gold column, digits only.`;

const kstDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// 운영진 PIN 해시는 사이트 데이터(season4 문서)에 있다
async function pinHashFromFirestore() {
  const url = `https://firestore.googleapis.com/v1/projects/${FB.project}/databases/(default)/documents/${FB.doc}?key=${FB.apiKey}`;
  let r = await fetch(url);
  if (r.status === 401 || r.status === 403) { // 규칙이 로그인을 요구하면 익명 로그인 후 재시도
    const s = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB.apiKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    const tok = (await s.json()).idToken;
    r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  }
  if (!r.ok) return null;
  const raw = (await r.json())?.fields?.json?.stringValue;
  try { return JSON.parse(raw)?.pinHash || null; } catch { return null; }
}
async function isAdmin(hash) {
  if (typeof hash !== 'string' || hash.length < 8) return false;
  try { return hash === (await pinHashFromFirestore()); } catch { return false; }
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST만 가능해요' });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: '요청 형식이 잘못됐어요' }); }

  const store = getStore('upload-limit');
  const cfg = (await store.get('config', { type: 'json' })) || {};
  const limit = Number.isInteger(cfg.limit) ? cfg.limit : DEFAULT_LIMIT;
  const dayKey = 'count-' + kstDay();
  const used = Number(await store.get(dayKey)) || 0;

  if (body.action === 'status') return json(200, { used, limit });
  if (body.action === 'setLimit') {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 0 || n > 500) return json(400, { error: '0~500 사이 숫자로 정해주세요' });
    if (!(await isAdmin(body.adminHash))) return json(403, { error: '운영진만 바꿀 수 있어요' });
    await store.setJSON('config', { limit: n });
    return json(200, { used, limit: n });
  }

  // 스크린샷 인식
  const { image, mediaType } = body;
  if (typeof image !== 'string' || !TYPES.has(mediaType)) return json(400, { error: 'PNG/JPG 이미지만 올릴 수 있어요' });
  if (image.length * 0.75 > MAX_BYTES) return json(413, { error: '이미지가 너무 커요 (5MB 이하)' });

  const admin = body.adminHash ? await isAdmin(body.adminHash) : false;
  if (!admin && used >= limit) return json(429, { error: `오늘 업로드 한도(${limit}장)를 다 썼어요 · 내일 다시 올려주세요`, used, limit });
  if (!admin) await store.set(dayKey, String(used + 1)); // 인식을 시도한 시점에 차감

  try {
    const client = new Anthropic(); // ANTHROPIC_API_KEY (Netlify 환경변수)
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: PROMPT },
      ] }],
    });
    if (res.stop_reason === 'refusal') return json(422, { error: 'AI가 이 이미지를 처리하지 못했어요' });
    if (res.stop_reason === 'max_tokens') return json(502, { error: 'AI 응답이 잘렸어요 · 다시 시도해주세요' });
    const text = res.content.find((b) => b.type === 'text')?.text;
    const data = JSON.parse(text);
    return json(200, { data, used: admin ? used : used + 1, limit });
  } catch (e) {
    if (!admin) await store.set(dayKey, String(used)); // 실패한 시도는 한도에서 되돌림
    const status = e instanceof Anthropic.RateLimitError ? 429 : e instanceof Anthropic.APIError ? 502 : 500;
    console.error(e);
    return json(status, { error: status === 429 ? 'AI 서버가 바빠요 · 잠시 후 다시 시도해주세요' : '인식에 실패했어요 · 다시 시도해주세요' });
  }
};

export const config = { path: '/api/extract' };
