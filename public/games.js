'use strict';
/* =========================================================
   📊 내전 통계 — 결과창 스크린샷 업로드 → 자동 집계
   - 숫자·닉네임: 서버 함수(/api/extract, Claude Haiku)
   - 챔피언: 브라우저에서 라이엇 공식 아이콘과 픽셀 대조
   - 저장: Firestore  lolgadaCenter/season4_games/{games,shots,ids}
   index.html 의 전역(S, fb, render, modal, toast, esc, ACT, CHG …)을 그대로 쓴다.
   ========================================================= */
const G_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
const FB_DOC_G = ['lolgadaCenter', G_DEV ? 'season4_games_dev' : 'season4_games']; // 로컬 테스트는 별도 문서
const G_API = '/api/extract';
const G_TYPES = { casual: '🎮 일반 내전', team: '🏆 팀대항전' };
// filter/season/pos: 통계 탭 (기본: 이번 시즌 일반 내전) · rf/rseason: 기록 탭
const GM = { games: [], ids: {}, got: false, filter: 'casual', season: 'cur', pos: 'ALL', view: 'rank', sel: null, sort: 'wr', dir: -1, csort: 'tier', cdir: -1, pq: '', cq: '', rf: 'all', rseason: 'cur', quota: null, unsub: [] };
let GUP = null; // 업로드/수정 진행 상태

/* ---------- 이름 정규화 · 연결 ---------- */
const nkey = s => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
const idDocId = k => encodeURIComponent(k).slice(0, 700);
function jamo(s) {
  let o = '';
  for (const ch of nkey(s)) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) o += String.fromCharCode(0x1100 + (c / 588 | 0), 0x1161 + ((c % 588) / 28 | 0)) + (c % 28 ? String.fromCharCode(0x11a7 + c % 28) : '');
    else o += ch;
  }
  return o;
}
function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// AI가 읽은 닉네임 → {rid(저장할 이름), link(기존 연결), how}
function resolveName(read) {
  const k = nkey(read);
  if (GM.ids[k]) return { rid: GM.ids[k].name, how: 'exact' };
  // 비교 대상: 연결된 ID + 이미 저장된 경기에 나온 ID (unknown 포함)
  const pool = new Map(Object.entries(GM.ids).map(([kk, v]) => [kk, v.name]));
  GM.games.forEach(g => g.teams.forEach(t => t.players.forEach(p => { const kk = nkey(p.rid); if (!pool.has(kk)) pool.set(kk, p.rid) })));
  if (pool.has(k)) return { rid: pool.get(k), how: 'exact' };
  const j = jamo(read); let best = null, bestD = 1e9, tie = false;
  for (const name of pool.values()) {
    const d = lev(j, jamo(name));
    if (d < bestD) { best = name; bestD = d; tie = false } else if (d === bestD) tie = true;
  }
  if (best && !tie && bestD <= Math.max(1, Math.min(3, Math.round(j.length * 0.25)))) return { rid: best, how: 'fuzzy', from: read };
  return { rid: String(read).trim(), how: 'none' };
}
const linkOf = rid => GM.ids[nkey(rid)] || null;
// 저장된 경기의 한 줄 → 멤버 (number id) | 'guest' | null(unknown)
function memberOf(rid) {
  const l = linkOf(rid); if (!l) return null;
  if (l.mid === 'guest') return 'guest';
  return player(l.mid) ? l.mid : null;
}

/* ---------- 챔피언 아이콘 대조 ---------- */
const CHAMP = { p: null, v: '', list: [], byId: {}, icons: [] };
function champLoad() {
  return CHAMP.p || (CHAMP.p = (async () => {
    const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    const data = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/ko_KR/champion.json`)).json()).data;
    CHAMP.v = v;
    CHAMP.list = Object.values(data).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    CHAMP.list.forEach(c => CHAMP.byId[c.id] = c);
    const cv = document.createElement('canvas'); cv.width = cv.height = 120; const cx = cv.getContext('2d', { willReadFrequently: true });
    CHAMP.icons = await Promise.all(CHAMP.list.map(c => new Promise(res => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { cx.clearRect(0, 0, 120, 120); cx.drawImage(im, 0, 0, 120, 120); res({ id: c.id, px: cx.getImageData(0, 0, 120, 120).data }) };
      im.onerror = () => res(null);
      im.src = champImg(c.id);
    })));
    CHAMP.icons = CHAMP.icons.filter(Boolean);
    return CHAMP;
  })().catch(e => { CHAMP.p = null; throw e }));
}
const champImg = id => `https://ddragon.leagueoflegends.com/cdn/${CHAMP.v || '16.23.1'}/img/champion/${encodeURIComponent(id)}.png`;
const champName = id => CHAMP.byId[id]?.name || id || '?';

// 결과창 초상화(금색 테두리 원) 10개 찾기
function findPortraits(px, W, H) {
  const gold = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) { const r = px[p], g = px[p + 1], b = px[p + 2]; gold[i] = r > 110 && g > 80 && r > b + 45 && g > b + 20 ? 1 : 0 }
  const N = 48, cos = [], sin = []; for (let a = 0; a < N; a++) { cos.push(Math.cos(a * 2 * Math.PI / N)); sin.push(Math.sin(a * 2 * Math.PI / N)) }
  const rMin = Math.max(8, Math.round(H / 586 * 11)), rMax = Math.max(rMin + 4, Math.round(H / 586 * 19));
  const x0 = Math.round(W * 0.03), x1 = Math.round(W * 0.3), y0 = Math.round(H * 0.2);
  const cand = [];
  for (let r = rMin; r <= rMax; r++) for (let cy = y0 + r; cy < H - r; cy++) for (let cx = x0 + r; cx < x1; cx++) {
    let s = 0; for (let a = 0; a < N; a++) s += gold[(cy + Math.round(r * sin[a])) * W + cx + Math.round(r * cos[a])];
    if (s >= N * 0.6) cand.push({ cx, cy, r, s: s / N + r * 0.002 }); // 같은 점수면 큰 원(바깥 테두리)
  }
  cand.sort((a, b) => b.s - a.s);
  const out = [];
  for (const c of cand) { if (out.every(o => Math.hypot(o.cx - c.cx, o.cy - c.cy) > o.r * 1.6)) out.push(c); if (out.length === 10) break }
  if (out.length < 10) return null;
  return out.sort((a, b) => a.cy - b.cy);
}
// 초상화 하나하나를 173개 아이콘과 비교
function matchChamps(px, W, rings) {
  const r = Math.round(rings.reduce((s, x) => s + x.r, 0) / rings.length), rin = r - 3.5;
  const offs = []; for (let dy = -Math.floor(rin); dy <= rin; dy++) for (let dx = -Math.floor(rin); dx <= rin; dx++) if (dx * dx + dy * dy <= rin * rin) offs.push([dx, dy]);
  const zooms = [0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3];
  const bil = (d, x, y, ch) => { const x0 = Math.max(0, Math.min(118, Math.floor(x))), y0 = Math.max(0, Math.min(118, Math.floor(y))), fx = x - x0, fy = y - y0, g = (xx, yy) => d[(yy * 120 + xx) * 4 + ch];
    return g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy };
  const tpl = CHAMP.icons.map(ic => zooms.map(z => { const k = 120 / (2 * r * z), a = new Float32Array(offs.length * 3);
    offs.forEach(([dx, dy], i) => { for (let ch = 0; ch < 3; ch++) a[i * 3 + ch] = bil(ic.px, 60 + dx * k - 0.5, 60 + dy * k - 0.5, ch) }); return a }));
  return rings.map(({ cx, cy }) => {
    const bases = []; // 초상화 위치를 ±1px 흔들어 본다
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) bases.push(Float32Array.from(offs.flatMap(([dx, dy]) => { const b = ((cy + dy + oy) * W + cx + dx + ox) * 4; return [px[b], px[b + 1], px[b + 2]] })));
    const sc = CHAMP.icons.map((ic, ii) => {
      let best = 1e9;
      for (const p of bases) for (const t of tpl[ii]) { let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - t[i]); if (s < best) best = s }
      return { id: ic.id, s: best / (offs.length * 3) };
    }).sort((a, b) => a.s - b.s);
    return { id: sc[0].id, sure: sc[0].s < sc[1].s * 0.75 };
  });
}
async function detectChamps(file) {
  await champLoad();
  const url = URL.createObjectURL(file);
  try {
    const im = new Image(); im.src = url; await im.decode();
    const W = im.naturalWidth, H = im.naturalHeight, c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
    const px = x.getImageData(0, 0, W, H).data, rings = findPortraits(px, W, H);
    return rings ? matchChamps(px, W, rings) : null;
  } finally { URL.revokeObjectURL(url) }
}

/* ---------- 서버 함수 ---------- */
async function fileToB64(file) {
  let blob = file, type = file.type;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type) || file.size > 3.5 * 1048576) { // 큰 이미지는 JPEG로
    const url = URL.createObjectURL(file);
    try { const im = new Image(); im.src = url; await im.decode(); const k = Math.min(1, 2000 / im.naturalWidth);
      const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); type = 'image/jpeg' }
    finally { URL.revokeObjectURL(url) }
  }
  const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob) });
  return { b64, type };
}
async function gApi(body) {
  const r = await fetch(G_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, adminHash: isAdmin() ? S.pinHash : undefined }) });
  let d = null; try { d = await r.json() } catch (_) {}
  if (!r.ok) { if (d && d.limit != null) GM.quota = { used: d.used, limit: d.limit }; throw new Error(d?.error || `서버 오류 (${r.status})`) }
  if (d && d.limit != null) GM.quota = { used: d.used, limit: d.limit };
  return d;
}
const gTabOpen = () => ['home', 'stats', 'records', 'members', 'sheet'].includes(UI.tab) && M.classList.contains('hidden');
const refreshQuota =() => gApi({ action: 'status' }).then(() => gTabOpen() && render()).catch(() => {});

/* ---------- Firestore ---------- */
const gCol = name => fb.fs.collection(fb.db, FB_DOC_G[0], FB_DOC_G[1], name);
const gDoc = (name, id) => fb.fs.doc(fb.db, FB_DOC_G[0], FB_DOC_G[1], name, id);
function startGamesSync() {
  stopGamesSync();
  const { fs } = fb;
  GM.unsub.push(fs.onSnapshot(gCol('games'), snap => {
    GM.games = snap.docs.map(d => normGame({ ...d.data(), id: d.id })).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);
    GM.got = true; if (gTabOpen()) render();
  }, e => console.error('games sync', e)));
  GM.unsub.push(fs.onSnapshot(gCol('ids'), snap => {
    const ids = {}; snap.docs.forEach(d => { const v = d.data(); if (v && v.name) ids[nkey(v.name)] = { name: String(v.name), mid: v.mid === 'guest' ? 'guest' : Number(v.mid) } });
    GM.ids = ids; if (gTabOpen()) render();
  }, e => console.error('ids sync', e)));
  // 👥 멤버 구성: 일반 내전용 티어·주라인·부라인 (members.js)
  GM.unsub.push(fs.onSnapshot(gCol('roster'), snap => {
    const r = {}; snap.docs.forEach(d => { const v = d.data() || {}; r[Number(d.id)] = { tier: v.tier || '', main: v.main || '', sub: v.sub || '' } });
    GM.roster = r; if (gTabOpen()) render();
  }, e => console.error('roster sync', e)));
  // lol.ps 참고 승률 — 매일 오전 10시 netlify/functions/lps-daily.mjs가 갱신
  GM.unsub.push(fs.onSnapshot(fs.doc(fb.db, 'lolgadaCenter', G_DEV ? 'lps_tier_dev' : 'lps_tier'), d => {
    try { const v = JSON.parse(d.data()?.json || 'null'); if (v?.lanes) { G_LPS = v.lanes; G_LPS_PATCH = v.patch || G_LPS_PATCH; G_LPS_AT = v.at || 0; G_LPM = null; if (gTabOpen()) render() } } catch (_) {}
  }, e => console.error('lps sync', e)));
}
function stopGamesSync() { GM.unsub.forEach(u => { try { u() } catch (_) {} }); GM.unsub = [] }
const int0 = v => Math.max(0, Math.round(+v || 0));
function normGame(g) {
  if (!g || !Array.isArray(g.teams) || g.teams.length !== 2) return null;
  const date = String(g.date || '');
  return { id: String(g.id), type: g.type === 'team' ? 'team' : 'casual', date, dur: String(g.dur || ''), win: g.win === 2 ? 2 : 1, at: +g.at || 0, src: g.src === 'naejeon' ? 'naejeon' : '',
    season: Number.isInteger(+g.season) && +g.season > 0 ? +g.season : seasonOf(date),
    teams: g.teams.map(t => ({ k: int0(t.k), d: int0(t.d), a: int0(t.a), gold: int0(t.gold),
      players: (t.players || []).slice(0, 5).map(p => ({ rid: String(p.rid || ''), champ: String(p.champ || ''), pos: G_POS.includes(p.pos) ? p.pos : '', lv: int0(p.lv), k: int0(p.k), d: int0(p.d), a: int0(p.a), cs: int0(p.cs), gold: int0(p.gold) })) })) };
}
/* ---------- 시즌 · 포지션 ---------- */
const G_POS = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];
const posLabel = k => PK[k] ? `${PK[k].e} ${PK[k].n}` : '–';
// 시즌 = 경기 날짜의 달 (index.html seasonNo: 2026년 8월 = 시즌1, 내전롤과 같음)
const curSeason = () => seasonNo(autoMeta().start);
const seasonOf = date => seasonNo(date);
const seasonName = n => n === 'all' ? '통합 (전 시즌)' : `시즌 ${n}`;
const gSeasonList = () => [...new Set([curSeason(), ...GM.games.map(g => g.season)])].sort((a, b) => b - a);
const gSeasonSel = () => GM.season === 'cur' ? curSeason() : GM.season;
// 통계용 경기: 시즌 + 경기 종류
const gFiltered = () => { const s = gSeasonSel(); return GM.games.filter(g => (s === 'all' || g.season === s) && (GM.filter === 'all' || g.type === GM.filter)) };
// 업로드 검토: 챔피언별로 지금까지 많이 간 포지션 + 낮은 CS는 서폿으로 추측
function gGuessPos(players, sec) {
  const freq = {}; GM.games.forEach(g => g.teams.forEach(t => t.players.forEach(p => { if (!p.pos || !p.champ) return; (freq[p.champ] = freq[p.champ] || {})[p.pos] = (freq[p.champ]?.[p.pos] || 0) + 1 })));
  const score = (p, pos) => { const f = freq[p.champ] || {}, tot = G_POS.reduce((s, k) => s + (f[k] || 0), 0); let v = Math.log(((f[pos] || 0) + 0.3) / (tot + 1.5));
    const csm = sec ? p.cs / (sec / 60) : p.cs / 25; if (pos === 'SUP') v += csm < 2.5 ? 2 : -2; else if (csm < 2.5) v -= 2; return v };
  let best = null, bestV = -1e9; const perm = (arr, used) => { if (arr.length === players.length) { const v = arr.reduce((s, pos, i) => s + score(players[i], pos), 0); if (v > bestV) { bestV = v; best = [...arr] } return }
    for (const k of G_POS) if (!used.has(k)) { used.add(k); arr.push(k); perm(arr, used); arr.pop(); used.delete(k) } };
  perm([], new Set()); return best || players.map(() => '');
}

/* ---------- 업로드 흐름 ---------- */
function gOpenUpload(files) {
  if (!fb || !fb.fs) return toast('서버(Firebase)에 연결돼 있어야 올릴 수 있어요', 'err');
  files = [...files].filter(f => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return toast('이미지 파일만 올릴 수 있어요', 'err');
  if (files.length > 10) return toast('한 번에 10장까지 올릴 수 있어요', 'err');
  GUP = { queue: files, n: files.length, i: 0, mode: 'new', draft: null, step: 'read', err: '', busy: false };
  gNext();
}
async function gNext() {
  const u = GUP; if (!u) return;
  const file = u.queue[u.i];
  u.step = 'read'; u.err = ''; u.file = file; u.thumb = await makeThumb(file); u.draft = null; gModal();
  try {
    const [ai, champs] = await Promise.all([fileToB64(file).then(({ b64, type }) => gApi({ image: b64, mediaType: type })), detectChamps(file).catch(e => { console.error(e); return null })]);
    if (GUP !== u) return;
    u.draft = draftFrom(ai.data, champs); u.step = 'edit';
  } catch (e) { console.error(e); if (GUP !== u) return; u.step = 'err'; u.err = e.message || String(e) }
  gModal();
}
function draftFrom(d, champs) {
  const date = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(d.date || ''); const today = new Date(kstToday()).toISOString().slice(0, 10);
  const teams = [0, 1].map(ti => {
    const t = d.teams?.[ti] || {};
    return { k: int0(t.kills), d: int0(t.deaths), a: int0(t.assists), gold: int0(t.gold),
      players: [0, 1, 2, 3, 4].map(pi => { const p = t.players?.[pi] || {}, ch = champs?.[ti * 5 + pi];
        const res = resolveName(p.name || '');
        const same = linkOf(res.rid) ? null : S.players.find(m => nkey(m.name) === nkey(res.rid) || nkey(m.name) === nkey(p.name)); // 사이트 닉네임과 같으면 미리 골라 둠
        return { read: String(p.name || ''), rid: res.rid, how: res.how, pick: same ? String(same.id) : '', champ: ch?.id || '', sure: !!ch?.sure,
          lv: int0(p.level), k: int0(p.kills), d: int0(p.deaths), a: int0(p.assists), cs: int0(p.cs), gold: int0(p.gold) } }) };
  });
  // 노란 글씨(캡처한 사람)가 속한 팀 기준으로 승리 팀 결정
  let hi = 0; const hk = jamo(d.highlighted || '');
  if (hk) { let best = 1e9; teams.forEach((t, ti) => t.players.forEach(p => { const dd = lev(hk, jamo(p.read)); if (dd < best) { best = dd; hi = ti + 1 } })); if (best > 3) hi = 0 }
  const won = /승리/.test(d.result || '') ? true : /패배/.test(d.result || '') ? false : null;
  const win = hi && won != null ? (won ? hi : 3 - hi) : 0;
  const dm = /(\d{1,2})\s*(?:[:：]|분)\s*(\d{2})/.exec(d.duration || '');
  const dur = dm ? `${dm[1]}:${dm[2]}` : '';
  teams.forEach(t => gGuessPos(t.players, durSec(dur)).forEach((pos, i) => { t.players[i].pos = pos; t.players[i].posGuess = true }));
  return { type: '', date: date ? `${date[1]}-${date[2]}-${date[3]}` : today, dur, win, teams, champFail: !champs };
}
function gEditGame(id) {
  if (!isAdmin()) return toast(RO_MSG, 'err');
  const g = GM.games.find(x => x.id === id); if (!g) return;
  GUP = { mode: 'edit', id, n: 1, i: 0, step: 'edit', err: '', busy: false, thumb: null,
    draft: { type: g.type, date: g.date, dur: g.dur, win: g.win, teams: g.teams.map(t => ({ ...t, players: t.players.map(p => ({ ...p, read: p.rid, how: linkOf(p.rid) ? 'exact' : 'none', pick: '', sure: true })) })) } };
  gModal();
}
// 저장 전 검사: 팀 합계 대조 · 필수 항목 · 중복
function gChecks(dr) {
  const warn = [], block = [];
  if (!dr.type) block.push('경기 종류(일반 내전 / 팀대항전)를 골라주세요');
  if (!dr.win) block.push('이긴 팀을 골라주세요');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dr.date)) block.push('경기 날짜를 확인해주세요');
  if (!/^\d{1,2}:\d{2}$/.test(dr.dur)) block.push('경기 시간을 mm:ss 형식으로 적어주세요');
  dr.teams.forEach((t, ti) => {
    const sum = f => t.players.reduce((s, p) => s + p[f], 0);
    const bad = [['킬', sum('k'), t.k], ['데스', sum('d'), t.d], ['어시스트', sum('a'), t.a], ['골드', sum('gold'), t.gold]].filter(([, a, b]) => b && a !== b);
    if (bad.length) warn.push(`${ti + 1}번 팀 ${bad.map(([n, a, b]) => `${n} 합계 ${a.toLocaleString()} ≠ 화면 ${b.toLocaleString()}`).join(', ')} — 빨간 칸 숫자를 다시 확인해주세요`);
    t.players.forEach((p, pi) => { if (!p.champ) block.push(`${ti + 1}번 팀 ${pi + 1}번째 챔피언을 골라주세요`); if (!p.rid.trim() && GUP?.mode !== 'edit') block.push(`${ti + 1}번 팀 ${pi + 1}번째 닉네임이 비어 있어요`) });
  });
  const dup = gFindDup(dr);
  return { warn, block, dup };
}
const gDupKey = g => `${g.date}|${g.dur}|${g.teams.flatMap(t => t.players.map(p => p.champ)).sort().join(',')}`;
const gFindDup = dr => GM.games.find(g => g.id !== GUP?.id && gDupKey(g) === gDupKey(dr)) || null;

function gRowWarn(t, f) { const s = t.players.reduce((a, p) => a + p[f], 0); return t[f] && s !== t[f] }
function gModal() {
  const u = GUP; if (!u) return;
  const head = `<div class="mh">${u.mode === 'edit' ? '✏️ 경기 기록 수정' : '📤 내전 결과 올리기'} ${u.n > 1 ? `<span class="tag t-teal">${u.i + 1} / ${u.n}</span>` : ''}</div>`;
  if (u.step === 'read') return modal(`${head}<div class="g-read">${u.thumb ? `<img src="${u.thumb}" alt="">` : ''}<div><div class="g-spin"></div><b>결과창을 읽는 중…</b><div class="sub">AI가 숫자·닉네임을 읽고, 챔피언은 공식 아이콘과 대조해요 (5~15초)</div></div></div>`, false, 'wide');
  if (u.step === 'err') return modal(`${head}<div class="g-read">${u.thumb ? `<img src="${u.thumb}" alt="">` : ''}<div><b style="color:var(--red)">❌ ${esc(u.err)}</b><div class="sub">경기 종료 후 [점수판] 화면 전체가 보이게 캡처했는지 확인해주세요</div></div></div>
    <div class="mbtns">${u.i + 1 < u.n ? '<button class="btn" data-a="gskip">이 장 건너뛰기</button>' : ''}<button class="btn" data-a="mclose">닫기</button><button class="btn pri" data-a="gretry">↻ 다시 시도</button></div>`, false, 'wide');
  const dr = u.draft, A = isAdmin(), ck = gChecks(dr);
  const mem = (ti, pi, p) => {
    const l = linkOf(p.rid), cur = l ? String(l.mid) : p.pick;
    const lock = l && !A; // 이미 연결된 ID는 운영진만 바꿈
    return `<select class="inp g-mem ${!cur ? 'unk' : ''}" id="gmem-${ti}-${pi}" data-c="gmem" data-t="${ti}" data-p="${pi}" ${lock || u.busy ? 'disabled' : ''} title="${lock ? '이미 연결된 ID예요 · 변경은 운영진만' : ''}">
      <option value="">❔ unknown (나중에 연결)</option><option value="guest" ${cur === 'guest' ? 'selected' : ''}>🎟 게스트 (랭킹 제외)</option>
      ${[...S.players].sort(nameSort).map(m => `<option value="${m.id}" ${cur === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
  };
  const champSel = (ti, pi, p) => `<div class="g-ch ${p.sure || !p.champ ? '' : 'unsure'}" title="${p.sure ? '' : '확실하지 않아요 · 확인해주세요'}">${p.champ ? `<img src="${champImg(p.champ)}" alt="">` : '<span class="g-noimg">?</span>'}
    <select class="inp" data-c="gchamp" data-t="${ti}" data-p="${pi}" ${u.busy ? 'disabled' : ''}><option value="">— 챔피언 —</option>${CHAMP.list.map(c => `<option value="${esc(c.id)}" ${c.id === p.champ ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`;
  const numIn = (ti, pi, f, p, w) => `<input class="inp g-num" type="number" min="0" value="${p[f]}" data-c="gnum" data-t="${ti}" data-p="${pi}" data-f="${f}" style="width:${w}px" ${u.busy ? 'disabled' : ''}>`;
  const teamH = (t, ti) => `<div class="g-team ${dr.win === ti + 1 ? 'win' : dr.win ? 'lose' : ''}">
    <div class="g-th"><b>${ti + 1}번 팀</b>
      <label class="g-win"><input type="radio" name="gwin" data-c="gwin" value="${ti + 1}" ${dr.win === ti + 1 ? 'checked' : ''} ${u.busy ? 'disabled' : ''}> 승리</label>
      <span class="sub">화면 합계 ${t.k} / ${t.d} / ${t.a} · ${t.gold.toLocaleString()} 골드</span></div>
    <div class="g-scroll"><table class="g-tbl"><thead><tr><th>챔피언</th><th>포지션</th><th>닉네임 (게임)</th><th>멤버</th><th>Lv</th><th class="${gRowWarn(t, 'k') ? 'bad' : ''}">K</th><th class="${gRowWarn(t, 'd') ? 'bad' : ''}">D</th><th class="${gRowWarn(t, 'a') ? 'bad' : ''}">A</th><th>CS</th><th class="${gRowWarn(t, 'gold') ? 'bad' : ''}">골드</th></tr></thead>
    <tbody>${t.players.map((p, pi) => `<tr><td>${champSel(ti, pi, p)}</td>
      <td><select class="inp g-pos ${p.posGuess ? 'guess' : ''}" data-c="gpos" data-t="${ti}" data-p="${pi}" title="${p.posGuess ? '자동으로 추측한 포지션이에요 · 다르면 고쳐주세요' : ''}" ${u.busy ? 'disabled' : ''}><option value="">–</option>${G_POS.map(k => `<option value="${k}" ${p.pos === k ? 'selected' : ''}>${posLabel(k)}</option>`).join('')}</select></td>
      <td><input class="inp g-name" value="${esc(p.rid)}" maxlength="24" data-c="grid" data-t="${ti}" data-p="${pi}" ${u.busy || (u.mode === 'edit' && !A) ? 'disabled' : ''}>${p.how === 'fuzzy' ? `<div class="g-hint">AI: ${esc(p.read)} → 등록된 ID로 고침</div>` : ''}</td>
      <td>${mem(ti, pi, p)}</td><td>${numIn(ti, pi, 'lv', p, 46)}</td><td>${numIn(ti, pi, 'k', p, 46)}</td><td>${numIn(ti, pi, 'd', p, 46)}</td><td>${numIn(ti, pi, 'a', p, 46)}</td><td>${numIn(ti, pi, 'cs', p, 58)}</td><td>${numIn(ti, pi, 'gold', p, 76)}</td></tr>`).join('')}</tbody></table></div></div>`;
  modal(`${head}
    <div class="g-top">${u.thumb ? `<img class="g-thumb" src="${u.thumb}" alt="">` : ''}
      <div class="g-meta">
        <div><label class="fl">경기 종류 *</label><div class="g-seg">${Object.entries(G_TYPES).map(([k, n]) => `<button class="chip ${dr.type === k ? 'on' : ''}" data-a="gtype" data-v="${k}" ${u.busy ? 'disabled' : ''}>${n}</button>`).join('')}</div></div>
        <div class="row2"><div><label class="fl">경기 날짜 <span class="g-slbl" id="gSeasonLbl">→ ${seasonName(seasonOf(dr.date))} 기록</span></label><input class="inp" type="date" style="width:100%" value="${esc(dr.date)}" data-c="gdate" ${u.busy ? 'disabled' : ''}></div>
          <div><label class="fl">경기 시간</label><input class="inp" style="width:100%" value="${esc(dr.dur)}" placeholder="mm:ss" data-c="gdur" ${u.busy ? 'disabled' : ''}></div></div>
        <div class="sub">💡 저장 전까지는 잘못 읽힌 값을 고칠 수 있어요 · 저장 후 수정은 운영진만 · 멤버를 고르면 그 게임 ID가 멤버에 계속 연결돼요 · 포지션은 자동으로 추측한 값이니 다르면 고쳐주세요</div>
      </div></div>
    ${dr.champFail ? '<div class="g-alert warn">⚠️ 챔피언 초상화를 자동으로 찾지 못했어요 · 챔피언을 직접 골라주세요</div>' : ''}
    ${teamH(dr.teams[0], 0)}${teamH(dr.teams[1], 1)}
    <div id="gchk">${gChkHTML(ck)}</div>
    <div class="mbtns">${u.i + 1 < u.n && u.mode === 'new' ? `<button class="btn" data-a="gskip" ${u.busy ? 'disabled' : ''}>이 장 건너뛰기</button>` : ''}
      <button class="btn" data-a="mclose" ${u.busy ? 'disabled' : ''}>취소</button>
      ${ck.dup && A ? `<button class="btn danger" data-a="gsave" data-v="force" ${u.busy ? 'disabled' : ''}>중복이어도 저장</button>` : ''}
      <button class="btn pri" data-a="gsave" ${u.busy || ck.block.length || ck.dup ? 'disabled' : ''}>${u.busy ? '저장 중…' : '✅ 저장'}</button></div>`, false, 'full');
}
function gChkHTML(ck) {
  return [ck.dup ? `<div class="g-alert bad">🚫 이미 올라온 경기예요 (${esc(ck.dup.date)} · ${esc(ck.dup.dur)} · ${G_TYPES[ck.dup.type]}) — 같은 날짜·경기 시간·챔피언 10명이 모두 같아요</div>` : '',
    ...ck.block.map(t => `<div class="g-alert">✋ ${esc(t)}</div>`), ...ck.warn.map(t => `<div class="g-alert warn">⚠️ ${esc(t)}</div>`)].join('');
}
const gRefreshChecks = () => gModal(); // 값이 바뀌면 검사 결과·버튼 상태를 다시 그림 (change 이벤트라 입력 중엔 안 불림)

async function gSave(force) {
  const u = GUP; if (!u || u.busy) return; const dr = u.draft, ck = gChecks(dr), A = isAdmin();
  if (ck.block.length) return toast(ck.block[0], 'err');
  if (ck.dup && !(force && A)) return toast('이미 올라온 경기예요', 'err');
  if (u.mode === 'edit' && !A) return toast(RO_MSG, 'err');
  u.busy = true; gModal();
  try {
    const { fs } = fb, id = u.mode === 'edit' ? u.id : 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const game = { type: dr.type, date: dr.date, dur: dr.dur, win: dr.win, season: seasonOf(dr.date), at: u.mode === 'edit' ? (GM.games.find(g => g.id === id)?.at || Date.now()) : Date.now(), by: CLIENT,
      teams: dr.teams.map(t => ({ k: t.k, d: t.d, a: t.a, gold: t.gold, players: t.players.map(p => ({ rid: p.rid.trim(), champ: p.champ, pos: G_POS.includes(p.pos) ? p.pos : '', lv: p.lv, k: p.k, d: p.d, a: p.a, cs: p.cs, gold: p.gold })) })) };
    if (u.mode === 'new') { const full = await compressImage(u.file); await fs.setDoc(gDoc('shots', id), { img: full.data, at: Date.now() }) }
    await fs.setDoc(gDoc('games', id), game);
    // 실시간 동기화가 도착하기 전에 다음 장을 읽어도 방금 저장한 ID를 비교 대상에 넣도록
    const ng = normGame({ ...game, id }); GM.games = [ng, ...GM.games.filter(g => g.id !== id)];
    // 새 연결: 아직 연결 안 된 ID에 멤버를 골랐을 때만 (기존 연결 변경은 운영진의 ID 관리에서)
    for (const t of dr.teams) for (const p of t.players) {
      const rid = p.rid.trim(); if (!rid || !p.pick) continue;
      if (linkOf(rid) && !A) continue;
      await fs.setDoc(gDoc('ids', idDocId(nkey(rid))), { name: rid, mid: p.pick === 'guest' ? 'guest' : Number(p.pick), at: Date.now() });
      GM.ids[nkey(rid)] = { name: rid, mid: p.pick === 'guest' ? 'guest' : Number(p.pick) };
    }
    toast(u.mode === 'edit' ? '✏️ 수정 완료' : '📊 경기 기록 저장 완료!');
    u.busy = false;
    if (u.mode === 'new' && u.i + 1 < u.n) { u.i++; return gNext() }
    GUP = null; closeModal(); render();
  } catch (e) { console.error(e); u.busy = false; gModal(); toast('저장 실패 — ' + (e.message || explain(e).t), 'err') }
}

/* ---------- 통계 ---------- */
const durSec = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 0 };
// 멤버별 누적 (게임은 날짜·업로드 순으로 훑어서 연승도 계산)
function gStats(games, pos = 'ALL') {
  const by = new Map(), champs = new Map(); let unknown = new Set(), guests = 0, blanks = 0;
  const chron = [...games].sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
  for (const g of chron) {
    const sec = durSec(g.dur);
    g.teams.forEach((t, ti) => {
      const won = g.win === ti + 1, teamK = t.k || t.players.reduce((s, p) => s + p.k, 0);
      t.players.forEach(p => {
        if (pos !== 'ALL' && p.pos !== pos) return; // 포지션 필터: 그 포지션으로 뛴 기록만
        const m = memberOf(p.rid);
        let c = champs.get(p.champ); if (!c) champs.set(p.champ, c = { id: p.champ, n: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, sec: 0, posc: {}, mem: new Map() });
        c.n++; if (won) c.w++; c.k += p.k; c.d += p.d; c.a += p.a; c.cs += p.cs; c.sec += sec; if (p.pos) c.posc[p.pos] = (c.posc[p.pos] || 0) + 1;
        if (m != null && m !== 'guest') { const cm = c.mem.get(m) || { n: 0, w: 0, k: 0, d: 0, a: 0 }; cm.n++; if (won) cm.w++; cm.k += p.k; cm.d += p.d; cm.a += p.a; c.mem.set(m, cm) }
        if (m === 'guest') { guests++; return }
        if (m == null) { if (p.rid) unknown.add(p.rid); else blanks++; return } // 이름 없는 칸(내전롤에서 가져온 기록 일부)
        let s = by.get(m); if (!s) by.set(m, s = { id: m, n: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, gold: 0, kpN: 0, kpD: 0, sec: 0, ch: {}, chw: {}, posc: {}, streak: 0, best: 0, recent: [] });
        s.n++; if (won) s.w++; s.k += p.k; s.d += p.d; s.a += p.a; s.cs += p.cs; s.gold += p.gold;
        if (p.pos) s.posc[p.pos] = (s.posc[p.pos] || 0) + 1; if (won) s.chw[p.champ] = (s.chw[p.champ] || 0) + 1;
        if (teamK) { s.kpN += p.k + p.a; s.kpD += teamK }
        if (sec) s.sec += sec; else s.noSec = true;
        s.ch[p.champ] = (s.ch[p.champ] || 0) + 1;
        s.streak = won ? s.streak + 1 : 0; s.best = Math.max(s.best, s.streak);
        s.recent.push(won);
      });
    });
  }
  const rows = [...by.values()].map(s => ({ ...s, l: s.n - s.w, wr: s.w / s.n, kda: (s.k + s.a) / Math.max(1, s.d), perfect: s.d === 0,
    kp: s.kpD ? s.kpN / s.kpD : 0, csm: s.sec ? s.cs / (s.sec / 60) : 0, gpm: s.sec ? s.gold / (s.sec / 60) : 0,
    pool: Object.keys(s.ch).length, seq: s.recent, recent: s.recent.slice(-5).reverse(),
    mainPos: Object.entries(s.posc).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    most: Object.entries(s.ch).sort((a, b) => b[1] - a[1]).slice(0, 3) }));
  return { rows, champs: [...champs.values()], unknown: [...unknown], guests, blanks };
}
const pct = v => Math.round(v * 100) + '%';
const G_COLS = [
  { k: 'n', h: '판수', v: s => s.n, f: s => s.n }, { k: 'w', h: '승', v: s => s.w, f: s => s.w }, { k: 'l', h: '패', v: s => s.l, f: s => s.l },
  { k: 'wr', h: '승률', v: s => s.wr, f: s => `<b class="${s.wr >= 0.5 ? 'g-up' : 'g-dn'}">${pct(s.wr)}</b>` },
  { k: 'kda', h: 'KDA', v: s => s.kda, f: s => `<b>${s.perfect ? 'Perfect' : s.kda.toFixed(2)}</b>` },
  { k: 'k', h: '평균 K/D/A', v: s => s.k / s.n, f: s => `${(s.k / s.n).toFixed(1)} / ${(s.d / s.n).toFixed(1)} / ${(s.a / s.n).toFixed(1)}` },
  { k: 'kp', h: '킬관여', v: s => s.kp, f: s => pct(s.kp) },
  { k: 'csm', h: '분당 CS', v: s => s.csm, f: s => s.csm.toFixed(1) },
  { k: 'gpm', h: '분당 골드', v: s => s.gpm, f: s => Math.round(s.gpm).toLocaleString() },
];
// 부문별 1위 (내전롤 하이라이트와 같은 기준)
function gAwards(games, st, need) {
  const nm = id => esc(player(id)?.name || '?'), out = [];
  const add = (e, n, d, who, val, sub) => { if (who) out.push({ e, n, d, who, val, sub }) };
  const top = (arr, f) => arr.reduce((b, x) => (b == null || f(x) > f(b) ? x : b), null);
  const streak = (seq, w) => { let c = 0; for (let i = seq.length - 1; i >= 0 && seq[i] === w; i--) c++; return c };
  const rows = st.rows, qual = st.rows.filter(s => s.n >= need);
  // 경기 단위 집계: MVP·ACE·맞대결·듀오
  const mvp = new Map(), ace = new Map(), duo = new Map(), vs = new Map(), farm = new Map();
  const inc = (m, k, d = 1) => m.set(k, (m.get(k) || 0) + d);
  const kdaOf = p => (p.k + p.a) / Math.max(1, p.d);
  for (const g of games) {
    const sec = durSec(g.dur);
    const side = g.teams.map((t, ti) => ({ won: g.win === ti + 1, ps: t.players.map(p => ({ ...p, m: memberOf(p.rid) })) }));
    side.forEach(({ won, ps }) => {
      const best = top(ps, kdaOf); if (best && best.m != null && best.m !== 'guest') inc(won ? mvp : ace, best.m);
      const ms = [...new Set(ps.map(p => p.m).filter(m => m != null && m !== 'guest'))].sort((a, b) => a - b);
      for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) { const k = ms[i] + ':' + ms[j], d = duo.get(k) || { n: 0, w: 0 }; d.n++; if (won) d.w++; duo.set(k, d) }
      if (sec) ps.forEach(p => { if (p.m == null || p.m === 'guest') return; const f = farm.get(p.m) || { g: 0, s: 0 }; f.g += Math.max(0, p.gold - (p.k * 250 + p.a * 100 + sec * 1.9 + 500)); f.s += sec; farm.set(p.m, f) });
    });
    const [A, B] = side.map(s => [...new Set(s.ps.map(p => p.m).filter(m => m != null && m !== 'guest'))]);
    A.forEach(a => B.forEach(b => { const [x, y, xWon] = a < b ? [a, b, side[0].won] : [b, a, side[1].won]; const k = x + ':' + y, v = vs.get(k) || { n: 0, xw: 0 }; v.n++; if (xWon) v.xw++; vs.set(k, v) }));
  }
  const win = top(rows, s => streak(s.seq, true) * 1000 + s.n); const ws = win ? streak(win.seq, true) : 0;
  if (ws >= 2) add('🔥', '연승 중', '가장 최근 경기부터 연속으로 이기고 있는 선수', nm(win.id), `${ws}연승 진행 중 🔥`);
  const lose = top(rows, s => streak(s.seq, false) * 1000 + s.n); const ls = lose ? streak(lose.seq, false) : 0;
  if (ls >= 2) add('💀', '연패 중', '가장 최근 경기부터 연속으로 지고 있는 선수', nm(lose.id), `${ls}연패 중...`);
  const enemy = top(qual, s => s.wr * 1000 + s.n); if (enemy) add('😈', '공공의 적', '전체 승률이 가장 높은 선수 – 상대팀으로 만나면 가장 무서운 사람', nm(enemy.id), `승률 ${pct(enemy.wr)} · ${enemy.n}판`);
  const rival = top([...vs.entries()].filter(([, v]) => v.n >= 5).map(([k, v]) => { const [x, y] = k.split(':').map(Number), r = v.xw / v.n; return r >= 0.5 ? { a: x, b: y, r, n: v.n } : { a: y, b: x, r: 1 - r, n: v.n } }), x => x.r * 1000 + x.n);
  if (rival) add('⚔️', '인간상성', '두 선수가 서로 다른 팀일 때, 한쪽이 압도적으로 이기는 조합', `${nm(rival.a)} <span class="sub">vs</span> ${nm(rival.b)}`, `${pct(rival.r)} 승률 · ${rival.n}판 맞대결`);
  const mv = top([...mvp.entries()], x => x[1]); if (mv) add('🏅', 'MVP 빈도', '승리팀에서 KDA 1위를 가장 많이 기록한 선수', nm(mv[0]), `${mv[1]}번 MVP`);
  const ac = top([...ace.entries()], x => x[1]); if (ac) add('🗡️', 'ACE 빈도', '패배팀에서 KDA 1위를 가장 많이 기록한 선수', nm(ac[0]), `${ac[1]}번 ACE`);
  const fm = top([...farm.entries()].filter(([id]) => (rows.find(s => s.id === id)?.n || 0) >= need), x => x[1].g / (x[1].s / 60));
  if (fm) add('👨‍🌾', '농사왕', '킬·어시·자연골드 제외한 순수 파밍/오브젝트 골드 1위 (분당 기준)', nm(fm[0]), `분당 파밍 ${Math.round(fm[1].g / (fm[1].s / 60))}골드`);
  const all = top(rows, s => s.pool * 1000 + s.n); if (all) add('🃏', '올라운더', '가장 다양한 챔피언을 플레이한 선수', nm(all.id), `${all.pool}개 챔피언 플레이`, all.most[0] ? `모스트: ${esc(champName(all.most[0][0]))}` : '');
  const rich = top(rows, s => s.gold); if (rich) add('💰', '금수저', '지금까지 골드를 가장 많이 획득한 선수 (누적 기준)', nm(rich.id), `누적 ${rich.gold.toLocaleString()} 골드`, `${rich.n}경기 누적`);
  const bag = top(rows, s => s.d); if (bag) add('🥊', '샌드백', '지금까지 데스가 가장 많은 선수 (누적 기준)', nm(bag.id), `누적 ${bag.d} 데스`, `${bag.n}경기 누적`);
  // 판수가 적은 조합이 우연히 높게 나오지 않도록 승률의 신뢰구간 하한(Wilson)으로 비교
  const wilson = (w, n) => { const z = 1.96, p = w / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n) };
  const bd = top([...duo.entries()].filter(([, d]) => d.n >= 5), x => wilson(x[1].w, x[1].n));
  if (bd) { const [a, b] = bd[0].split(':').map(Number); add('🤝', '최고의 듀오', '같은 팀일 때 승률이 가장 높은 두 선수 조합 (5판 이상)', `${nm(a)} <span class="sub">&amp;</span> ${nm(b)}`, `승률 ${pct(bd[1].w / bd[1].n)} · ${bd[1].n}게임`, `${bd[1].w}승 / ${bd[1].n}판`) }
  // 최악: 승률 신뢰구간 상한이 가장 낮은 조합 (= 1 - 패배율의 하한)
  const wd = top([...duo.entries()].filter(([, d]) => d.n >= 5), x => wilson(x[1].n - x[1].w, x[1].n));
  if (wd && wd[1].w / wd[1].n < 0.5) { const [a, b] = wd[0].split(':').map(Number); add('💔', '최악의 듀오', '같은 팀일 때 승률이 가장 낮은 두 선수 조합 (5판 이상)', `${nm(a)} <span class="sub">&amp;</span> ${nm(b)}`, `승률 ${pct(wd[1].w / wd[1].n)} · ${wd[1].n}게임`, `${wd[1].w}승 / ${wd[1].n}판`) }
  // 견우와 직녀: 둘 다 많이 뛰었는데 같은 팀으로는 가장 적게 만난 두 명
  let far = null; const ids = qual.map(s => s.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [x, y] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]], together = duo.get(x + ':' + y)?.n || 0;
    const nx = rows.find(s => s.id === x).n, ny = rows.find(s => s.id === y).n, sc = -together * 10000 + nx + ny;
    if (!far || sc > far.sc) far = { x, y, together, nx, ny, sc };
  }
  if (far) add('🌌', '견우와 직녀', '같은 팀으로 가장 적게 만난 두 명', `${nm(far.x)} <span class="sub">✧</span> ${nm(far.y)}`, `같은 팀 ${far.together}번`, `${nm(far.x)} ${far.nx}경기 · ${nm(far.y)} ${far.ny}경기`);
  return out;
}
/* ----- 종합 순위 점수 (내전롤 '밸런스' 방식 기본값 · 운영진이 수정) -----
   점수 = KDA* × kda + 승률(정수 %) × wr + ln(판수) × games
   KDA* = KDA가 cap을 넘으면 넘는 부분은 capRate만 반영 */
const DEF_RW = { kda: 15, wr: 1, games: 15, cap: 4, capRate: 0.4 };
const rankW = () => { const w = { ...DEF_RW }, s = S.rankW || {}; for (const k in w) if (Number.isFinite(+s[k])) w[k] = +s[k]; return w };
const kdaStar = (kda, w) => kda > w.cap ? w.cap + (kda - w.cap) * w.capRate : kda;
const scoreOf = (s, w) => kdaStar(s.kda, w) * w.kda + Math.round(s.wr * 100) * w.wr + Math.log(s.n) * w.games;
const rwText = w => `KDA*×${w.kda} + 승률×${w.wr} + log(판수)×${w.games}`;
function gRanked(games, need, w, pos = 'ALL') {
  const st = gStats(games, pos); st.rows.forEach(s => s.score = scoreOf(s, w));
  st.ranked = st.rows.filter(s => s.n >= need).sort((a, b) => b.score - a.score || b.n - a.n);
  st.rest = st.rows.filter(s => s.n < need).sort((a, b) => b.score - a.score);
  return st;
}
// 통계 탭 공통 필터: 시즌 · 경기 종류 · 포지션
function gStatFilterHTML(withPos = true) {
  const sel = gSeasonSel();
  return `<div class="card toolbar g-filters">
    <select class="inp" data-c="gseason">${gSeasonList().map(n => `<option value="${n}" ${sel === n ? 'selected' : ''}>${seasonName(n)}${n === curSeason() ? ' · 이번 시즌' : ''}</option>`).join('')}<option value="all" ${sel === 'all' ? 'selected' : ''}>${seasonName('all')}</option></select>
    <div class="g-seg">${[['casual', G_TYPES.casual], ['team', G_TYPES.team], ['all', '전체']].map(([k, n]) => `<button class="chip ${GM.filter === k ? 'on' : ''}" data-a="gfilter" data-v="${k}">${n}</button>`).join('')}</div>
    ${withPos ? `<div class="g-seg mla">${[['ALL', '전체'], ...G_POS.map(k => [k, posLabel(k)])].map(([k, n]) => `<button class="chip ${GM.pos === k ? 'on' : ''}" data-a="gposf" data-v="${k}">${n}</button>`).join('')}</div>` : ''}
  </div>`;
}
function renderStats() {
  const games = gFiltered(), A = isAdmin(), connected = !!(fb && fb.fs);
  const need = exposeNeed(games.length) || 0, w = rankW(), pos = GM.pos || 'ALL', st = gRanked(games, need, w, pos);
  const tabs = [['rank', '🏆 순위표'], ['players', '👤 선수'], ['champs', '🧩 챔피언']];
  const body = !connected ? `<div class="empty-note card">🔌 서버에 연결되면 통계가 보여요</div>` : !GM.got ? `<div class="empty-note card">⏳ 불러오는 중…</div>`
    : !games.length ? `<div class="card empty-note" style="padding:40px 14px">📭 이 조건에 맞는 경기가 없어요</div>`
    : GM.view === 'players' ? gPlayersHTML(games, st, need) : GM.view === 'champs' ? gChampsHTML(games, st) : gRankHTML(games, st, need, w, pos);
  V.innerHTML = `<div class="sec-head"><div><div class="h1">📊 통계</div>
    <div class="sub">📜 기록 탭에 올라온 경기로 자동 집계 · 통계는 1판만 뛰어도 들어가고, <b style="color:var(--txt)">순위는 최소 판수를 채운 멤버만</b> 매겨져요</div></div>
    <button class="btn" data-a="tab" data-v="records">📤 결과 올리러 가기</button></div>
  <div class="g-vtabs">${tabs.map(([k, n]) => `<button class="${(GM.view === k || (k === 'rank' && !['players', 'champs'].includes(GM.view))) ? 'on' : ''}" data-a="gview" data-v="${k}">${n}</button>`).join('')}</div>
  ${gStatFilterHTML()}
  ${body}
  ${A && connected && GM.view !== 'players' && GM.view !== 'champs' ? gAdminHTML() : ''}`;
  if (UI.gDetOpen) { const d = $('.g-det'); if (d) d.open = true }
  gAfterRender();
}
// 🏆 순위표: 요약 · 종합 순위 · 부문별 1위
function gRankHTML(games, st, need, w, pos) {
  const A = isAdmin();
  const lastDate = games.reduce((m, g) => g.date > m ? g.date : m, ''), prevGames = games.filter(g => g.date !== lastDate);
  const prev = new Map(); if (prevGames.length) gRanked(prevGames, exposeNeed(prevGames.length) || 0, w, pos).ranked.forEach((s, i) => prev.set(s.id, i + 1));
  const maxKda = Math.max(4, ...st.rows.map(s => s.kda));
  const selId = st.rows.some(s => s.id === GM.sel) ? GM.sel : (st.ranked[0] || st.rest[0])?.id;
  const bar = (v, max, cls) => `<span class="g-bar ${cls}"><i style="width:${Math.max(4, Math.min(100, v / max * 100))}%"></i></span>`;
  const rankRow = (s, i) => { const m = player(s.id), p = prev.get(s.id), mv = i == null || !p ? '' : p > i + 1 ? `<span class="g-up">↑${p - i - 1}</span>` : p < i + 1 ? `<span class="g-dn2">↓${i + 1 - p}</span>` : '';
    return `<tr class="g-lb ${i == null ? 'g-unranked' : ''} ${i === 0 ? 'top1' : ''} ${s.id === selId ? 'sel' : ''}" data-a="gsel" data-id="${s.id}">
      <td class="g-rk">${i == null ? `<span class="sub" title="최소 ${need}판부터 순위">${need - s.n}판 더</span>` : `${i + 1}${mv ? `<div class="g-mv">${mv}</div>` : ''}`}</td>
      <td class="g-nm">${m ? nmH(m) : '?'}${s.mainPos ? ` <span class="g-pos-t">${posLabel(s.mainPos)}</span>` : ''}</td><td>${s.n}</td>
      <td class="g-kda3">${(s.k / s.n).toFixed(1)} / ${(s.d / s.n).toFixed(1)} / ${(s.a / s.n).toFixed(1)}</td>
      <td><b>${s.perfect ? 'Perfect' : s.kda.toFixed(2)}</b>${bar(s.kda, maxKda, 'k')}</td>
      <td><b class="${s.wr >= 0.5 ? 'g-up' : 'g-dn'}">${pct(s.wr)}</b>${bar(s.wr, 1, 'w')}</td>
      <td class="g-score">${s.score.toFixed(1)}</td></tr>` };
  const awards = pos === 'ALL' ? gAwards(games, st, need).map(a => `<div class="g-award"><div class="g-aw-e">${a.e}</div><div class="g-aw-b">
      <div class="g-aw-t">${a.n}</div><div class="g-aw-d">${a.d}</div>
      <div class="g-aw-w">${a.who}</div><div class="g-aw-v">${a.val}${a.sub ? ` <span class="sub">· ${a.sub}</span>` : ''}</div></div></div>`).join('') : '';
  const topK = [...st.ranked].sort((a, b) => b.kda - a.kda)[0], topW = [...st.ranked].sort((a, b) => b.wr - a.wr || b.n - a.n)[0];
  return `<div class="g-hl">
    <div class="g-hlc"><b>${games.length}</b><span>총 내전</span></div>
    <div class="g-hlc"><b>${st.rows.length}</b><span>참가 멤버</span></div>
    ${topK ? `<div class="g-hlc"><b>${topK.kda.toFixed(2)}</b><span>최고 KDA · ${esc(player(topK.id)?.name || '')}</span></div>` : ''}
    ${topW ? `<div class="g-hlc"><b>${pct(topW.wr)}</b><span>최고 승률 · ${esc(player(topW.id)?.name || '')} (${topW.n}판)</span></div>` : ''}
  </div>
  <div class="card"><div class="h2">🏆 종합 순위 ${pos !== 'ALL' ? `<span class="tag t-teal">${posLabel(pos)}</span>` : ''}<span class="g-formula">📊 ${rwText(w)}</span><span class="sub">· ${need ? `${need}판 이상만 순위` : '전원 순위'} · KDA*는 ${w.cap} 초과분 ${Math.round(w.capRate * 100)}%만 반영</span>
      ${A ? '<button class="btn sm mla" data-a="grwedit">⚙️ 순위 공식 수정</button>' : ''}</div>
    <div class="g-lbwrap"><div class="g-scroll g-lbmain"><table class="g-tbl g-rank g-lbt"><thead><tr><th>#</th><th>멤버</th><th>게임</th><th>K / D / A</th><th>KDA</th><th>승률</th><th>점수</th></tr></thead>
      <tbody>${st.ranked.map((s, i) => rankRow(s, i)).join('')}${st.rest.map(s => rankRow(s, null)).join('')}</tbody></table></div>
      ${selId != null ? gSidePanel(games, st, pos, selId, need) : ''}</div>
    ${st.unknown.length || st.guests || st.blanks ? `<div class="sub" style="margin-top:10px">❔ 멤버 연결 안 된 게임 ID ${st.unknown.length}개${st.guests ? ` · 🎟 게스트 ${st.guests}회` : ''}${st.blanks ? ` · 이름 없는 기록 ${st.blanks}칸` : ''} — 통계에서 빠져 있어요${A ? ' · 👥 멤버 → ❔ 미등록 닉네임에서 연결하면 과거 기록까지 바로 반영돼요' : ' · 운영진이 연결하면 자동 반영돼요'}</div>` : ''}
  </div>
  ${pos === 'ALL' ? `<div class="card"><div class="h2">🎖️ 부문별 1위 <span class="sub">승률·분당 기록은 ${need ? `${need}판 이상` : '참여한'} 멤버 중 · 누적 기록은 전원</span></div>
    <div class="g-awards">${awards || '<div class="empty-note">아직 기록이 부족해요</div>'}</div></div>` : ''}`;
}
// 멤버 한 명의 경기 단위 집계: 챔피언별 · 함께 뛴 멤버 (포지션 필터 반영)
function gPlayerDetail(mid, games, pos = 'ALL') {
  const ch = {}, duo = new Map();
  games.forEach(g => g.teams.forEach((t, ti) => { const me = t.players.find(p => memberOf(p.rid) === mid); if (!me || (pos !== 'ALL' && me.pos !== pos)) return; const won = g.win === ti + 1;
    const c = ch[me.champ] || (ch[me.champ] = { n: 0, w: 0, k: 0, d: 0, a: 0 }); c.n++; if (won) c.w++; c.k += me.k; c.d += me.d; c.a += me.a;
    t.players.forEach(p => { const pm = memberOf(p.rid); if (pm === mid || pm == null || pm === 'guest') return; const d = duo.get(pm) || { n: 0, w: 0 }; d.n++; if (won) d.w++; duo.set(pm, d) }) }));
  const duos = [...duo.entries()].filter(([, d]) => d.n >= 3).map(([id, d]) => ({ id, ...d, wr: d.w / d.n }));
  return { champs: Object.entries(ch).sort((a, b) => b[1].n - a[1].n || b[1].w - a[1].w),
    best: [...duos].sort((a, b) => b.wr - a.wr || b.n - a.n).slice(0, 3), worst: [...duos].sort((a, b) => a.wr - b.wr || b.n - a.n).slice(0, 1) };
}
// 순위표 옆 선수 카드 (내전롤 스타일): 기본 스탯 · 능력치 · 모스트 챔피언 · 듀오
function gSidePanel(games, st, pos, mid, need) {
  const s = st.rows.find(r => r.id === mid), m = player(mid); if (!s || !m) return '';
  const rank = st.ranked.indexOf(s), det = gPlayerDetail(mid, games, pos);
  // 능력치: 참가 멤버 중 백분위
  const pctl = (f) => { const vs = st.rows.map(f).sort((a, b) => a - b), v = f(s); return vs.length > 1 ? vs.filter(x => x < v).length / (vs.length - 1) : 1 };
  const stats = [['KDA', r => r.kda], ['승률', r => r.wr], ['킬관여', r => r.kp], ['챔프폭', r => r.pool], ['CS/분', r => r.csm]];
  const kdaOf = c => ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
  const duoH = (d, cls) => `<div class="g-sduo"><b>${esc(player(d.id)?.name || '?')}</b><span class="sub">${d.n}게임 함께</span><b class="${cls}">${pct(d.wr)}</b></div>`;
  return `<aside class="g-side">
    <div class="g-sh"><div><b>${esc(m.name)}</b><div class="sub">${s.n}게임 · ${s.mainPos ? posLabel(s.mainPos) : '포지션 –'}</div></div>
      <div class="g-srank">${rank >= 0 ? `<b>${rank + 1}위</b><span>${s.score.toFixed(1)}점</span>` : `<span>${need - s.n}판 더</span>`}</div></div>
    <div class="g-stiles"><div><b>${s.perfect ? 'Perfect' : s.kda.toFixed(2)}</b><span>KDA</span></div><div><b class="${s.wr >= 0.5 ? 'g-up' : 'g-dn'}">${pct(s.wr)}</b><span>승률 · ${s.w}승 ${s.l}패</span></div><div><b>${s.csm.toFixed(1)}</b><span>CS/분</span></div></div>
    <div class="g-skda">평균 <b>${(s.k / s.n).toFixed(1)}</b> / <b class="g-dn2">${(s.d / s.n).toFixed(1)}</b> / <b>${(s.a / s.n).toFixed(1)}</b></div>
    <div class="g-st">능력치 <span class="sub">참가 멤버 중</span></div>
    ${stats.map(([n, f]) => { const p = pctl(f); return `<div class="g-abil"><span>${n}</span><span class="g-bar w"><i style="width:${Math.max(4, Math.round(p * 100))}%"></i></span><span class="sub">상위 ${Math.max(1, Math.round((1 - p) * 100))}%</span></div>` }).join('')}
    <div class="g-st">모스트 챔피언</div>
    ${det.champs.slice(0, 5).map(([id, c]) => `<div class="g-smost"><img src="${champImg(id)}" alt=""><div><b>${esc(champName(id))}</b><span class="sub">${c.n}판 · KDA ${kdaOf(c)}</span></div><b class="${c.w / c.n >= 0.5 ? 'g-up' : 'g-dn'}">${pct(c.w / c.n)}</b></div>`).join('')}
    ${det.best.length ? `<div class="g-st">🤝 베스트 듀오</div>${det.best.map(d => duoH(d, 'g-up')).join('')}` : ''}
    ${det.worst.length && det.worst[0].wr < 0.5 ? `<div class="g-st">💔 워스트 듀오</div>${det.worst.map(d => duoH(d, 'g-dn2')).join('')}` : ''}
    <button class="btn sm" style="width:100%;margin-top:10px" data-a="gplayer" data-id="${mid}">전체 기록 보기 ›</button>
  </aside>`;
}
// 👤 선수: 상세 통계 표
function gPlayersHTML(games, st, need) {
  const q = (GM.pq || '').trim().toLowerCase();
  const list = [...st.rows].filter(s => !q || (player(s.id)?.name || '').toLowerCase().includes(q)).sort((a, b) => b.n - a.n);
  const rankOf = new Map(st.ranked.map((s, i) => [s.id, i + 1]));
  const col = G_COLS.find(c => c.k === GM.sort) || G_COLS[3];
  const detail = [...st.rows].filter(s => !q || (player(s.id)?.name || '').toLowerCase().includes(q)).sort((a, b) => GM.dir * (col.v(a) - col.v(b)) || b.n - a.n);
  const th = c => `<th class="g-sort ${GM.sort === c.k ? 'on' : ''}" data-a="gsort" data-v="${c.k}">${c.h}${GM.sort === c.k ? (GM.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  const formH = s => s.recent.map(x => `<i class="g-form ${x ? 'w' : 'l'}">${x ? '승' : '패'}</i>`).join('');
  const mostH = s => s.most.map(([id, c]) => `<span class="g-most" title="${esc(champName(id))} ${c}판"><img src="${champImg(id)}" alt="">${c > 1 ? `<i>${c}</i>` : ''}</span>`).join('');
  return `<div class="card"><div class="h2">👤 선수 통계 <span class="sub">${st.rows.length}명 · 열 제목을 누르면 정렬 · 이름을 누르면 상세</span>
      <input class="inp mla" style="width:180px" data-i="gpq" placeholder="🔍 멤버 검색" value="${esc(GM.pq || '')}"></div>
    <div class="g-scroll"><table class="g-tbl g-rank"><thead><tr><th>순위</th><th>멤버</th><th>포지션</th>${G_COLS.map(th).join('')}<th>최근 5판</th><th>모스트</th></tr></thead>
      <tbody>${detail.map(s => { const m = player(s.id), r = rankOf.get(s.id); return `<tr class="${r ? '' : 'g-unranked'}" data-a="gplayer" data-id="${s.id}"><td class="g-rk">${r || `<span class="sub">${need - s.n}판 더</span>`}</td><td class="g-nm">${m ? nmH(m) : '?'}</td><td class="sub">${s.mainPos ? posLabel(s.mainPos) : '–'}</td>
        ${G_COLS.map(c => `<td>${c.f(s)}</td>`).join('')}<td class="g-forms">${formH(s)}</td><td class="g-mosts">${mostH(s)}</td></tr>` }).join('') || '<tr><td colspan="14" class="empty-note">검색 결과가 없어요</td></tr>'}</tbody></table></div></div>`;
}
/* ----- 챔피언 티어 (우리 내전 기준) -----
   점수 = 보정 승률(%p) + 픽 존재감. 보정 승률은 우리 내전 승패에 lol.ps 승률을 '가상 10판'만큼 섞은 값이라
   판수가 적은 챔피언은 솔랭 승률 근처, 많이 쓴 챔피언은 거의 우리 기록대로 간다.
   티어는 점수 순위(백분위)로 나눈다 — 우리 내전 챔피언끼리 비교한 상대 티어.
   아래 G_LPS는 기본값 — 실제로는 Firestore(lps_tier, 매일 10시 자동 갱신) 값으로 바뀐다 */
let G_LPS_PATCH = '26.23', G_LPS_AT = 0;
let G_LPS = { // 챔피언:승률:픽률 (lol.ps · 한국 · 마스터+)
  TOP: '잭스:52.46:9.61,이렐리아:52.82:6.31,갱플랭크:51.45:5.13,피오라:52.6:5.44,말파이트:51.88:5.41,다리우스:52.88:4.19,제이스:48.02:10.39,카밀:51.7:5.85,올라프:48.79:7.31,케넨:52.76:3.61,판테온:50.17:4.19,사이온:51.34:3.95,아칼리:50.03:3.15,크산테:47.74:9.59,레넥톤:48.46:5.86,자헨:52.26:3.32,트린다미어:52.47:2.72,뽀삐:54.4:1.11,신지드:52.65:2.64,볼리베어:50.45:3.18,나르:48.1:5.19,야스오:49.42:2.29,워윅:53.31:1.72,클레드:51.21:2.01,그라가스:50.76:2.67,세트:50.42:1.93,요네:47.11:7.5,갈리오:54.31:0.8,애니비아:51.32:1.47,우르곳:50.16:1.3,아트록스:48.24:4.57,베인:49.3:2.02,티모:49:2.44,초가스:51.92:1.11,모데카이저:49:2.14,카시오페아:53.71:0.93,케일:48.93:1.52,일라오이:49.21:1.41,우디르:50.5:0.81,럼블:47.7:3.45,리븐:49.33:1.37,쉔:49.63:1.94,요릭:48.29:1.85,사일러스:48.61:1.61,리산드라:48.9:0.83,하이머딩거:48.63:1.34,나서스:48.22:1.77,암베사:46.31:6.74,문도 박사:47.38:3.25,오른:48.27:1.7,오공:48.92:1.03,퀸:48.93:0.86,오로라:49.75:0.8,그웬:47.44:2.46,탐 켄치:49.6:0.5,제드:48.07:0.68,가렌:47:1.73,블라디미르:47.64:1.16,자크:49.15:0.6,마오카이:48.87:0.63,마스터 이:47.42:0.59,라이즈:45.89:1.01,트런들:46.49:0.61,코르키:45.79:0.65,바루스:44.12:0.62',
  JGL: '리 신:49.42:23.69,니달리:53.38:9.02,자이라:55.07:4.19,헤카림:50.42:6.84,사일러스:50.32:6.97,탈리야:51.4:7.2,나피리:49.65:7.27,키아나:48.24:9.57,샤코:51.56:2.73,엘리스:52.26:3.33,탈론:49.91:5.48,릴리아:51.65:3.56,신 짜오:52.22:4.49,킨드레드:51.15:4.58,자르반 4세:49.27:7.71,카서스:52.35:2.17,자크:51.56:2.67,그레이브즈:48.85:6.3,렉사이:51.76:2.54,렝가:50.75:2.69,바이:48.47:7.86,벨베스:51.52:1.88,자헨:52.37:1.46,에코:49.79:3.34,이블린:50.86:2.02,케인:50.38:2.66,판테온:51.3:1.64,스카너:52.45:1.2,누누와 윌럼프:50.92:1.88,워윅:53.25:1.16,오공:48.91:4.3,마스터 이:48.65:3.68,비에고:48.03:5.82,마오카이:52.27:0.63,아이번:50.2:1,피들스틱:49.23:1.46,세주아니:50.93:0.88,초가스:48.54:2.15,그라가스:49.41:1.04,올라프:49.6:0.51,카직스:47.91:3.45,제드:47.75:1.94,람머스:49.66:0.61,아트록스:48.45:0.85,로크:47.06:1.69,다이애나:47.96:1.3,피즈:48.22:0.63,녹턴:46.8:2.48,제이스:44.82:6.94,암베사:47.07:1.53,우디르:46.56:0.77,브라이어:46.04:1.13',
  MID: '트위스티드 페이트:51.28:12.73,사일러스:49.42:8.47,조이:53.16:3.92,갈리오:50.19:8.86,르블랑:49.18:5.07,야스오:50.68:5.23,아칼리:48.97:8.54,로크:48.72:6.59,리산드라:52.51:5.42,카타리나:50.89:5.48,제드:48.9:6.47,요네:48.98:8.23,탈리야:52.36:4.66,오리아나:48.89:8.51,탈론:51.64:3.53,아리:50.67:6.84,키아나:51.99:1.89,애니:56.67:1.8,빅토르:47.9:8.66,벡스:51.9:2.46,에코:51.14:3.83,신드라:48.05:7.55,흐웨이:50.17:3.49,피즈:52.69:2.72,애니비아:50.11:2.73,말자하:52.41:2.11,이렐리아:48.8:2.87,아우렐리온 솔:52:1.88,아크샨:51.38:2.29,오로라:49.81:3.21,판테온:52.28:1.74,스웨인:52.42:0.8,블라디미르:50.97:1.78,제이스:50.14:1.44,제라스:49.17:2.34,라이즈:49.1:2.36,다이애나:48.54:2.64,케일:50.32:0.64,사이온:52.84:0.86,카사딘:48.52:2.81,니코:49.87:0.77,트린다미어:52.16:0.56,누누와 윌럼프:49.15:1.07,베이가:49.72:0.73,아지르:46.21:3.83,럭스:47.17:1.55,카시오페아:46.7:2.62,암베사:49.27:0.84,벨코즈:49.22:0.52,트리스타나:46.72:0.96,코르키:45.54:1.32,루시안:41.85:0.64',
  ADC: '카이사:50.48:24.3,자야:51.95:12.45,드레이븐:52.97:2.67,진:49.79:28.79,유나라:50.85:10.92,코르키:51.25:10.66,징크스:51.3:5.17,칼리스타:49.53:6.93,미스 포츈:50.78:5.19,흐웨이:57.58:0.99,빅토르:52.39:1.53,아우렐리온 솔:55.76:0.76,스웨인:53.02:1.28,제리:49.65:7.62,코그모:51.95:1.51,아펠리오스:48.71:8.5,케이틀린:48.84:6.13,시비르:50.03:3.63,야스오:53.02:1.25,바루스:50.32:2.84,이즈리얼:46.83:28.43,트리스타나:49.47:2.86,카타리나:52.62:0.78,탈리야:50.39:1.83,트위치:50.79:1.41,카시오페아:50.89:0.91,애쉬:48.81:3.06,루시안:47.6:7.08,베인:53.16:0.93,직스:49.2:2.55,제라스:49.44:1.46,벨코즈:50:0.85,사미라:49.54:1.11,스몰더:47.14:1.42,신드라:47.87:0.76',
  SUP: '노틸러스:49.67:17.72,알리스타:53.24:12.91,쓰레쉬:50.18:10.45,룰루:49.28:11.43,블리츠크랭크:50.26:8.45,레오나:51.57:10.25,파이크:49.56:5.79,렐:52.44:7.34,뽀삐:51.69:3.44,바드:49.79:8.74,브라움:50.78:5.24,라칸:50.49:8.08,엘리스:54.8:2.01,자이라:54.61:1.46,갈리오:53.43:2.01,세나:51.13:4.15,니코:50.46:3.32,마오카이:51.94:2.57,레나타 글라스크:50.68:2.53,나미:51.2:2.89,소나:51.04:2.35,판테온:48.89:3.85,잔나:50.82:1.48,타릭:52.66:0.99,질리언:50.91:2.13,조이:51.17:0.87,카르마:47.16:9.55,소라카:49.58:2.16,세라핀:48.31:3.55,벨코즈:49.2:2.02,쉔:50.2:1.03,애니비아:53.98:0.59,스카너:50:0.7,아무무:53.11:0.62,자크:50.96:0.53,모르가나:48.39:1.64,제라스:49.11:1.6,탐 켄치:48.45:1.38,스웨인:47.54:1.82,사일러스:46.89:1.86,르블랑:47.86:0.81,밀리오:46.5:2.15,카밀:45.63:2.89,럭스:45.89:2.42,유미:45.12:3.97,샤코:47.29:0.94,흐웨이:44.31:0.7',
};
let G_LPM = null; // { POS: { champId: 승률 } } — 챔피언 목록(한글 이름)이 로드된 뒤 만든다
function lpsWr(id, pos) {
  if (!G_LPM && CHAMP.list.length) { const byKo = {}; CHAMP.list.forEach(c => byKo[c.name] = c.id); G_LPM = {}; for (const [p, s] of Object.entries(G_LPS)) { G_LPM[p] = {}; s.split(',').forEach(x => { const [n, w] = x.split(':'); if (byKo[n]) G_LPM[p][byKo[n]] = +w / 100 }) } }
  if (!G_LPM) return null;
  if (pos && G_LPM[pos]?.[id] != null) return G_LPM[pos][id];
  const all = Object.values(G_LPM).map(m => m[id]).filter(v => v != null); return all.length ? Math.max(...all) : null; // 주 라인에 없으면 가장 잘 되는 라인
}
const TIER_PRIOR = 10; // lol.ps 승률을 몇 판어치로 섞을지
const TIER_CUT = [0.05, 0.20, 0.45, 0.70, 0.90]; // 상위 5% OP · 20% 1티어 · 45% 2 · 70% 3 · 90% 4 · 나머지 5
function champTierScore(c, games) {
  const pos = Object.entries(c.posc).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const ref = lpsWr(c.id, pos), p0 = ref ?? 0.49; // 마스터+ 통계에 없으면 비주류 → 살짝 낮게
  const wr = (c.w + TIER_PRIOR * p0) / (c.n + TIER_PRIOR), pr = c.n / Math.max(1, games);
  return { sc: (wr - 0.5) * 100 + Math.min(5, pr * 25), wr, ref }; // 픽 존재감은 최대 +5점
}
// 점수 순위로 티어 매기기 (같은 화면의 챔피언끼리 비교) · OP는 5판 이상 쓴 챔피언만
function champTiers(champs, games) {
  const arr = champs.map(c => ({ c, ...champTierScore(c, games) })).sort((a, b) => b.sc - a.sc), N = arr.length, out = new Map();
  arr.forEach((x, i) => { const q = (i + 0.5) / N; let tier = TIER_CUT.findIndex(t => q <= t); if (tier < 0) tier = 5; if (tier === 0 && x.c.n < 5) tier = 1; out.set(x.c.id, { sc: x.sc, wr: x.wr, ref: x.ref, tier }) });
  return out;
}
const tierBadge = t => `<span class="g-tier t${t}">${t === 0 ? 'OP' : t}</span>`;
// 🧩 챔피언: 티어·픽·승률·KDA·CS/분·주 포지션·최다 사용 멤버
const G_CCOLS = [
  { k: 'tier', h: '티어', v: c => c.ts.sc },
  { k: 'n', h: '픽', v: c => c.n }, { k: 'pr', h: '픽률', v: c => c.pr }, { k: 'wr', h: '승률', v: c => c.w / c.n },
  { k: 'kda', h: 'KDA', v: c => (c.k + c.a) / Math.max(1, c.d) }, { k: 'csm', h: 'CS/분', v: c => c.sec ? c.cs / (c.sec / 60) : 0 },
];
function gChampsHTML(games, st) {
  const cs = GM.csort || 'tier', cd = GM.cdir || -1, col = G_CCOLS.find(c => c.k === cs) || G_CCOLS[0];
  const q = (GM.cq || '').trim().toLowerCase();
  const tiers = champTiers(st.champs.filter(c => c.id), games.length); // 검색과 상관없이 전체 챔피언끼리 비교
  const list = st.champs.filter(c => c.id && (!q || champName(c.id).toLowerCase().includes(q))).map(c => ({ ...c, pr: c.n / games.length, ts: tiers.get(c.id) }))
    .sort((a, b) => cd * (col.v(a) - col.v(b)) || b.n - a.n);
  const th = c => `<th class="g-sort ${cs === c.k ? 'on' : ''}" data-a="gcsort" data-v="${c.k}">${c.h}${cs === c.k ? (cd < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  return `<div class="card"><div class="h2">🧩 챔피언 통계 <span class="sub">${list.length}개 챔피언 · ${games.length}경기 · 게스트·unknown 포함 전체 경기 기준 · 누르면 상세</span>
      <input class="inp mla" style="width:180px" data-i="gcq" placeholder="🔍 챔피언 검색" value="${esc(GM.cq || '')}"></div>
    <div class="sub" style="margin:-4px 0 10px">🏅 <b>티어</b> = 우리 내전 승률·픽률로 매긴 점수 순위 (상위 5% OP · 20%까지 1티어 · 45% 2 · 70% 3 · 90% 4 · 나머지 5). 판수가 적은 챔피언은 lol.ps 승률(${G_LPS_PATCH} 패치 · 한국 마스터+ · 주 포지션${G_LPS_AT ? ` · ${new Date(G_LPS_AT).getMonth() + 1}/${new Date(G_LPS_AT).getDate()} 갱신` : ''}, 매일 오전 10시 자동 갱신)을 10판어치 섞어서 운빨을 줄였어요. OP는 5판 이상만</div>
    <div class="g-scroll"><table class="g-tbl g-rank"><thead><tr><th>챔피언</th>${G_CCOLS.map(th).join('')}<th>주 포지션</th><th>최다 사용 멤버</th></tr></thead>
      <tbody id="gctbody">${list.map(c => { const mp = Object.entries(c.posc).sort((a, b) => b[1] - a[1])[0], top = [...c.mem.entries()].sort((a, b) => b[1].n - a[1].n)[0], wr = c.w / c.n;
        return `<tr data-a="gchamp1" data-v="${esc(c.id)}"><td><div class="g-ch"><img src="${champImg(c.id)}" alt="">${esc(champName(c.id))}</div></td>
          <td>${tierBadge(c.ts.tier)}<span class="sub g-ext" title="lol.ps 한국 마스터+ 승률 (참고)">${c.ts.ref != null ? `솔랭 ${pct(c.ts.ref)}` : ''}</span></td><td>${c.n}</td><td>${pct(c.pr)}</td>
          <td><b class="${wr >= 0.5 ? 'g-up' : 'g-dn'}">${pct(wr)}</b></td><td>${((c.k + c.a) / Math.max(1, c.d)).toFixed(2)}</td><td>${c.sec ? (c.cs / (c.sec / 60)).toFixed(1) : '–'}</td>
          <td>${mp ? posLabel(mp[0]) : '–'}</td><td>${top ? `${esc(player(top[0])?.name || '?')} <span class="sub">${top[1].n}판</span>` : '–'}</td></tr>` }).join('')}</tbody></table></div></div>`;
}
function gChampModal(id) {
  const st = gStats(gFiltered(), GM.pos || 'ALL'), c = st.champs.find(x => x.id === id); if (!c) return;
  const mem = [...c.mem.entries()].sort((a, b) => b[1].n - a[1].n);
  modal(`<div class="mh"><span class="g-ch"><img src="${champImg(id)}" alt="">${esc(champName(id))}</span> <span class="sub">${seasonName(gSeasonSel())}</span></div>
    <div class="g-hl" style="margin:12px 0"><div class="g-hlc"><b>${c.n}</b><span>픽</span></div><div class="g-hlc"><b>${pct(c.w / c.n)}</b><span>승률 · ${c.w}승 ${c.n - c.w}패</span></div>
      <div class="g-hlc"><b>${((c.k + c.a) / Math.max(1, c.d)).toFixed(2)}</b><span>KDA · ${(c.k / c.n).toFixed(1)} / ${(c.d / c.n).toFixed(1)} / ${(c.a / c.n).toFixed(1)}</span></div>
      <div class="g-hlc"><b>${c.sec ? (c.cs / (c.sec / 60)).toFixed(1) : '–'}</b><span>CS/분</span></div></div>
    <div class="sub">포지션: ${Object.entries(c.posc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${posLabel(k)} ${n}판`).join(' · ') || '–'}</div>
    <div class="h2" style="margin-top:14px">👤 이 챔피언을 한 멤버</div>
    <div class="g-scroll"><table class="g-tbl"><thead><tr><th>멤버</th><th>판수</th><th>승률</th><th>KDA</th></tr></thead><tbody>
      ${mem.map(([m, x]) => `<tr data-a="gplayer" data-id="${m}"><td>${esc(player(m)?.name || '?')}</td><td>${x.n}</td><td><b class="${x.w / x.n >= 0.5 ? 'g-up' : 'g-dn'}">${pct(x.w / x.n)}</b></td><td>${((x.k + x.a) / Math.max(1, x.d)).toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="4" class="sub">멤버 기록이 없어요</td></tr>'}</tbody></table></div>
    <div class="mbtns"><button class="btn pri" data-a="mclose">닫기</button></div>`, false, 'wide');
}
// 멤버 상세: 기본 지표 · 포지션별 · 모스트 챔피언 · 베스트/워스트 듀오
function gPlayerModal(mid) {
  const games = gFiltered();
  const need = exposeNeed(games.length) || 0, w = rankW(), st = gRanked(games, need, w), s = st.rows.find(r => r.id === mid), m = player(mid);
  if (!s || !m) return;
  const rank = st.ranked.indexOf(s);
  const ch = {}, duo = new Map(), byPos = {};
  games.forEach(g => g.teams.forEach((t, ti) => { const me = t.players.find(p => memberOf(p.rid) === mid); if (!me) return; const won = g.win === ti + 1;
    const bp = byPos[me.pos || '?'] || (byPos[me.pos || '?'] = { n: 0, w: 0, k: 0, d: 0, a: 0 }); bp.n++; if (won) bp.w++; bp.k += me.k; bp.d += me.d; bp.a += me.a;
    t.players.forEach(p => { const pm = memberOf(p.rid);
      if (pm === mid) { const c = ch[p.champ] || (ch[p.champ] = { n: 0, w: 0, k: 0, d: 0, a: 0 }); c.n++; if (won) c.w++; c.k += p.k; c.d += p.d; c.a += p.a }
      else if (pm != null && pm !== 'guest') { const d = duo.get(pm) || { n: 0, w: 0 }; d.n++; if (won) d.w++; duo.set(pm, d) } }) }));
  const duos = [...duo.entries()].filter(([, d]) => d.n >= 3).map(([id, d]) => ({ id, ...d, wr: d.w / d.n }));
  const best = [...duos].sort((a, b) => b.wr - a.wr || b.n - a.n).slice(0, 3), worst = [...duos].sort((a, b) => a.wr - b.wr || b.n - a.n).slice(0, 2);
  const duoH = d => `<div class="g-duo"><b>${esc(player(d.id)?.name || '?')}</b><span class="sub">${d.n}게임 함께</span><b class="${d.wr >= 0.5 ? 'g-up' : 'g-dn2'}">${pct(d.wr)}</b></div>`;
  modal(`<div class="mh">${nmH(m)} <span class="sub">${seasonName(gSeasonSel())} · ${rank >= 0 ? `종합 ${rank + 1}위 · ${s.score.toFixed(1)}점` : `${need - s.n}판 더 하면 순위 진입`}</span></div>
    <div class="g-hl" style="margin:12px 0">
      <div class="g-hlc"><b>${s.n}</b><span>게임</span></div><div class="g-hlc"><b>${s.perfect ? 'Perfect' : s.kda.toFixed(2)}</b><span>KDA</span></div>
      <div class="g-hlc"><b>${pct(s.wr)}</b><span>승률 · ${s.w}승 ${s.l}패</span></div><div class="g-hlc"><b>${s.csm.toFixed(1)}</b><span>CS/분</span></div></div>
    <div class="sub">평균 ${(s.k / s.n).toFixed(1)} / ${(s.d / s.n).toFixed(1)} / ${(s.a / s.n).toFixed(1)} · 킬관여 ${pct(s.kp)} · 분당 골드 ${Math.round(s.gpm).toLocaleString()} · 챔피언 ${s.pool}개 · 최장 ${s.best}연승</div>
    <div class="h2" style="margin-top:14px">📍 포지션별</div>
    <div class="g-scroll"><table class="g-tbl"><thead><tr><th>포지션</th><th>판수</th><th>승률</th><th>KDA</th></tr></thead><tbody>
      ${Object.entries(byPos).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => `<tr><td>${k === '?' ? '포지션 정보 없음' : posLabel(k)}</td><td>${x.n}</td><td><b class="${x.w / x.n >= 0.5 ? 'g-up' : 'g-dn'}">${pct(x.w / x.n)}</b></td><td>${((x.k + x.a) / Math.max(1, x.d)).toFixed(2)}</td></tr>`).join('')}</tbody></table></div>
    <div class="h2" style="margin-top:14px">🧩 챔피언 <span class="sub">${Object.keys(ch).length}개</span></div>
    <div class="g-champs">${Object.entries(ch).sort((a, b) => b[1].n - a[1].n).map(([id, c]) => `<div class="g-champ"><img src="${champImg(id)}" alt=""><div><b>${esc(champName(id))}</b><span class="sub">${c.n}판 · 승률 ${pct(c.w / c.n)} · KDA ${((c.k + c.a) / Math.max(1, c.d)).toFixed(2)}</span></div></div>`).join('')}</div>
    <div class="row2" style="margin-top:14px"><div><div class="h2">🤝 베스트 듀오</div>${best.map(duoH).join('') || '<div class="sub">3게임 이상 함께한 멤버가 없어요</div>'}</div>
      <div><div class="h2">💔 워스트 듀오</div>${worst.map(duoH).join('') || '<div class="sub">—</div>'}</div></div>
    <div class="mbtns"><button class="btn pri" data-a="mclose">닫기</button></div>`, false, 'wide');
}
// 운영진: 순위 공식 수정 (사이트 데이터 S.rankW 에 저장)
function gRankWModal() {
  if (!isAdmin()) return toast(RO_MSG, 'err');
  const w = rankW(), f = (k, label, step, hint) => `<div><label class="fl">${label}</label><input class="inp" type="number" step="${step}" id="rw_${k}" value="${w[k]}" style="width:100%"><div class="sub">${hint}</div></div>`;
  modal(`<div class="mh">⚙️ 종합 순위 공식</div>
    <div class="sub">점수 = KDA* × <b>KDA 가중치</b> + 승률(%) × <b>승률 가중치</b> + ln(판수) × <b>판수 가중치</b> · 기본값은 내전롤 '밸런스' 방식</div>
    <div class="af" style="margin-top:12px">
      <div class="row2">${f('kda', 'KDA 가중치', '0.5', '기본 15')}${f('wr', '승률 가중치', '0.1', '기본 1.0 (승률 %에 곱함)')}</div>
      <div class="row2">${f('games', '판수 가중치', '0.5', '기본 15 (ln 판수에 곱함)')}${f('cap', 'KDA 상한 기준', '0.5', '기본 4.0 · 이 값을 넘는 KDA는')}</div>
      <div class="row2">${f('capRate', '상한 초과분 반영 비율', '0.05', '기본 0.4 (= 40%만 반영)')}<div></div></div>
      <div class="sub">순위에 필요한 최소 판수는 🏆 팀 대항전 → 🧮 점수 기준의 "순위 노출 조건"을 따라요</div>
    </div>
    <div class="mbtns"><button class="btn" data-a="grwreset">기본값으로</button><button class="btn" data-a="mclose">취소</button><button class="btn pri" data-a="grwsave">저장</button></div>`, false, 'wide');
}
// 기록 탭 필터 (시즌 · 경기 종류)
const gRSeason = () => GM.rseason === 'cur' ? curSeason() : GM.rseason;
const gFilterHTML = () => { const sel = gRSeason(); return `<div class="card toolbar g-filters">
  <select class="inp" data-c="grseason">${gSeasonList().map(n => `<option value="${n}" ${sel === n ? 'selected' : ''}>${seasonName(n)}${n === curSeason() ? ' · 이번 시즌' : ''}</option>`).join('')}<option value="all" ${sel === 'all' ? 'selected' : ''}>${seasonName('all')}</option></select>
  <div class="g-seg">${[['all', '전체'], ['casual', G_TYPES.casual], ['team', G_TYPES.team]].map(([k, n]) => `<button class="chip ${GM.rf === k ? 'on' : ''}" data-a="grf" data-v="${k}">${n}</button>`).join('')}</div></div>` };
// 기록 탭: 제목 + 오늘 사용량 + 올리기 버튼 + 종류 필터
function gHeadHTML(title, sub) {
  const q = GM.quota, connected = !!(fb && fb.fs);
  return `<div class="sec-head"><div><div class="h1">${title}</div>
    <div class="sub">${sub} · 누구나 올릴 수 있고, 저장된 기록 수정은 운영진만 · 이 화면에 <b style="color:var(--txt)">끌어다 놓거나 Ctrl+V</b>로도 올릴 수 있어요</div></div>
    <div class="row gap wrapr">${q && !q.pending ? `<span class="tag ${q.used >= q.limit ? 't-red' : 't-mut'}">오늘 ${q.used} / ${q.limit}장</span>` : ''}<button class="btn pri" data-a="gup" ${connected ? '' : 'disabled'}>📤 결과 올리기</button></div></div>
  ${gFilterHTML()}`;
}
function gAfterRender() {
  const connected = !!(fb && fb.fs);
  if (!CHAMP.v) champLoad().then(() => gTabOpen() && render()).catch(() => {});
  if (!GM.quota && connected) { GM.quota = { used: 0, limit: 0, pending: true }; refreshQuota() }
}
// 📜 내전 기록 탭: 올라온 경기 전체 + 예전 팀대항전 캡처
function renderGameRecords() {
  const rs = gRSeason(), inSeason = GM.games.filter(g => rs === 'all' || g.season === rs);
  const games = inSeason.filter(g => GM.rf === 'all' || g.type === GM.rf), connected = !!(fb && fb.fs);
  const cnt = k => inSeason.filter(g => g.type === k).length;
  V.innerHTML = `${gHeadHTML('📜 기록', `${seasonName(rs)} · 일반 내전 ${cnt('casual')}판 · 팀대항전 ${cnt('team')}판 · 카드를 누르면 상세 결과와 원본 스크린샷`)}
  ${!connected ? `<div class="empty-note card">🔌 서버에 연결되면 기록이 보여요</div>` : !GM.got ? `<div class="empty-note card">⏳ 불러오는 중…</div>` : gGamesHTML(games)}
  ${REC.items.length ? `<details class="card g-old"><summary>📁 예전 팀대항전 캡처 ${REC.items.length}장 <span class="sub">(통계 기능 이전에 올린 이미지)</span></summary>
    <div class="rec-grid" style="margin-top:12px">${REC.items.map(x => `<div class="rec-card" data-a="recview" data-id="${esc(x.id)}"><div class="th2" style="background-image:url('${x.thumb}')"></div>
      <div class="ti"><b>${esc(x.title)}</b><span>${esc(x.date)}</span></div></div>`).join('')}</div></details>` : ''}`;
  gAfterRender();
}
function gGamesHTML(games) {
  if (!games.length) return `<div class="card empty-note" style="padding:40px 14px">📭 아직 올라온 경기가 없어요</div>`;
  return `<div class="g-games">${games.map(g => `<div class="card g-game" data-a="gview1" data-id="${esc(g.id)}">
    <div class="g-gh"><span class="tag ${g.type === 'team' ? 't-gold' : 't-teal'}">${G_TYPES[g.type]}</span><b>${esc(g.date)}</b><span class="sub">${esc(g.dur)}</span></div>
    ${g.teams.map((t, ti) => `<div class="g-gt ${g.win === ti + 1 ? 'win' : 'lose'}"><span class="g-res">${g.win === ti + 1 ? '승' : '패'}</span>${t.players.map(p => `<img src="${champImg(p.champ)}" alt="" title="${esc(champName(p.champ))} · ${esc(p.rid)}">`).join('')}<span class="sub">${t.k}/${t.d}/${t.a}</span></div>
      <div class="g-gn">${t.players.map(p => { const m = memberOf(p.rid); return esc(m === 'guest' || m == null ? (p.rid || '?') : player(m).name) }).join(' · ')}</div>`).join('')}
  </div>`).join('')}</div>`;
}
async function gViewGame(id) {
  const g = GM.games.find(x => x.id === id); if (!g) return; const A = isAdmin();
  const nameH = rid => { if (!rid) return '<span class="tag t-mut">이름 없음</span>'; const m = memberOf(rid); return m === 'guest' ? `${esc(rid)} <span class="tag t-mut">게스트</span>` : m != null ? `${esc(player(m).name)} <span class="sub">${esc(rid)}</span>` : `${esc(rid)} <span class="tag t-amber">unknown</span>` };
  const body = img => modal(`<div class="mh">${G_TYPES[g.type]} · ${esc(g.date)} <span class="sub">${esc(g.dur)}</span></div>
    ${g.teams.map((t, ti) => `<div class="g-team ${g.win === ti + 1 ? 'win' : 'lose'}"><div class="g-th"><b>${ti + 1}번 팀 · ${g.win === ti + 1 ? '승리' : '패배'}</b><span class="sub">${t.k} / ${t.d} / ${t.a}</span></div>
      <div class="g-scroll"><table class="g-tbl"><thead><tr><th>챔피언</th><th>포지션</th><th>멤버</th><th>Lv</th><th>K / D / A</th><th>CS</th><th>골드</th></tr></thead><tbody>
      ${t.players.map(p => `<tr><td><div class="g-ch"><img src="${champImg(p.champ)}" alt="">${esc(champName(p.champ))}</div></td><td class="sub">${p.pos ? posLabel(p.pos) : '–'}</td><td>${nameH(p.rid)}</td><td>${p.lv || '–'}</td><td>${p.k} / ${p.d} / ${p.a}</td><td>${p.cs}</td><td>${p.gold.toLocaleString()}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}
    <div class="rec-full" style="margin-top:12px">${img ? `<img src="${img}" alt="">` : img === '' ? (g.src === 'naejeon' ? '<div class="sub">📥 내전롤에서 가져온 기록이라 원본 스크린샷이 없어요</div>' : '') : `<div class="hvid-ph" style="aspect-ratio:16/9">🖼️ 원본 스크린샷 불러오는 중…</div>`}</div>
    <div class="mbtns" style="flex-wrap:wrap">${A ? `<button class="btn sm danger" data-a="gmdel" data-id="${esc(id)}" style="margin-right:auto">🗑 삭제</button><button class="btn sm" data-a="gedit" data-id="${esc(id)}">✏️ 수정</button>` : ''}<button class="btn pri" data-a="mclose">닫기</button></div>`, false, 'full');
  body(null);
  try { const s = await fb.fs.getDoc(gDoc('shots', id)); if (!M.classList.contains('hidden')) body(s.exists() ? s.data().img : '') } catch (e) { console.error(e); body('') }
}
// 닉네임 합치기 추천: 같은 경기에 함께 나온 멤버는 제외하고, 이름(자모)이 비슷한 멤버를 고른다
function gSuggest(rid) {
  const conflict = new Set();
  GM.games.forEach(g => { const ps = g.teams.flatMap(t => t.players); if (!ps.some(p => nkey(p.rid) === nkey(rid))) return; ps.forEach(p => { const m = memberOf(p.rid); if (m != null && m !== 'guest') conflict.add(m) }) });
  const aliases = new Map(); Object.values(GM.ids).forEach(v => { if (v.mid !== 'guest') { if (!aliases.has(v.mid)) aliases.set(v.mid, []); aliases.get(v.mid).push(v.name) } });
  const j = jamo(rid);
  return S.players.filter(m => !conflict.has(m.id)).map(m => {
    const names = [m.name, ...(aliases.get(m.id) || [])];
    const sim = Math.max(...names.map(n => { const jn = jamo(n); return 1 - lev(j, jn) / Math.max(j.length, jn.length, 1) }));
    return { id: m.id, sim };
  }).filter(x => x.sim >= 0.5).sort((a, b) => b.sim - a.sim).slice(0, 2);
}
// 통계 탭 아래 운영진 설정 (닉네임 합치기는 👥 멤버 → ❔ 미등록 닉네임으로 옮김)
function gAdminHTML() {
  const q = GM.quota;
  return `<div class="card"><div class="h2">📏 운영진 · 하루 업로드 한도 <span class="sub">한국 시간 자정에 초기화 · 운영진 업로드는 한도에서 빠져요</span></div>
    <div class="row gap"><input class="inp num" type="number" min="0" max="500" id="gLimit" value="${q && !q.pending ? q.limit : ''}" style="width:90px"><span>장 / 하루</span><button class="btn sm gold" data-a="glimit">저장</button>${q && !q.pending ? `<span class="sub">오늘 ${q.used}장 사용</span>` : ''}</div>
  </div>`;
}
async function gSetLink(rid, v) {
  if (!isAdmin()) return toast(RO_MSG, 'err');
  const ref = gDoc('ids', idDocId(nkey(rid)));
  try { if (!v) await fb.fs.deleteDoc(ref); else await fb.fs.setDoc(ref, { name: rid, mid: v === 'guest' ? 'guest' : Number(v), at: Date.now() });
    toast(v ? `🔀 '${rid}' → ${v === 'guest' ? '게스트' : player(+v)?.name} · 통계에 바로 합산돼요` : `🔗 '${rid}' 연결을 끊었어요`) }
  catch (e) { console.error(e); toast('저장 실패 — ' + explain(e).t, 'err') }
}

/* ---------- 이벤트 ---------- */
const gP = el => GUP?.draft?.teams[+el.dataset.t]?.players[+el.dataset.p];
Object.assign(ACT, {
  gup: () => $('#gamef').click(),
  gfilter: el => { GM.filter = el.dataset.v; render() },
  gview: el => { GM.view = el.dataset.v; render() },
  gsort: el => { if (GM.sort === el.dataset.v) GM.dir = -GM.dir; else { GM.sort = el.dataset.v; GM.dir = -1 } render() },
  gcsort: el => { if (GM.csort === el.dataset.v) GM.cdir = -GM.cdir; else { GM.csort = el.dataset.v; GM.cdir = -1 } render() },
  gposf: el => { GM.pos = el.dataset.v; render() },
  grf: el => { GM.rf = el.dataset.v; render() },
  gchamp1: el => gChampModal(el.dataset.v),
  gtype: el => { if (!GUP?.draft) return; GUP.draft.type = el.dataset.v; gModal() },
  gsave: el => gSave(el.dataset.v === 'force'),
  gskip: () => { if (!GUP || GUP.busy) return; if (GUP.i + 1 < GUP.n) { GUP.i++; gNext() } },
  gretry: () => GUP && gNext(),
  gview1: el => gViewGame(el.dataset.id),
  gplayer: el => gPlayerModal(Number(el.dataset.id)),
  // 순위표: 넓은 화면은 옆 카드 갱신, 좁은 화면은 바로 상세 창
  gsel: el => { const id = Number(el.dataset.id); if (innerWidth < 980) return gPlayerModal(id); GM.sel = id; const y = scrollY; render(); scrollTo(0, y) },
  grwedit: () => gRankWModal(),
  grwreset: () => { const w = DEF_RW; Object.keys(w).forEach(k => { const i = $('#rw_' + k); if (i) i.value = w[k] }) },
  grwsave: () => {
    const w = {}; for (const k of Object.keys(DEF_RW)) { const v = +($('#rw_' + k)?.value); if (!Number.isFinite(v) || v < 0 || v > 1000) return toast('0 이상의 숫자로 적어주세요', 'err'); w[k] = v }
    if (commit(() => { S.rankW = w })) { closeModal(); toast('⚙️ 순위 공식을 바꿨어요 · 모든 화면에 바로 반영돼요') }
  },
  gedit: el => gEditGame(el.dataset.id),
  gmdel: el => { if (!isAdmin()) return toast(RO_MSG, 'err'); const id = el.dataset.id;
    ask('🗑 경기 기록 삭제', '이 경기 기록과 원본 스크린샷을 지울까요? 통계에서도 빠지고, 되돌릴 수 없어요.', async () => {
      try { await fb.fs.deleteDoc(gDoc('games', id)); await fb.fs.deleteDoc(gDoc('shots', id)); toast('🗑 삭제했어요') } catch (e) { console.error(e); toast('삭제 실패 — ' + explain(e).t, 'err') } }, '삭제') },
  glimit: async () => { const n = +($('#gLimit')?.value); try { await gApi({ action: 'setLimit', limit: n }); toast(`📏 하루 ${n}장으로 바꿨어요`); render() } catch (e) { toast(e.message, 'err') } },
});
Object.assign(CHG, {
  gchamp: el => { const p = gP(el); if (!p) return; p.champ = el.value; p.sure = true; gRefreshChecks() },
  // 같은 팀에서 이미 그 포지션인 사람과 서로 바꿔 준다
  gpos: el => { const t = GUP?.draft?.teams[+el.dataset.t], p = gP(el); if (!p) return; const other = t.players.find(x => x !== p && x.pos === el.value && el.value); if (other) { other.pos = p.pos; other.posGuess = false } p.pos = el.value; p.posGuess = false; gRefreshChecks() },
  gnum: el => { const p = gP(el); if (!p) return; p[el.dataset.f] = int0(el.value); gRefreshChecks() },
  grid: el => { const p = gP(el); if (!p) return; const r = resolveName(el.value); p.rid = r.rid; p.read = el.value; p.how = r.how === 'fuzzy' ? 'fuzzy' : r.how; gRefreshChecks() },
  gmem: el => { const p = gP(el); if (!p) return; p.pick = el.value; el.classList.toggle('unk', !el.value) },
  gwin: el => { if (!GUP?.draft) return; GUP.draft.win = +el.value; gRefreshChecks() },
  gdate: el => { if (!GUP?.draft) return; GUP.draft.date = el.value; const l = $('#gSeasonLbl'); if (l) l.textContent = `→ ${seasonName(seasonOf(el.value))} 기록`; gRefreshChecks() },
  gdur: el => { if (!GUP?.draft) return; GUP.draft.dur = el.value.trim(); gRefreshChecks() },
  glink: el => gSetLink(el.dataset.v, el.value),
  gseason: el => { GM.season = el.value === 'all' ? 'all' : +el.value; render() },
  grseason: el => { GM.rseason = el.value === 'all' ? 'all' : +el.value; render() },
  gbseason: el => { GM.bseason = +el.value; render() },
});
// 검색창: 입력 중 포커스를 잃지 않게 목록만 다시 그림
Object.assign(INP, {
  gpq: el => { GM.pq = el.value; const pos = el.selectionStart; render(); const n = $('[data-i="gpq"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch (_) {} } },
  gcq: el => { GM.cq = el.value; const pos = el.selectionStart; render(); const n = $('[data-i="gcq"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch (_) {} } },
});
Object.assign(ACT, {
  gmerge: el => gSetLink(el.dataset.v, el.dataset.id),
  gunlink: el => { const rid = el.dataset.v; ask('🔗 연결 끊기', `'${esc(rid)}' 닉네임을 멤버에서 떼어낼까요? 이 닉네임으로 뛴 기록이 그 멤버 통계에서 빠지고 unknown이 돼요.`, () => gSetLink(rid, ''), '끊기') },
});
const gFileIn = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true, id: 'gamef' });
document.body.append(gFileIn);
gFileIn.addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) gOpenUpload(fs) });
document.addEventListener('toggle', e => { if (e.target.classList?.contains('g-det')) UI.gDetOpen = e.target.open }, true);
const gUpTab = () => UI.tab === 'records' && M.classList.contains('hidden'); // 결과 올리기는 기록 탭에서만
document.addEventListener('paste', e => {
  if (!gUpTab()) return;
  const fs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile());
  if (fs.length) { e.preventDefault(); gOpenUpload(fs) }
});
// 통계·기록 탭에 이미지 파일을 끌어다 놓으면 바로 올리기
const gDropCover = Object.assign(document.createElement('div'), { className: 'g-drop', innerHTML: '<div>📤 여기에 놓으면 결과창을 올려요</div>' });
document.body.append(gDropCover);
let gDragDepth = 0;
const gHasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (gUpTab() && gHasFiles(e)) { gDragDepth++; gDropCover.classList.add('on') } });
document.addEventListener('dragleave', e => { if (gHasFiles(e) && --gDragDepth <= 0) { gDragDepth = 0; gDropCover.classList.remove('on') } });
document.addEventListener('dragover', e => { if (gUpTab() && gHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } });
document.addEventListener('drop', e => {
  gDragDepth = 0; gDropCover.classList.remove('on');
  if (!gUpTab() || !gHasFiles(e)) return;
  e.preventDefault(); gOpenUpload(e.dataTransfer.files);
});
const gBusy = () => !!GUP?.busy || GUP?.step === 'read';
const gOnClose = () => { GUP = null };
// 서버 연결이 이 파일보다 먼저 끝났으면 index.html 쪽 호출을 놓쳤으니 여기서 시작
if (fb && fb.fs && !GM.unsub.length) startGamesSync();

/* ---------- 🏠 홈: 이번 시즌 일반 내전 하이라이트 ---------- */
function gHomeHTML() {
  if (!GM.got) return `<div class="card empty-note">⏳ 내전 기록 불러오는 중…</div>`;
  const cs = curSeason(), games = GM.games.filter(g => g.season === cs && g.type === 'casual');
  if (!games.length) return `<div class="card empty-note" style="padding:30px 14px">📭 ${seasonName(cs)} 일반 내전 기록이 아직 없어요<br><span class="sub">📜 기록 탭에서 결과 스크린샷을 올리면 여기에 하이라이트가 떠요</span></div>`;
  const need = exposeNeed(games.length) || 0, st = gRanked(games, need, rankW()), nm = id => esc(player(id)?.name || '?');
  const aw = Object.fromEntries(gAwards(games, st, need).map(a => [a.n, a]));
  const awH = a => a ? `<div class="g-award"><div class="g-aw-e">${a.e}</div><div class="g-aw-b"><div class="g-aw-t">${a.n}</div><div class="g-aw-w">${a.who}</div><div class="g-aw-v">${a.val}${a.sub ? ` <span class="sub">· ${a.sub}</span>` : ''}</div></div></div>` : '';
  // 최근 폼: 최근 10판 승률 (5판 이상)
  const form = st.rows.filter(s => s.seq.length >= 5).map(s => { const r = s.seq.slice(-10); return { s, w: r.filter(Boolean).length, n: r.length } }).sort((a, b) => b.w / b.n - a.w / a.n || b.n - a.n)[0];
  const formA = form && { e: '📈', n: '최근 폼 1위', who: nm(form.s.id), val: `최근 ${form.n}판 ${form.w}승 · 승률 ${pct(form.w / form.n)}` };
  // 지난 내전 하이라이트: 마지막 날짜의 경기
  const last = games.reduce((m, g) => g.date > m ? g.date : m, ''), day = games.filter(g => g.date === last);
  const dayMvp = Object.fromEntries(gAwards(day, gStats(day), 0).map(a => [a.n, a]))['MVP 빈도'];
  let bestK = null; day.forEach(g => g.teams.forEach(t => t.players.forEach(p => { const m = memberOf(p.rid); if (m != null && m !== 'guest' && (!bestK || p.k > bestK.k)) bestK = { ...p, m } })));
  // 챔피언: 많이 뽑힌 3 · 우리 티어 상위 3
  const tiers = champTiers(st.champs.filter(c => c.id), games.length);
  const chH = (c, sub) => `<div class="g-smost"><img src="${champImg(c.id)}" alt=""><div><b>${esc(champName(c.id))}</b><span class="sub">${sub}</span></div>${tierBadge(tiers.get(c.id)?.tier ?? 5)}</div>`;
  const picked = [...st.champs].filter(c => c.id).sort((a, b) => b.n - a.n).slice(0, 3), best = [...st.champs].filter(c => c.id).sort((a, b) => (tiers.get(b.id)?.sc ?? -99) - (tiers.get(a.id)?.sc ?? -99)).slice(0, 3);
  const top1 = st.ranked[0];
  return `<div class="stats">
    <div class="stat"><span class="e">🎮</span><div class="k">${seasonName(cs)} 내전</div><div class="v">${games.length}<small>판</small></div></div>
    <div class="stat"><span class="e">👥</span><div class="k">참가 멤버</div><div class="v">${st.rows.length}<small>명</small></div></div>
    <div class="stat"><span class="e">📅</span><div class="k">마지막 내전</div><div class="v" style="font-size:20px;padding-top:6px">${last.slice(5).replace('-', '/')}</div></div>
    <div class="stat"><span class="e">👑</span><div class="k">시즌 1위</div><div class="v" style="font-size:18px;padding-top:6px">${top1 ? nm(top1.id) : '–'}</div></div>
  </div>
  <div class="home-grid">
    <div class="card"><div class="h2">🔥 지금 뜨거운 사람들</div><div class="g-awards h-aw">${[aw['연승 중'], aw['연패 중'], formA].map(awH).join('') || '<div class="empty-note">아직 기록이 부족해요</div>'}</div></div>
    <div class="card"><div class="h2">🤝 케미 기록 <span class="sub">5판 이상 조합</span></div><div class="g-awards h-aw">${[aw['최고의 듀오'], aw['최악의 듀오'], aw['인간상성']].map(awH).join('') || '<div class="empty-note">아직 기록이 부족해요</div>'}</div></div>
    <div class="card"><div class="h2">🏆 ${seasonName(cs)} 순위 TOP 5 <button class="btn sm mla" data-a="tab" data-v="stats">전체 순위 ›</button></div>
      <div class="toplist">${st.ranked.slice(0, 5).map((s, i) => `<div class="trow"><span class="rk">${['🥇', '🥈', '🥉', '4', '5'][i]}</span><b>${nm(s.id)}</b> <span class="sub">${s.n}판 · 승률 ${pct(s.wr)} · KDA ${s.kda.toFixed(2)}</span><span class="sc">${s.score.toFixed(1)}</span></div>`).join('') || `<div class="empty-note">${need}판 이상 뛴 멤버가 아직 없어요</div>`}</div></div>
    <div class="card"><div class="h2">🧩 요즘 핫한 챔피언</div>
      <div class="sub" style="margin:2px 0 6px">많이 뽑힌</div>${picked.map(c => chH(c, `${c.n}픽 · 승률 ${pct(c.w / c.n)}`)).join('')}
      <div class="sub" style="margin:10px 0 6px">우리 티어 최상위</div>${best.map(c => chH(c, `${c.n}픽 · 승률 ${pct(c.w / c.n)}`)).join('')}</div>
    <div class="card"><div class="h2">📅 지난 내전 하이라이트 <span class="sub">${last} · ${day.length}판</span></div>
      <div class="g-awards h-aw">${awH(dayMvp ? { ...dayMvp, n: '그날 MVP' } : null)}${bestK ? awH({ e: '🗡️', n: '한 판 최다 킬', who: nm(bestK.m), val: `${bestK.k}킬 (${bestK.k}/${bestK.d}/${bestK.a})`, sub: esc(champName(bestK.champ)) }) : ''}</div>
      <button class="btn sm" style="margin-top:10px" data-a="tab" data-v="records">📜 그날 기록 보기 ›</button></div>
  </div>`;
}

/* ---------- 📋 명단표 옆: 일반 내전 시즌 순위 (예전 내전롤 리더보드 자리) ---------- */
// 기본은 이번 시즌, 이번 시즌 기록이 아직 없으면 직전 시즌 (예: 12월 초엔 시즌 4 최종 순위)
const gBoardSeason = () => GM.bseason || (GM.games.some(g => g.season === curSeason() && g.type === 'casual') ? curSeason() : curSeason() - 1);
function gBoardHTML() {
  const bs = gBoardSeason(), games = GM.games.filter(g => g.season === bs && g.type === 'casual');
  const need = exposeNeed(games.length) || 0, st = gRanked(games, need, rankW());
  const opts = gSeasonList().map(n => `<option value="${n}" ${n === bs ? 'selected' : ''}>${seasonName(n)}${n === curSeason() ? ' · 이번 시즌' : ''}</option>`).join('');
  const row = (s, i) => `<tr class="${i == null ? 'g-unranked' : ''}"><td class="g-rk">${i == null ? `<span class="sub">${need - s.n}판 더</span>` : i + 1}</td><td class="g-nm">${esc(player(s.id)?.name || '?')}</td><td>${s.n}</td><td><b class="${s.wr >= 0.5 ? 'g-up' : 'g-dn'}">${pct(s.wr)}</b></td><td>${s.kda.toFixed(2)}</td><td class="g-score">${s.score.toFixed(1)}</td></tr>`;
  return `<div class="card board"><div class="h2">🏆 일반 내전 순위 <select class="inp mla" style="width:auto;padding:4px 8px" data-c="gbseason">${opts}</select></div>
    <div class="sub" style="margin:-4px 0 8px">${games.length}판 · ${need ? `${need}판 이상만 순위` : '전원 순위'} · 📊 통계 탭과 같은 점수</div>
    ${!GM.got ? '<div class="empty-note">⏳ 불러오는 중…</div>' : !games.length ? `<div class="empty-note">${seasonName(bs)} 일반 내전 기록이 아직 없어요</div>`
    : `<div class="g-scroll"><table class="g-tbl g-rank"><thead><tr><th>#</th><th>멤버</th><th>판</th><th>승률</th><th>KDA</th><th>점수</th></tr></thead>
      <tbody>${st.ranked.map((s, i) => row(s, i)).join('')}${st.rest.map(s => row(s, null)).join('')}</tbody></table></div>`}</div>`;
}

/* ---------- 스타일 ---------- */
document.head.append(Object.assign(document.createElement('style'), { textContent: `
.g-seg{display:flex;gap:6px;flex-wrap:wrap}
.g-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.g-tbl{width:100%;border-collapse:collapse;font-size:13px}
.g-tbl th{color:var(--mut);font-size:11.5px;font-weight:800;text-align:left;padding:6px 6px;border-bottom:1px solid var(--line2);white-space:nowrap}
.g-tbl td{padding:5px 6px;border-bottom:1px solid var(--line2);white-space:nowrap;vertical-align:middle}
.g-tbl th.bad{color:var(--red)}
.g-rank td{padding:8px 6px}
.g-sort{cursor:pointer;user-select:none}.g-sort.on{color:var(--teal2)}
.g-rk{font-weight:900;color:var(--gold2);width:28px}
.g-up{color:var(--teal2)}.g-dn{color:var(--mut)}
.g-most{position:relative;display:inline-block;margin-right:3px}.g-most img{width:24px;height:24px;border-radius:50%;vertical-align:middle;border:1px solid var(--line)}
.g-most i{position:absolute;right:-4px;bottom:-4px;font-style:normal;font-size:9.5px;font-weight:900;background:var(--panel2);border-radius:6px;padding:0 3px}
.g-hidden{margin-top:12px}.g-hidden summary{cursor:pointer;color:var(--mut);font-weight:800;font-size:13px}
.g-read{display:flex;gap:16px;align-items:center;margin:14px 0}.mbox .g-read img{width:260px;max-width:45%;border-radius:10px}
.mbox.full .g-thumb{width:300px;max-width:100%}.mbox.full .g-ch img{width:28px;height:28px;border-radius:50%;display:inline-block}
.g-spin{width:28px;height:28px;border:3px solid var(--line2);border-top-color:var(--teal);border-radius:50%;animation:gspin 1s linear infinite;margin-bottom:8px}
@keyframes gspin{to{transform:rotate(360deg)}}
.g-top{display:flex;gap:14px;margin:12px 0;align-items:flex-start;flex-wrap:wrap}.g-thumb{width:260px;max-width:100%;border-radius:10px;border:1px solid var(--line2)}
.g-meta{flex:1;min-width:240px;display:flex;flex-direction:column;gap:10px}
.g-team{border:1px solid var(--line2);border-radius:14px;padding:10px;margin-top:10px}
.g-team.win{border-color:rgba(10,200,185,.45)}.g-team.lose{border-color:rgba(255,84,104,.3)}
.g-th{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.g-win{font-weight:800;font-size:13px;cursor:pointer;display:flex;gap:4px;align-items:center}
.g-ch{display:flex;align-items:center;gap:6px}.g-ch img,.g-noimg{width:28px;height:28px;border-radius:50%;flex:none}
.g-noimg{display:inline-flex;align-items:center;justify-content:center;background:var(--panel2);color:var(--mut)}
.g-ch select{width:118px}.g-ch.unsure img{outline:2px solid var(--amber)}
.g-name{width:140px}.g-mem{width:130px}.g-mem.unk{color:var(--amber)}
.g-num{padding:6px 6px;text-align:right}
.g-hint{font-size:10.5px;color:var(--mut);margin-top:2px}
.g-alert{margin-top:8px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.04);font-size:13px;font-weight:700}
.g-alert.warn{background:rgba(255,194,77,.1);color:var(--amber)}.g-alert.bad{background:rgba(255,84,104,.12);color:var(--red)}
.g-games{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.g-game{cursor:pointer;padding:14px}.g-game:hover{border-color:var(--line)}
.g-gh{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.g-gt{display:flex;gap:4px;align-items:center;margin-top:4px}.g-gt img{width:26px;height:26px;border-radius:50%}
.g-gt.lose img{opacity:.55;filter:grayscale(.5)}
.g-res{font-weight:900;width:20px;font-size:12px}.g-gt.win .g-res{color:var(--teal2)}.g-gt.lose .g-res{color:var(--red)}
.subtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;padding:8px;border-radius:14px;background:var(--glass);border:1px solid var(--line2)}
body.capture .subtabs{display:none}
.g-hl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.g-hlc{border:1px solid var(--line2);border-radius:14px;padding:12px 14px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015))}
.g-hlc b{display:block;font-size:24px;font-weight:900;color:var(--txt)}.g-hlc span{font-size:12px;color:var(--mut)}
.g-formula{font-size:12px;font-weight:800;color:var(--teal2);background:rgba(10,200,185,.1);border-radius:999px;padding:3px 10px}
.g-lbt td{padding:9px 8px}.g-lb{cursor:pointer}.g-lb:hover td{background:rgba(255,255,255,.03)}.g-lb.top1 .g-rk{color:var(--gold2);font-size:16px}
.g-mv{font-size:10px;font-weight:800}.g-dn2{color:var(--red)}
.g-bar{display:block;height:4px;border-radius:3px;background:rgba(255,255,255,.08);margin-top:4px;min-width:60px}.g-bar i{display:block;height:100%;border-radius:3px}
.g-bar.k i{background:var(--violet)}.g-bar.w i{background:var(--teal)}
.g-score{font-weight:900;font-size:15px;color:var(--gold2)}
.g-det summary{cursor:pointer;margin-bottom:0}.g-det[open] summary{margin-bottom:12px}
.g-rank tr[data-a]{cursor:pointer}
.g-duo{display:flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--line2);border-radius:10px;margin-bottom:6px}.g-duo .sub{flex:1}
.g-lbwrap{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;align-items:start}
@media (max-width:980px){.g-lbwrap{grid-template-columns:1fr}.g-side{display:none}}
.g-lb.sel td{background:rgba(10,200,185,.08)}.g-lb.sel td:first-child{box-shadow:inset 3px 0 0 var(--teal)}
.g-side{position:sticky;top:12px;border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015))}
.g-sh{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.g-sh b{font-size:18px}
.g-srank{text-align:right}.g-srank b{display:block;font-size:20px;color:var(--gold2)}.g-srank span{font-size:12px;color:var(--mut)}
.g-stiles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:12px 0 8px}.g-stiles div{background:var(--glass);border-radius:10px;padding:8px;text-align:center}
.g-stiles b{display:block;font-size:17px}.g-stiles span{font-size:10.5px;color:var(--mut)}
.g-skda{font-size:13px;color:var(--mut);text-align:center}.g-skda b{color:var(--txt)}
.g-st{font-weight:900;font-size:13px;margin:14px 0 6px;color:var(--gold2)}
.g-abil{display:grid;grid-template-columns:56px 1fr 62px;gap:8px;align-items:center;font-size:12px;margin:4px 0}.g-abil .g-bar{margin:0}
.g-smost{display:flex;align-items:center;gap:8px;padding:4px 0}.g-smost img{width:30px;height:30px;border-radius:50%}.g-smost div{flex:1;display:flex;flex-direction:column}.g-smost b{font-size:13px}
.g-sduo{display:flex;gap:6px;align-items:center;font-size:13px;padding:3px 0}.g-sduo .sub{flex:1}
.g-tier{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:22px;padding:0 6px;border-radius:6px;font-weight:900;font-size:12px;color:#fff}
.g-tier.t0{background:#e84057}.g-tier.t1{background:#0093ff}.g-tier.t2{background:#00bba3}.g-tier.t3{background:#ffb900;color:#2a2300}.g-tier.t4{background:#9aa4af;color:#111}.g-tier.t5{background:#a88a67}
.g-ext{margin-left:6px;font-size:10.5px}
.g-slbl{margin-left:6px;color:var(--teal2,#5fe3d0);font-weight:800}
.g-vtabs{display:flex;gap:4px;margin-bottom:10px;border-bottom:1px solid var(--line2)}
.g-vtabs button{padding:10px 16px;font-weight:900;font-size:14px;color:var(--mut);border:0;background:none;border-bottom:3px solid transparent;margin-bottom:-1px;cursor:pointer}
.g-vtabs button.on{color:var(--txt);border-bottom-color:var(--teal)}
.g-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.g-filters select{width:auto}
.g-pos-t{font-size:11px;color:var(--mut);font-weight:700;margin-left:4px}
.g-pos{width:96px}.g-pos.guess{color:var(--amber)}
.g-pcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.g-pcard{border:1px solid var(--line2);border-radius:14px;padding:12px;cursor:pointer;background:var(--glass)}.g-pcard:hover{border-color:var(--line)}
.g-pc-h{display:flex;justify-content:space-between;align-items:center;gap:6px}.g-pc-h b{font-size:15px}
.g-pc-s{display:flex;gap:12px;margin:6px 0;font-size:12.5px;color:var(--mut)}.g-pc-s b{color:var(--txt)}
.g-pc-m{display:flex;gap:2px}
.g-rank tr[data-a="gchamp1"]{cursor:pointer}
.g-awards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.g-award{display:flex;gap:12px;padding:14px;border:1px solid var(--line2);border-radius:16px;background:linear-gradient(160deg,rgba(200,170,110,.08),rgba(255,255,255,.015))}
.g-aw-e{font-size:30px;line-height:1}.g-aw-b{min-width:0;flex:1}
.g-aw-t{font-weight:900;font-size:15px;color:var(--gold2)}.g-aw-d{font-size:11.5px;color:var(--mut);margin:2px 0 8px}
.g-aw-w{font-weight:900;font-size:17px;color:var(--txt);word-break:keep-all}.g-aw-v{font-size:13px;font-weight:800;color:var(--teal2);margin-top:2px}
.g-boards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.g-board{border:1px solid var(--line2);border-radius:14px;padding:10px 12px;background:var(--glass)}
.g-bh{font-weight:900;margin-bottom:6px}.g-bt{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:13px}
.g-bn{flex:1;min-width:0;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.g-bv{font-weight:800;color:var(--teal2);white-space:nowrap}
.g-unranked td{opacity:.62}.g-unranked td.g-rk{opacity:1}
.g-forms{white-space:nowrap}.g-form{display:inline-block;font-style:normal;font-size:10.5px;font-weight:900;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;margin-right:2px}
.g-form.w{background:rgba(10,200,185,.2);color:var(--teal2)}.g-form.l{background:rgba(255,84,104,.16);color:var(--red)}
.g-champs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.g-champ{display:flex;gap:10px;align-items:center;padding:6px 8px;border:1px solid var(--line2);border-radius:12px}.g-champ img{width:34px;height:34px;border-radius:50%}.g-champ div{display:flex;flex-direction:column}
.g-gn{font-size:11px;color:var(--mut);margin:1px 0 4px 24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-old{margin-top:14px}.g-old summary{cursor:pointer;font-weight:800}
.g-drop{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;background:rgba(5,10,20,.78);border:3px dashed var(--teal);pointer-events:none}
.g-drop.on{display:flex}.g-drop div{font-size:22px;font-weight:900;color:var(--teal2)}
.g-merge{display:flex;flex-direction:column;gap:8px}
.g-mrow{display:grid;grid-template-columns:minmax(150px,1fr) auto 150px;gap:10px;align-items:center;padding:8px 12px;border:1px solid rgba(255,194,77,.35);border-radius:12px}
@media (max-width:640px){.g-mrow{grid-template-columns:1fr}}
.g-mname b{display:block}.g-msug{display:flex;gap:6px;flex-wrap:wrap}
.g-idgrp{padding:8px 10px;border:1px solid var(--line2);border-radius:10px}.g-idgrp>b{display:block;margin-bottom:4px}
.g-alias{display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;padding:2px 4px 2px 8px;border-radius:999px;background:var(--glass);font-size:12.5px}
.g-x{border:0;background:none;color:var(--mut);cursor:pointer;font-size:11px;padding:0 4px}.g-x:hover{color:var(--red)}
.g-ids{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.g-idrow{display:flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--line2);border-radius:10px}
.g-idrow b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.g-idrow.unk{border-color:rgba(255,194,77,.4)}.g-idrow select{width:120px}
` }));
