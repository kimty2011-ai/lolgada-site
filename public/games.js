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
const GM = { games: [], ids: {}, got: false, filter: 'all', view: 'rank', sort: 'wr', dir: -1, quota: null, unsub: [] };
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
const gTabOpen = () => ['stats', 'records'].includes(UI.tab) && M.classList.contains('hidden');
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
}
function stopGamesSync() { GM.unsub.forEach(u => { try { u() } catch (_) {} }); GM.unsub = [] }
const int0 = v => Math.max(0, Math.round(+v || 0));
function normGame(g) {
  if (!g || !Array.isArray(g.teams) || g.teams.length !== 2) return null;
  return { id: String(g.id), type: g.type === 'team' ? 'team' : 'casual', date: String(g.date || ''), dur: String(g.dur || ''), win: g.win === 2 ? 2 : 1, at: +g.at || 0,
    teams: g.teams.map(t => ({ k: int0(t.k), d: int0(t.d), a: int0(t.a), gold: int0(t.gold),
      players: (t.players || []).slice(0, 5).map(p => ({ rid: String(p.rid || ''), champ: String(p.champ || ''), lv: int0(p.lv), k: int0(p.k), d: int0(p.d), a: int0(p.a), cs: int0(p.cs), gold: int0(p.gold) })) })) };
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
  return { type: '', date: date ? `${date[1]}-${date[2]}-${date[3]}` : today, dur: dm ? `${dm[1]}:${dm[2]}` : '', win, teams, champFail: !champs };
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
    t.players.forEach((p, pi) => { if (!p.champ) block.push(`${ti + 1}번 팀 ${pi + 1}번째 챔피언을 골라주세요`); if (!p.rid.trim()) block.push(`${ti + 1}번 팀 ${pi + 1}번째 닉네임이 비어 있어요`) });
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
    <div class="g-scroll"><table class="g-tbl"><thead><tr><th>챔피언</th><th>닉네임 (게임)</th><th>멤버</th><th>Lv</th><th class="${gRowWarn(t, 'k') ? 'bad' : ''}">K</th><th class="${gRowWarn(t, 'd') ? 'bad' : ''}">D</th><th class="${gRowWarn(t, 'a') ? 'bad' : ''}">A</th><th>CS</th><th class="${gRowWarn(t, 'gold') ? 'bad' : ''}">골드</th></tr></thead>
    <tbody>${t.players.map((p, pi) => `<tr><td>${champSel(ti, pi, p)}</td>
      <td><input class="inp g-name" value="${esc(p.rid)}" maxlength="24" data-c="grid" data-t="${ti}" data-p="${pi}" ${u.busy || (u.mode === 'edit' && !A) ? 'disabled' : ''}>${p.how === 'fuzzy' ? `<div class="g-hint">AI: ${esc(p.read)} → 등록된 ID로 고침</div>` : ''}</td>
      <td>${mem(ti, pi, p)}</td><td>${numIn(ti, pi, 'lv', p, 46)}</td><td>${numIn(ti, pi, 'k', p, 46)}</td><td>${numIn(ti, pi, 'd', p, 46)}</td><td>${numIn(ti, pi, 'a', p, 46)}</td><td>${numIn(ti, pi, 'cs', p, 58)}</td><td>${numIn(ti, pi, 'gold', p, 76)}</td></tr>`).join('')}</tbody></table></div></div>`;
  modal(`${head}
    <div class="g-top">${u.thumb ? `<img class="g-thumb" src="${u.thumb}" alt="">` : ''}
      <div class="g-meta">
        <div><label class="fl">경기 종류 *</label><div class="g-seg">${Object.entries(G_TYPES).map(([k, n]) => `<button class="chip ${dr.type === k ? 'on' : ''}" data-a="gtype" data-v="${k}" ${u.busy ? 'disabled' : ''}>${n}</button>`).join('')}</div></div>
        <div class="row2"><div><label class="fl">경기 날짜</label><input class="inp" type="date" style="width:100%" value="${esc(dr.date)}" data-c="gdate" ${u.busy ? 'disabled' : ''}></div>
          <div><label class="fl">경기 시간</label><input class="inp" style="width:100%" value="${esc(dr.dur)}" placeholder="mm:ss" data-c="gdur" ${u.busy ? 'disabled' : ''}></div></div>
        <div class="sub">💡 저장 전까지는 잘못 읽힌 값을 고칠 수 있어요 · 저장 후 수정은 운영진만 · 멤버를 고르면 그 게임 ID가 멤버에 계속 연결돼요</div>
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
    const game = { type: dr.type, date: dr.date, dur: dr.dur, win: dr.win, at: u.mode === 'edit' ? (GM.games.find(g => g.id === id)?.at || Date.now()) : Date.now(), by: CLIENT,
      teams: dr.teams.map(t => ({ k: t.k, d: t.d, a: t.a, gold: t.gold, players: t.players.map(p => ({ rid: p.rid.trim(), champ: p.champ, lv: p.lv, k: p.k, d: p.d, a: p.a, cs: p.cs, gold: p.gold })) })) };
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
function gStats(games) {
  const by = new Map(); let unknown = new Set(), guests = 0;
  for (const g of games) g.teams.forEach((t, ti) => t.players.forEach(p => {
    const m = memberOf(p.rid);
    if (m === 'guest') { guests++; return }
    if (m == null) { unknown.add(p.rid); return }
    let s = by.get(m); if (!s) by.set(m, s = { id: m, n: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, gold: 0, ch: {} });
    s.n++; if (g.win === ti + 1) s.w++; s.k += p.k; s.d += p.d; s.a += p.a; s.cs += p.cs; s.gold += p.gold; s.ch[p.champ] = (s.ch[p.champ] || 0) + 1;
  }));
  const rows = [...by.values()].map(s => ({ ...s, l: s.n - s.w, wr: s.w / s.n, kda: (s.k + s.a) / Math.max(1, s.d), perfect: s.d === 0,
    most: Object.entries(s.ch).sort((a, b) => b[1] - a[1]).slice(0, 3) }));
  return { rows, unknown: [...unknown], guests };
}
const G_COLS = [
  { k: 'n', h: '판수', v: s => s.n }, { k: 'w', h: '승', v: s => s.w }, { k: 'l', h: '패', v: s => s.l },
  { k: 'wr', h: '승률', v: s => s.wr }, { k: 'kda', h: 'KDA', v: s => s.kda },
  { k: 'k', h: '평균 K/D/A', v: s => s.k / s.n }, { k: 'cs', h: '평균 CS', v: s => s.cs / s.n }, { k: 'gold', h: '평균 골드', v: s => s.gold / s.n },
];
function renderStats() {
  const games = GM.games.filter(g => GM.filter === 'all' || g.type === GM.filter);
  const st = gStats(games), need = exposeNeed(games.length) || 0, col = G_COLS.find(c => c.k === GM.sort) || G_COLS[3];
  const sorted = st.rows.sort((a, b) => GM.dir * (col.v(a) - col.v(b)) || b.n - a.n || b.wr - a.wr);
  const shown = sorted.filter(s => s.n >= need), hidden = sorted.filter(s => s.n < need), A = isAdmin();
  const q = GM.quota, connected = !!(fb && fb.fs);
  const mostH = s => s.most.map(([id, c]) => `<span class="g-most" title="${esc(champName(id))} ${c}판"><img src="${champImg(id)}" alt="${esc(champName(id))}">${c > 1 ? `<i>${c}</i>` : ''}</span>`).join('');
  const rowH = (s, i) => { const m = player(s.id); return `<tr><td class="g-rk">${i == null ? '' : i + 1}</td><td class="g-nm">${m ? nmH(m) : '?'}</td><td>${s.n}</td><td>${s.w}</td><td>${s.l}</td>
    <td><b class="${s.wr >= 0.5 ? 'g-up' : 'g-dn'}">${Math.round(s.wr * 100)}%</b></td><td><b>${s.perfect ? 'Perfect' : s.kda.toFixed(2)}</b></td>
    <td>${(s.k / s.n).toFixed(1)} / ${(s.d / s.n).toFixed(1)} / ${(s.a / s.n).toFixed(1)}</td><td>${Math.round(s.cs / s.n)}</td><td>${Math.round(s.gold / s.n).toLocaleString()}</td><td class="g-mosts">${mostH(s)}</td></tr>` };
  const th = c => `<th class="g-sort ${GM.sort === c.k ? 'on' : ''}" data-a="gsort" data-v="${c.k}">${c.h}${GM.sort === c.k ? (GM.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  V.innerHTML = `${gHeadHTML('📊 내전 통계', '경기 종료 후 [점수판] 화면을 캡처해서 올리면 자동으로 집계돼요')}
  ${!connected ? `<div class="empty-note card">🔌 서버에 연결되면 통계가 보여요</div>` : !GM.got ? `<div class="empty-note card">⏳ 불러오는 중…</div>`
    : `
  <div class="card"><div class="h2">🏅 랭킹 <span class="sub">${games.length}경기 · ${need ? `최소 ${need}판 이상 참여해야 순위 노출` : '참여한 멤버 모두 노출'}</span></div>
    ${shown.length ? `<div class="g-scroll"><table class="g-tbl g-rank"><thead><tr><th>#</th><th>멤버</th>${G_COLS.map(th).join('')}<th>모스트</th></tr></thead><tbody>${shown.map((s, i) => rowH(s, i)).join('')}</tbody></table></div>`
      : `<div class="empty-note">${games.length ? '아직 순위 노출 조건을 채운 멤버가 없어요' : '📭 아직 올라온 경기가 없어요 · [📤 결과 올리기]로 시작해보세요'}</div>`}
    ${hidden.length ? `<details class="g-hidden"><summary>판수 부족으로 순위 미노출 ${hidden.length}명 (${need}판 미만)</summary><div class="g-scroll"><table class="g-tbl g-rank"><tbody>${hidden.map(s => rowH(s, null)).join('')}</tbody></table></div></details>` : ''}
    ${st.unknown.length || st.guests ? `<div class="sub" style="margin-top:10px">❔ 멤버 연결 안 된 게임 ID ${st.unknown.length}개${st.guests ? ` · 🎟 게스트 ${st.guests}회` : ''} — 통계에서 빠져 있어요${A ? ' · 아래 [게임 ID 연결]에서 연결하면 과거 기록까지 바로 반영돼요' : ' · 운영진이 연결하면 자동 반영돼요'}</div>` : ''}
  </div>`}
  ${A && connected ? gAdminHTML() : ''}`;
  gAfterRender();
}
// 통계·기록 탭 공통: 제목 + 오늘 사용량 + 올리기 버튼 + 종류 필터
function gHeadHTML(title, sub) {
  const q = GM.quota, connected = !!(fb && fb.fs);
  return `<div class="sec-head"><div><div class="h1">${title}</div>
    <div class="sub">${sub} · 누구나 올릴 수 있고, 저장된 기록 수정은 운영진만 · 이 화면에 <b style="color:var(--txt)">끌어다 놓거나 Ctrl+V</b>로도 올릴 수 있어요</div></div>
    <div class="row gap wrapr">${q && !q.pending ? `<span class="tag ${q.used >= q.limit ? 't-red' : 't-mut'}">오늘 ${q.used} / ${q.limit}장</span>` : ''}<button class="btn pri" data-a="gup" ${connected ? '' : 'disabled'}>📤 결과 올리기</button></div></div>
  <div class="card toolbar"><div class="g-seg">${[['all', '전체'], ['casual', G_TYPES.casual], ['team', G_TYPES.team]].map(([k, n]) => `<button class="chip ${GM.filter === k ? 'on' : ''}" data-a="gfilter" data-v="${k}">${n}</button>`).join('')}</div></div>`;
}
function gAfterRender() {
  const connected = !!(fb && fb.fs);
  if (!CHAMP.v) champLoad().then(() => gTabOpen() && render()).catch(() => {});
  if (!GM.quota && connected) { GM.quota = { used: 0, limit: 0, pending: true }; refreshQuota() }
}
// 📜 내전 기록 탭: 올라온 경기 전체 + 예전 팀대항전 캡처
function renderGameRecords() {
  const games = GM.games.filter(g => GM.filter === 'all' || g.type === GM.filter), connected = !!(fb && fb.fs);
  const cnt = k => GM.games.filter(g => g.type === k).length;
  V.innerHTML = `${gHeadHTML('📜 내전 기록', `올라온 내전 결과 전체 · 일반 내전 ${cnt('casual')}판 · 팀대항전 ${cnt('team')}판 · 카드를 누르면 상세 결과와 원본 스크린샷`)}
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
      <div class="g-gn">${t.players.map(p => { const m = memberOf(p.rid); return esc(m === 'guest' || m == null ? p.rid : player(m).name) }).join(' · ')}</div>`).join('')}
  </div>`).join('')}</div>`;
}
async function gViewGame(id) {
  const g = GM.games.find(x => x.id === id); if (!g) return; const A = isAdmin();
  const nameH = rid => { const m = memberOf(rid); return m === 'guest' ? `${esc(rid)} <span class="tag t-mut">게스트</span>` : m != null ? `${esc(player(m).name)} <span class="sub">${esc(rid)}</span>` : `${esc(rid)} <span class="tag t-amber">unknown</span>` };
  const body = img => modal(`<div class="mh">${G_TYPES[g.type]} · ${esc(g.date)} <span class="sub">${esc(g.dur)}</span></div>
    ${g.teams.map((t, ti) => `<div class="g-team ${g.win === ti + 1 ? 'win' : 'lose'}"><div class="g-th"><b>${ti + 1}번 팀 · ${g.win === ti + 1 ? '승리' : '패배'}</b><span class="sub">${t.k} / ${t.d} / ${t.a}</span></div>
      <div class="g-scroll"><table class="g-tbl"><thead><tr><th>챔피언</th><th>멤버</th><th>Lv</th><th>K / D / A</th><th>CS</th><th>골드</th></tr></thead><tbody>
      ${t.players.map(p => `<tr><td><div class="g-ch"><img src="${champImg(p.champ)}" alt="">${esc(champName(p.champ))}</div></td><td>${nameH(p.rid)}</td><td>${p.lv}</td><td>${p.k} / ${p.d} / ${p.a}</td><td>${p.cs}</td><td>${p.gold.toLocaleString()}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}
    <div class="rec-full" style="margin-top:12px">${img ? `<img src="${img}" alt="">` : img === '' ? '' : `<div class="hvid-ph" style="aspect-ratio:16/9">🖼️ 원본 스크린샷 불러오는 중…</div>`}</div>
    <div class="mbtns" style="flex-wrap:wrap">${A ? `<button class="btn sm danger" data-a="gmdel" data-id="${esc(id)}" style="margin-right:auto">🗑 삭제</button><button class="btn sm" data-a="gedit" data-id="${esc(id)}">✏️ 수정</button>` : ''}<button class="btn pri" data-a="mclose">닫기</button></div>`, false, 'full');
  body(null);
  try { const s = await fb.fs.getDoc(gDoc('shots', id)); if (!M.classList.contains('hidden')) body(s.exists() ? s.data().img : '') } catch (e) { console.error(e); body('') }
}
function gAdminHTML() {
  const rids = new Map(); GM.games.forEach(g => g.teams.forEach(t => t.players.forEach(p => { const k = nkey(p.rid); if (!rids.has(k)) rids.set(k, { rid: p.rid, n: 0 }); rids.get(k).n++ })));
  Object.values(GM.ids).forEach(v => { const k = nkey(v.name); if (!rids.has(k)) rids.set(k, { rid: v.name, n: 0 }) });
  const list = [...rids.values()].sort((a, b) => (memberOf(a.rid) == null ? 0 : 1) - (memberOf(b.rid) == null ? 0 : 1) || b.n - a.n);
  const q = GM.quota;
  return `<div class="card"><div class="h2">🛠 운영진 · 게임 ID 연결 <span class="sub">한 멤버에 부캐 여러 개 연결 가능 · 바꾸면 과거 기록까지 바로 반영</span></div>
    ${list.length ? `<div class="g-ids">${list.map(x => { const l = linkOf(x.rid), cur = l ? String(l.mid) : '';
      return `<div class="g-idrow ${cur ? '' : 'unk'}"><b>${esc(x.rid)}</b><span class="sub">${x.n}판</span>
        <select class="inp" data-c="glink" data-v="${esc(x.rid)}"><option value="">❔ unknown</option><option value="guest" ${cur === 'guest' ? 'selected' : ''}>🎟 게스트</option>
        ${[...S.players].sort(nameSort).map(m => `<option value="${m.id}" ${cur === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` }).join('')}</div>` : '<div class="empty-note">아직 게임 ID가 없어요</div>'}
    <div class="h2" style="margin-top:18px">📏 하루 업로드 한도 <span class="sub">한국 시간 자정에 초기화 · 운영진 업로드는 한도에서 빠져요</span></div>
    <div class="row gap"><input class="inp num" type="number" min="0" max="500" id="gLimit" value="${q && !q.pending ? q.limit : ''}" style="width:90px"><span>장 / 하루</span><button class="btn sm gold" data-a="glimit">저장</button>${q && !q.pending ? `<span class="sub">오늘 ${q.used}장 사용</span>` : ''}</div>
  </div>`;
}

/* ---------- 이벤트 ---------- */
const gP = el => GUP?.draft?.teams[+el.dataset.t]?.players[+el.dataset.p];
Object.assign(ACT, {
  gup: () => $('#gamef').click(),
  gfilter: el => { GM.filter = el.dataset.v; render() },
  gview: el => { GM.view = el.dataset.v; render() },
  gsort: el => { if (GM.sort === el.dataset.v) GM.dir = -GM.dir; else { GM.sort = el.dataset.v; GM.dir = -1 } render() },
  gtype: el => { if (!GUP?.draft) return; GUP.draft.type = el.dataset.v; gModal() },
  gsave: el => gSave(el.dataset.v === 'force'),
  gskip: () => { if (!GUP || GUP.busy) return; if (GUP.i + 1 < GUP.n) { GUP.i++; gNext() } },
  gretry: () => GUP && gNext(),
  gview1: el => gViewGame(el.dataset.id),
  gedit: el => gEditGame(el.dataset.id),
  gmdel: el => { if (!isAdmin()) return toast(RO_MSG, 'err'); const id = el.dataset.id;
    ask('🗑 경기 기록 삭제', '이 경기 기록과 원본 스크린샷을 지울까요? 통계에서도 빠지고, 되돌릴 수 없어요.', async () => {
      try { await fb.fs.deleteDoc(gDoc('games', id)); await fb.fs.deleteDoc(gDoc('shots', id)); toast('🗑 삭제했어요') } catch (e) { console.error(e); toast('삭제 실패 — ' + explain(e).t, 'err') } }, '삭제') },
  glimit: async () => { const n = +($('#gLimit')?.value); try { await gApi({ action: 'setLimit', limit: n }); toast(`📏 하루 ${n}장으로 바꿨어요`); render() } catch (e) { toast(e.message, 'err') } },
});
Object.assign(CHG, {
  gchamp: el => { const p = gP(el); if (!p) return; p.champ = el.value; p.sure = true; gRefreshChecks() },
  gnum: el => { const p = gP(el); if (!p) return; p[el.dataset.f] = int0(el.value); gRefreshChecks() },
  grid: el => { const p = gP(el); if (!p) return; const r = resolveName(el.value); p.rid = r.rid; p.read = el.value; p.how = r.how === 'fuzzy' ? 'fuzzy' : r.how; gRefreshChecks() },
  gmem: el => { const p = gP(el); if (!p) return; p.pick = el.value; el.classList.toggle('unk', !el.value) },
  gwin: el => { if (!GUP?.draft) return; GUP.draft.win = +el.value; gRefreshChecks() },
  gdate: el => { if (!GUP?.draft) return; GUP.draft.date = el.value; gRefreshChecks() },
  gdur: el => { if (!GUP?.draft) return; GUP.draft.dur = el.value.trim(); gRefreshChecks() },
  glink: async el => { if (!isAdmin()) return toast(RO_MSG, 'err'); const rid = el.dataset.v, v = el.value, ref = gDoc('ids', idDocId(nkey(rid)));
    try { if (!v) await fb.fs.deleteDoc(ref); else await fb.fs.setDoc(ref, { name: rid, mid: v === 'guest' ? 'guest' : Number(v), at: Date.now() }); toast('🔗 연결을 바꿨어요 · 통계에 바로 반영돼요') }
    catch (e) { console.error(e); toast('저장 실패 — ' + explain(e).t, 'err') } },
});
const gFileIn = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true, id: 'gamef' });
document.body.append(gFileIn);
gFileIn.addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) gOpenUpload(fs) });
document.addEventListener('paste', e => {
  if (!gTabOpen()) return;
  const fs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile());
  if (fs.length) { e.preventDefault(); gOpenUpload(fs) }
});
// 통계·기록 탭에 이미지 파일을 끌어다 놓으면 바로 올리기
const gDropCover = Object.assign(document.createElement('div'), { className: 'g-drop', innerHTML: '<div>📤 여기에 놓으면 결과창을 올려요</div>' });
document.body.append(gDropCover);
let gDragDepth = 0;
const gHasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (gTabOpen() && gHasFiles(e)) { gDragDepth++; gDropCover.classList.add('on') } });
document.addEventListener('dragleave', e => { if (gHasFiles(e) && --gDragDepth <= 0) { gDragDepth = 0; gDropCover.classList.remove('on') } });
document.addEventListener('dragover', e => { if (gTabOpen() && gHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } });
document.addEventListener('drop', e => {
  gDragDepth = 0; gDropCover.classList.remove('on');
  if (!gTabOpen() || !gHasFiles(e)) return;
  e.preventDefault(); gOpenUpload(e.dataTransfer.files);
});
const gBusy = () => !!GUP?.busy || GUP?.step === 'read';
const gOnClose = () => { GUP = null };

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
.g-gn{font-size:11px;color:var(--mut);margin:1px 0 4px 24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-old{margin-top:14px}.g-old summary{cursor:pointer;font-weight:800}
.g-drop{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;background:rgba(5,10,20,.78);border:3px dashed var(--teal);pointer-events:none}
.g-drop.on{display:flex}.g-drop div{font-size:22px;font-weight:900;color:var(--teal2)}
.g-ids{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.g-idrow{display:flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--line2);border-radius:10px}
.g-idrow b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.g-idrow.unk{border-color:rgba(255,194,77,.4)}.g-idrow select{width:120px}
` }));
