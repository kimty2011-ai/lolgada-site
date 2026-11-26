'use strict';
/* =========================================================
   🎲 팀 뽑기 — 참가자 선택 → 사다리로 팀장 → 드래프트 → 가위바위보로 진영 선택권
   실시간 공유(누구나 조작): Firestore lolgadaCenter/season4_draft
   index.html 의 전역(S, C, fb, cPerson, nmH, totalBase, render, toast …)을 그대로 쓴다.
   ========================================================= */
const FB_DOC_D = ['lolgadaCenter', (typeof G_DEV !== 'undefined' && G_DEV) ? 'season4_draft_dev' : 'season4_draft'];
const DMODES = { one: '1명씩 번갈아', snake: '1-2-2-2-1' };
const RPS = { r: '✊ 바위', s: '✌️ 가위', p: '✋ 보' };
const RPS_WIN = { r: 's', s: 'p', p: 'r' }; // 키가 값을 이김

const emptyRps = () => ({ a: '', b: '', ties: 0, winner: -1, last: null });
const normRps = r => ({ a: RPS[r?.a] ? r.a : '', b: RPS[r?.b] ? r.b : '', ties: +r?.ties || 0, winner: r?.winner === 0 || r?.winner === 1 ? r.winner : -1, last: Array.isArray(r?.last) ? r.last : null });
// 선후픽: method = random | rps | manual, holder = 선택권을 가진 팀장(caps 인덱스)
const emptyOrder = () => ({ method: '', holder: -1, rps: emptyRps() });
function defaultD() { return { v: 1, phase: 'setup', in: [], mode: 'snake', ladder: null, caps: [], order: emptyOrder(), teams: [[], []], picks: [], rps: emptyRps(), side: { team: -1, choice: '' }, at: 0 } }
function normD(src) {
  const d = defaultD(); if (!src || typeof src !== 'object') return d;
  const ids = a => Array.isArray(a) ? [...new Set(a.map(cid))] : [];
  const od = src.order || {};
  const o = { ...d, phase: ['setup', 'ladder', 'order', 'pick', 'rps', 'done'].includes(src.phase) ? src.phase : 'setup', in: ids(src.in), mode: DMODES[src.mode] ? src.mode : 'snake',
    order: { method: ['random', 'rps', 'manual'].includes(od.method) ? od.method : '', holder: od.holder === 0 || od.holder === 1 ? od.holder : -1, rps: normRps(od.rps) },
    caps: ids(src.caps).slice(0, 2), teams: [0, 1].map(i => ids(src.teams?.[i])), picks: Array.isArray(src.picks) ? src.picks.map(p => ({ t: p.t ? 1 : 0, id: cid(p.id) })) : [], at: +src.at || 0 };
  const L = src.ladder;
  if (L && Array.isArray(L.cols) && Array.isArray(L.rungs)) o.ladder = { cols: ids(L.cols), rows: +L.rows || 10, rungs: L.rungs.filter(r => Array.isArray(r)).map(r => [+r[0], +r[1]]), ends: Array.isArray(L.ends) ? L.ends.map(Number) : [], shown: !!L.shown };
  o.rps = normRps(src.rps);
  const s = src.side || {}; o.side = { team: s.team === 0 || s.team === 1 ? s.team : -1, choice: s.choice === 'blue' || s.choice === 'red' ? s.choice : '' };
  return o;
}
let D = defaultD(), DSYNC = { unsub: null, got: false, q: '', played: '' };
const dRef = () => fb.fs.doc(fb.db, ...FB_DOC_D);
function startDraftSync() {
  stopDraftSync();
  DSYNC.unsub = fb.fs.onSnapshot(dRef(), snap => {
    DSYNC.got = true; const d = snap.exists() ? snap.data() : null;
    try { D = normD(d && d.json ? JSON.parse(d.json) : null) } catch (e) { console.error(e) }
    if (UI.tab === 'draft' && M.classList.contains('hidden')) { const a = document.activeElement; if (!(a && a.dataset && a.dataset.i === 'dq')) render(); else renderDraftKeepSearch() }
  }, e => console.error('draft sync', e));
}
function stopDraftSync() { try { DSYNC.unsub && DSYNC.unsub() } catch (_) {} DSYNC.unsub = null; DSYNC.got = false }
// 동시에 여러 사람이 눌러도 꼬이지 않게: 서버의 최신 상태 위에 변경을 적용한다
async function commitD(fn) {
  if (!fb || !fb.fs) { fn(D); D.at = Date.now(); render(); return }
  try {
    await fb.fs.runTransaction(fb.db, async tx => {
      const s = await tx.get(dRef()); const cur = normD(s.exists() && s.data().json ? JSON.parse(s.data().json) : null);
      if (fn(cur) === false) return; cur.at = Date.now();
      tx.set(dRef(), { json: JSON.stringify(cur), by: CLIENT, at: cur.at });
    });
  } catch (e) { console.error(e); toast('저장 실패 — 연결을 확인해주세요', 'err') }
}

/* ---------- 규칙 ---------- */
const dTeamSize = d => Math.min(5, Math.floor(d.in.length / 2));
function dOrder(d) { // 팀장 제외 픽 순서 (0 = 선픽 팀장 팀)
  const k = dTeamSize(d) - 1, seq = [];
  if (d.mode === 'one') for (let i = 0; i < k * 2; i++) seq.push(i % 2);
  else { seq.push(0); let t = 1; while (seq.length < k * 2) { seq.push(t); if (seq.length < k * 2) seq.push(t); t = 1 - t } }
  // 한쪽이 다 찼으면 남은 순서는 다른 팀
  const cnt = [0, 0]; return seq.map(t => { if (cnt[t] >= k) t = 1 - t; cnt[t]++; return t });
}
const dPool = d => d.in.filter(id => cPerson(id) && !d.teams[0].includes(id) && !d.teams[1].includes(id));
const dTurn = d => { const o = dOrder(d); return d.picks.length < o.length && dPool(d).length ? o[d.picks.length] : -1 };
function makeLadder(cols) {
  const n = cols.length, rows = Math.max(9, n + 3), rungs = [];
  for (let r = 0; r < rows; r++) { let prev = -2; for (let c = 0; c < n - 1; c++) if (c !== prev + 1 && Math.random() < 0.42) { rungs.push([r, c]); prev = c } }
  const pos = [...Array(n).keys()].sort(() => Math.random() - 0.5);
  return { cols, rows, rungs, ends: [pos[0], pos[1]], shown: false }; // ends[0] = 👑 선픽 자리, ends[1] = 👑 후픽 자리
}
function traceLadder(L, start) {
  const has = new Set(L.rungs.map(([r, c]) => r + ':' + c)); let c = start; const pts = [[c, -1]];
  for (let r = 0; r < L.rows; r++) { pts.push([c, r]); if (has.has(r + ':' + c)) { c++; pts.push([c, r]) } else if (has.has(r + ':' + (c - 1))) { c--; pts.push([c, r]) } }
  pts.push([c, L.rows]); return { end: c, pts };
}
const ladderCaps = L => [0, 1].map(k => L.cols.find((_, i) => traceLadder(L, i).end === L.ends[k]));
const teamName = (d, t) => { const c = cPerson(d.caps[t]); return `${c ? c.name : '?'}팀` };
const sideIcon = (d, t) => d.side.choice ? ((d.side.choice === 'blue') === (t === d.side.team) ? '🔵' : '🔴') : (t ? '🟣' : '🟢');

/* ---------- 화면 ---------- */
function renderDraft() {
  const d = D, live = !!(fb && fb.fs);
  V.innerHTML = `
  <div class="sec-head"><div><div class="h1">🎲 팀 뽑기</div>
    <div class="sub">참가자 체크 → 🪜 사다리로 팀장 2명 → 팀장이 번갈아 팀원 뽑기 → ✊ 가위바위보로 진영 선택권</div></div>
    <span class="open-note">🔓 누구나 조작 · ${live ? '모든 화면에 실시간 공유' : '⚠️ 서버 미연결 — 이 화면에서만 보여요'}</span></div>
  <div class="d-steps">${[['setup', '① 참가자'], ['ladder', '② 사다리'], ['order', '③ 선후픽'], ['pick', '④ 팀원 뽑기'], ['rps', '⑤ 진영 선택권'], ['done', '⑥ 완료']].map(([k, n]) => `<span class="${d.phase === k ? 'on' : ''}">${n}</span>`).join('')}
    ${d.phase !== 'setup' ? '<button class="btn sm danger mla" data-a="dreset">↺ 처음부터</button>' : ''}</div>
  ${({ setup: dSetupHTML, ladder: dLadderHTML, order: dOrderHTML, pick: dPickHTML, rps: dRpsHTML, done: dDoneHTML })[d.phase](d)}`;
  if (d.phase === 'ladder') dAnimateLadder();
}
function dPersonRow(p, on, extra = '') { return `<button class="d-p ${on ? 'on' : ''}" data-a="din" data-id="${p.id}"><span class="d-ck">${on ? '✔' : ''}</span><span class="d-nm">${nmH(p)}${p.guest ? '<span class="gtag">GUEST</span>' : ''}</span><span class="sub">${totalBase(p)}점</span>${extra}</button>` }
function dSetupList(d) {
  const inSet = new Set(d.in), q = DSYNC.q.trim().toLowerCase();
  const all = [...S.players, ...C.guests].filter(p => !q || p.name.toLowerCase().includes(q)).sort((a, b) => (inSet.has(b.id) - inSet.has(a.id)) || nameSort(a, b));
  return all.map(p => dPersonRow(p, inSet.has(p.id))).join('') || '<div class="empty-note">검색 결과가 없어요</div>';
}
function dSetupHTML(d) {
  const n = d.in.filter(id => cPerson(id)).length, size = Math.min(5, Math.floor(n / 2));
  return `<div class="card"><div class="h2">✅ 오늘 참가자 <span class="tag t-lime">${n}명</span><span class="sub mla">${n >= 4 ? `팀당 ${size}명${n > size * 2 ? ` · ${n - size * 2}명은 대기` : ''}` : '4명 이상 골라주세요'}</span></div>
    <div class="row gap wrapr" style="margin-bottom:10px"><input class="inp search" data-i="dq" placeholder="🔍 닉네임 검색" value="${esc(DSYNC.q)}">
      <button class="btn sm" data-a="dnone">전체 해제</button><button class="btn sm gold mla" data-a="gadd">＋ 게스트 추가</button></div>
    <div class="d-plist" id="dplist">${dSetupList(d)}</div></div>
  <div class="card"><div class="h2">🔁 뽑는 순서</div>
    <div class="g-seg">${Object.entries(DMODES).map(([k, t]) => `<button class="chip ${d.mode === k ? 'on' : ''}" data-a="dmode" data-v="${k}">${t}</button>`).join('')}</div>
    <div class="sub" style="margin-top:8px">${d.mode === 'one' ? '선픽 팀장부터 한 명씩 번갈아 뽑아요 · 선택권을 얻은 팀장이 무조건 선픽' : '선픽 1명 → 후픽 2명 → 선픽 2명 → … 마지막 1명 · 선택권을 얻은 팀장이 "선픽 1명"과 "후픽 2명" 중에서 골라요'}<br>선후픽 선택권은 사다리 다음 단계에서 랜덤 · 가위바위보 · 직접 지정 중 하나로 정해요</div>
    <div class="row" style="margin-top:14px"><button class="btn pri" data-a="dladder" ${n >= 4 ? '' : 'disabled'}>🪜 사다리로 팀장 뽑기</button></div></div>`;
}
function renderDraftKeepSearch() { const el = $('#dplist'); if (el && D.phase === 'setup') el.innerHTML = dSetupList(D) }

const LW = 70, LH = 26, LTOP = 46, LBOT = 46;
function dLadderHTML(d) {
  const L = d.ladder; if (!L) return '';
  const n = L.cols.length, W = n * LW, H = LTOP + (L.rows + 1) * LH + LBOT, x = c => c * LW + LW / 2, y = r => LTOP + (r + 1) * LH;
  const caps = ladderCaps(L);
  const lines = L.cols.map((_, c) => `<line x1="${x(c)}" y1="${LTOP}" x2="${x(c)}" y2="${y(L.rows)}" class="d-rail"/>`).join('')
    + L.rungs.map(([r, c]) => `<line x1="${x(c)}" y1="${y(r)}" x2="${x(c + 1)}" y2="${y(r)}" class="d-rung"/>`).join('');
  const names = L.cols.map((id, c) => { const p = cPerson(id); return `<text x="${x(c)}" y="${LTOP - 14}" class="d-lname" data-col="${c}">${esc((p ? p.name : '?').slice(0, 6))}</text>` }).join('');
  const ends = L.cols.map((_, c) => { const k = L.ends.indexOf(c); return `<text x="${x(c)}" y="${y(L.rows) + 26}" class="d-lend ${k >= 0 ? 'cap' : ''}">${L.shown ? (k >= 0 ? '👑 팀장' : '–') : '❓'}</text>` }).join('');
  const paths = L.shown ? caps.map((id, k) => { const c = L.cols.indexOf(id), { pts } = traceLadder(L, c); let len = 0;
    const P = pts.map(([cc, r], i) => { const X = x(cc), Y = r < 0 ? LTOP : y(r); if (i) { const [pc, pr] = pts[i - 1]; len += Math.hypot(X - x(pc), Y - (pr < 0 ? LTOP : y(pr))) } return `${X},${Y}` }).join(' ');
    return `<polyline points="${P}" class="d-path k${k}" style="stroke-dasharray:${len};stroke-dashoffset:${len}" data-len="${len}"/>` }).join('') : '';
  return `<div class="card"><div class="h2">🪜 사다리타기 <span class="sub">맨 아래 ❓ 중 두 칸이 👑 팀장</span></div>
    <div class="d-ladder"><svg viewBox="0 0 ${W} ${H}" style="max-width:${Math.max(W, 320)}px">${lines}${paths}${names}${ends}</svg></div>
    ${L.shown ? `<div class="d-capres">${caps.map((id, k) => `<div class="d-cap k${k}">👑 팀장<b>${esc(cPerson(id)?.name || '?')}</b></div>`).join('')}</div>
      <div class="row gap" style="justify-content:center;margin-top:12px"><button class="btn" data-a="dladder">🔄 사다리 다시</button><button class="btn pri" data-a="dstart">➡️ 선후픽 정하기</button></div>`
      : `<div class="row gap" style="justify-content:center;margin-top:12px"><button class="btn" data-a="dladder">🔄 사다리 다시 만들기</button><button class="btn pri" data-a="dshow">🎬 결과 공개</button></div>`}
  </div>`;
}
function dAnimateLadder() {
  const L = D.ladder; if (!L || !L.shown) return;
  const key = JSON.stringify([L.rungs.length, L.ends, L.cols]);
  const ps = [...document.querySelectorAll('.d-path')];
  if (DSYNC.played === key) { ps.forEach(p => p.style.strokeDashoffset = 0); return }
  DSYNC.played = key;
  ps.forEach((p, i) => setTimeout(() => { p.style.transition = 'stroke-dashoffset 2.2s ease-in-out'; p.style.strokeDashoffset = 0 }, 60 + i * 2300));
}
function dTeamCol(d, t, turn) {
  const size = dTeamSize(d), mem = d.teams[t];
  return `<div class="card d-team t${t} ${turn === t ? 'turn' : ''}"><div class="d-th">${sideIcon(d, t)} <b>${esc(teamName(d, t))}</b><span class="sub">${t ? '후픽' : '선픽'} · ${mem.length}/${size}</span></div>
    ${Array.from({ length: size }, (_, i) => { const p = cPerson(mem[i]); return `<div class="d-slot ${p ? '' : 'emp'}">${i === 0 ? '👑 ' : `${i + 1}. `}${p ? `${nmH(p)} <span class="sub">${totalBase(p)}점</span>` : '<span class="sub">—</span>'}</div>` }).join('')}
    <div class="d-sum sub">팀 점수 합 ${mem.reduce((s, id) => s + (cPerson(id) ? totalBase(cPerson(id)) : 0), 0)}</div></div>`;
}
function dPickHTML(d) {
  const turn = dTurn(d), o = dOrder(d), pool = dPool(d);
  let streak = 0, at = 0; if (turn >= 0) { let i = d.picks.length; while (i > 0 && o[i - 1] === turn) { i--; at++ } i = d.picks.length; while (i < o.length && o[i] === turn) { i++; streak++ } streak += at }
  return `${turn >= 0 ? `<div class="d-turn t${turn}">${sideIcon(d, turn)} <b>${esc(teamName(d, turn))}</b> 차례 ${streak > 1 ? `· ${streak}명 중 ${at + 1}번째` : ''}<span class="sub">아래에서 한 명을 탭하세요</span></div>`
    : `<div class="d-turn done">✅ 팀 구성 완료!</div>`}
    <div class="d-teams">${dTeamCol(d, 0, turn)}${dTeamCol(d, 1, turn)}</div>
    <div class="card"><div class="h2">🙋 남은 참가자 <span class="tag t-mut">${pool.length}명</span>
      <span class="mla row gap">${d.picks.length ? '<button class="btn sm" data-a="dundo">↩ 한 명 되돌리기</button>' : ''}${turn < 0 ? '<button class="btn sm pri" data-a="dtorps">✊ 진영 선택권 정하기</button>' : ''}</span></div>
      <div class="d-plist">${pool.map(id => { const p = cPerson(id); return `<button class="d-p" data-a="dpick" data-id="${p.id}" ${turn < 0 ? 'disabled' : ''}><span class="d-nm">${nmH(p)}${p.guest ? '<span class="gtag">GUEST</span>' : ''}</span><span class="sub">${totalBase(p)}점 · ${esc(posTxt(p))}</span></button>` }).join('') || '<div class="empty-note">모두 뽑혔어요</div>'}</div>
      ${turn < 0 && pool.length ? `<div class="sub" style="margin-top:8px">⏸ 대기 ${pool.length}명 — 이번 판은 쉬어요</div>` : ''}</div>`;
}
function dRpsHTML(d) {
  const r = d.rps, cap = t => esc(cPerson(d.caps[t])?.name || '?');
  if (r.winner >= 0) {
    const w = r.winner;
    return `<div class="card d-rps"><div class="h2">🏆 ${esc(teamName(d, w))}이 진영 선택권 획득!</div>
      ${r.last ? `<div class="d-rpsres">${cap(0)} ${RPS[r.last[0]]} vs ${RPS[r.last[1]]} ${cap(1)}</div>` : ''}
      <div class="sub" style="text-align:center;margin:10px 0">${cap(w)} 팀장님, 진영을 골라주세요</div>
      <div class="row gap" style="justify-content:center"><button class="btn d-blue" data-a="dside" data-v="blue">🔵 블루 진영</button><button class="btn d-red" data-a="dside" data-v="red">🔴 레드 진영</button></div></div>
      <div class="d-teams">${dTeamCol(d, 0, -1)}${dTeamCol(d, 1, -1)}</div>`;
  }
  return `<div class="card d-rps"><div class="h2">✊ 가위바위보 <span class="sub">이긴 팀장이 진영 선택권 · 각자 자기 칸에서 몰래 내기${r.ties ? ` · 비김 ${r.ties}번` : ''}</span></div>
    ${dRpsBoard(r, 'drps', cap, t => esc(teamName(d, t)))}</div>
    <div class="d-teams">${dTeamCol(d, 0, -1)}${dTeamCol(d, 1, -1)}</div>`;
}
// 가위바위보 두 칸 (선후픽 · 진영 선택 공용)
function dRpsBoard(r, act, cap, sub) {
  const box = (t, k) => `<div class="d-rpsbox t${t}"><div class="d-th">👑 <b>${cap(t)}</b> <span class="sub">${sub(t)}</span></div>
    ${r[k] ? '<div class="d-ready">✅ 선택 완료<br><span class="sub">상대를 기다리는 중…</span></div>'
      : `<div class="d-rpsbtns">${Object.entries(RPS).map(([v, n]) => `<button class="btn" data-a="${act}" data-t="${t}" data-v="${v}">${n}</button>`).join('')}</div>`}</div>`;
  return `${r.last && r.ties ? `<div class="d-rpsres">직전: ${RPS[r.last[0]]} vs ${RPS[r.last[1]]} → 비김! 다시</div>` : ''}
    <div class="d-rpsrow">${box(0, 'a')}<div class="d-vs">VS</div>${box(1, 'b')}</div>`;
}
function rpsPlay(r, t, v) { // 반영했으면 true
  const k = t ? 'b' : 'a'; if (r.winner >= 0 || r[k] || !RPS[v]) return false; r[k] = v;
  if (r.a && r.b) { r.last = [r.a, r.b]; if (r.a === r.b) { r.ties++; r.a = r.b = '' } else r.winner = RPS_WIN[r.a] === r.b ? 0 : 1 }
  return true;
}
// ③ 선후픽: 선택권을 누구에게 줄지 → (1-2-2-2-1이면) 선픽 1명 / 후픽 2명 고르기
function dOrderHTML(d) {
  const o = d.order, capP = t => cPerson(d.caps[t]), cap = t => esc(capP(t)?.name || '?'), sc = t => capP(t) ? totalBase(capP(t)) : 0;
  const diff = Math.abs(sc(0) - sc(1)), low = sc(0) < sc(1) ? 0 : 1;
  const caps = `<div class="d-capres">${[0, 1].map(t => `<div class="d-cap k${t} ${o.holder === t ? 'hold' : ''}">👑 팀장<b>${cap(t)}</b>${sc(t)}점${o.holder === t ? '<br>🎫 선택권' : ''}</div>`).join('')}</div>
    <div class="sub" style="text-align:center;margin-top:6px">팀장 점수 차 ${diff}점${diff ? ` · ${cap(low)} 쪽이 낮아요` : ' · 동밸런스'}</div>`;
  const how = { random: '🎲 랜덤', rps: '✊ 가위바위보 승리', manual: '👆 직접 지정' }[o.method] || '';
  let body;
  if (o.holder >= 0) {
    body = d.mode === 'one'
      ? `<div class="d-rpsres">🎫 ${cap(o.holder)} 팀장 선택권 (${how}) → 1명씩 방식이라 선픽!</div>
         <div class="row" style="justify-content:center;margin-top:10px"><button class="btn pri" data-a="dochoose" data-v="first">⚔️ 팀원 뽑기 시작</button></div>`
      : `<div class="d-rpsres">🎫 ${cap(o.holder)} 팀장 선택권 (${how})</div>
         <div class="sub" style="text-align:center;margin:6px 0 10px">${cap(o.holder)} 팀장님, 어떻게 뽑을지 골라주세요</div>
         <div class="d-choose"><button class="btn" data-a="dochoose" data-v="first"><b>🥇 선픽</b><span>먼저 1명</span></button><button class="btn" data-a="dochoose" data-v="second"><b>🥈 후픽</b><span>나중에 2명 연속</span></button></div>`;
    body += `<div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" data-a="dohow" data-v="">↩ 선택권 다시 정하기</button></div>`;
  } else if (o.method === 'rps') {
    body = `<div class="sub" style="text-align:center;margin-bottom:8px">이긴 팀장이 선후픽 선택권 · 각자 자기 칸에서 몰래 내기${o.rps.ties ? ` · 비김 ${o.rps.ties}번` : ''}</div>
      ${dRpsBoard(o.rps, 'dorps', cap, t => sc(t) + '점')}
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" data-a="dohow" data-v="">↩ 다른 방법</button></div>`;
  } else if (o.method === 'manual') {
    body = `<div class="sub" style="text-align:center;margin-bottom:8px">밸런스가 안 맞을 때 · 선택권을 줄 팀장을 고르세요</div>
      <div class="d-choose">${[0, 1].map(t => `<button class="btn" data-a="doholder" data-v="${t}"><b>${cap(t)}</b><span>${sc(t)}점${diff && t === low ? ' · 점수 낮음' : ''}</span></button>`).join('')}</div>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" data-a="dohow" data-v="">↩ 다른 방법</button></div>`;
  } else {
    body = `<div class="sub" style="text-align:center;margin-bottom:8px">선후픽 선택권을 어떻게 정할까요? ${diff ? '(점수 차가 크면 낮은 쪽에 직접 주는 것도 방법)' : '(동밸런스면 가위바위보 추천)'}</div>
      <div class="d-choose"><button class="btn" data-a="dohow" data-v="random"><b>🎲 랜덤</b><span>바로 정하기</span></button><button class="btn" data-a="dohow" data-v="rps"><b>✊ 가위바위보</b><span>동밸런스일 때</span></button><button class="btn" data-a="dohow" data-v="manual"><b>👆 직접 지정</b><span>밸런스 안 맞을 때</span></button></div>`;
  }
  return `<div class="card d-rps"><div class="h2">🎫 선후픽 정하기 <span class="sub">${d.mode === 'one' ? '1명씩 방식 · 선택권 = 선픽' : '1-2-2-2-1 방식 · 선택권을 얻으면 선픽 1명 / 후픽 2명 중 선택'}</span></div>${caps}<div style="margin-top:14px">${body}</div></div>`;
}
function dDoneHTML(d) {
  return `<div class="card d-final"><div class="h2">🎉 팀 구성 완료</div>
    <div class="sub">${esc(teamName(d, d.side.team))}이 가위바위보 승리 → ${d.side.choice === 'blue' ? '🔵 블루' : '🔴 레드'} 진영 선택</div>
    <div class="row gap" style="margin-top:12px"><button class="btn pri" data-a="dshare">📋 카톡 공유</button><button class="btn" data-a="dagain">🔁 같은 참가자로 다시 뽑기</button></div></div>
    <div class="d-teams">${dTeamCol(d, 0, -1)}${dTeamCol(d, 1, -1)}</div>`;
}
function dShareText(d) {
  let s = '🎲 롤가다 내전 팀 뽑기\n';
  [0, 1].sort((a, b) => sideIcon(d, a) === '🔵' ? -1 : sideIcon(d, b) === '🔵' ? 1 : a - b).forEach(t => {
    s += `\n${sideIcon(d, t)} ${teamName(d, t)}${d.side.choice ? ` (${sideIcon(d, t) === '🔵' ? '블루' : '레드'})` : ''}\n`;
    d.teams[t].forEach((id, i) => { const p = cPerson(id); s += `${i ? '·' : '👑'} ${p ? p.name : '?'}\n` });
  });
  const wait = dPool(d); if (wait.length) s += `\n⏸ 대기: ${wait.map(id => cPerson(id)?.name).join(', ')}\n`;
  return s + '\n#롤가다 #내전 #GLHF';
}

/* ---------- 이벤트 ---------- */
Object.assign(ACT, {
  din: el => { const id = cid(el.dataset.id); commitD(d => { if (d.phase !== 'setup') return false; d.in = d.in.includes(id) ? d.in.filter(x => x !== id) : [...d.in, id] }) },
  dnone: () => commitD(d => { if (d.phase !== 'setup') return false; d.in = [] }),
  dmode: el => commitD(d => { if (d.phase !== 'setup') return false; d.mode = el.dataset.v }),
  dladder: () => commitD(d => { const ids = d.in.filter(id => cPerson(id)); if (ids.length < 4) return false; d.ladder = makeLadder([...ids].sort(() => Math.random() - 0.5)); d.phase = 'ladder' }),
  dshow: () => commitD(d => { if (!d.ladder) return false; d.ladder.shown = true }),
  dstart: () => commitD(d => { if (!d.ladder?.shown) return false; d.caps = ladderCaps(d.ladder); d.order = emptyOrder(); d.teams = [[], []]; d.picks = []; d.phase = 'order' }),
  dohow: el => commitD(d => { if (d.phase !== 'order') return false; const m = el.dataset.v; d.order = emptyOrder(); d.order.method = m; if (m === 'random') d.order.holder = Math.random() < 0.5 ? 0 : 1 }),
  doholder: el => commitD(d => { if (d.phase !== 'order' || d.order.method !== 'manual') return false; d.order.holder = +el.dataset.v ? 1 : 0 }),
  dorps: el => commitD(d => { if (d.phase !== 'order' || d.order.method !== 'rps' || !rpsPlay(d.order.rps, +el.dataset.t, el.dataset.v)) return false; if (d.order.rps.winner >= 0) d.order.holder = d.order.rps.winner }),
  // 선픽 팀장이 caps[0]·teams[0]이 되도록 순서를 맞추고 뽑기 시작
  dochoose: el => commitD(d => { const h = d.order.holder; if (d.phase !== 'order' || h < 0) return false;
    const first = d.mode === 'one' || el.dataset.v === 'first' ? h : 1 - h;
    if (first === 1) d.caps = [d.caps[1], d.caps[0]];
    d.teams = [[d.caps[0]], [d.caps[1]]]; d.picks = []; d.phase = 'pick' }),
  dpick: el => { const id = cid(el.dataset.id); commitD(d => { const t = dTurn(d); if (d.phase !== 'pick' || t < 0 || !dPool(d).includes(id)) return false; d.teams[t].push(id); d.picks.push({ t, id }) }) },
  dundo: () => commitD(d => { const p = d.picks.pop(); if (!p) return false; d.teams[p.t] = d.teams[p.t].filter(x => x !== p.id); d.phase = 'pick'; d.rps = defaultD().rps; d.side = defaultD().side }),
  dtorps: () => commitD(d => { if (dTurn(d) >= 0) return false; d.phase = 'rps'; d.rps = defaultD().rps }),
  drps: el => commitD(d => { if (d.phase !== 'rps' || !rpsPlay(d.rps, +el.dataset.t, el.dataset.v)) return false }),
  dside: el => commitD(d => { if (d.rps.winner < 0) return false; d.side = { team: d.rps.winner, choice: el.dataset.v }; d.phase = 'done' }),
  dshare: () => copyText(dShareText(D)),
  dagain: () => commitD(d => { const keep = { in: d.in, mode: d.mode }; Object.assign(d, defaultD(), keep) }),
  dreset: () => ask('↺ 처음부터', '팀장·팀 구성을 지우고 참가자 선택으로 돌아갈까요? (참가자 체크는 유지돼요)', () => commitD(d => { const keep = { in: d.in, mode: d.mode }; Object.assign(d, defaultD(), keep) }), '처음부터'),
});
Object.assign(INP, { dq: el => { DSYNC.q = el.value; renderDraftKeepSearch() } });

document.head.append(Object.assign(document.createElement('style'), { textContent: `
.d-steps{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.d-steps span{padding:5px 11px;border-radius:999px;font-size:12px;font-weight:800;color:var(--mut);background:var(--glass);border:1px solid var(--line2)}
.d-steps span.on{color:#04121a;background:var(--teal);border-color:transparent}
.d-plist{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.d-p{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;border:1px solid var(--line2);background:var(--panel2);text-align:left;flex-wrap:wrap}
.d-p.on{border-color:var(--teal);background:rgba(10,200,185,.1)}.d-p:disabled{opacity:.5}
.d-p .d-nm{flex:1;min-width:0;font-weight:800}.d-ck{width:18px;height:18px;border-radius:6px;border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--teal2)}
.d-ladder{overflow-x:auto;text-align:center}.d-ladder svg{width:100%;height:auto}
.d-rail{stroke:var(--mut2);stroke-width:3}.d-rung{stroke:var(--mut);stroke-width:3}
.d-path{fill:none;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.d-path.k0{stroke:var(--teal2)}.d-path.k1{stroke:var(--pink)}
.d-lname{fill:var(--txt);font-size:13px;font-weight:800;text-anchor:middle}.d-lend{fill:var(--mut);font-size:13px;font-weight:900;text-anchor:middle}.d-lend.cap{fill:var(--gold2)}
.d-capres{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:12px}
.d-cap{padding:10px 16px;border-radius:14px;border:1px solid var(--line);text-align:center;font-size:12px;color:var(--mut)}.d-cap b{display:block;font-size:18px;color:var(--txt)}
.d-cap.k0{border-color:var(--teal)}.d-cap.k1{border-color:var(--pink)}.d-cap.hold{box-shadow:0 0 0 3px rgba(200,170,110,.5);color:var(--gold2)}
.d-choose{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.d-choose .btn{flex-direction:column;min-width:140px;padding:14px 16px;gap:4px}.d-choose .btn b{font-size:16px}.d-choose .btn span{font-size:11.5px;color:var(--mut);font-weight:700}
.d-teams{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
@media (max-width:560px){.d-teams{grid-template-columns:1fr}.d-vs{width:100%;text-align:center}}
.d-team{padding:14px}.d-team.turn{border-color:var(--gold);box-shadow:0 0 0 2px rgba(200,170,110,.35)}
.d-th{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}.d-th b{font-size:16px}
.d-slot{padding:7px 10px;border-radius:10px;background:var(--glass);margin-top:5px;font-weight:700}.d-slot.emp{opacity:.6}
.d-sum{margin-top:8px;text-align:right}
.d-turn{padding:12px 16px;border-radius:14px;background:rgba(200,170,110,.12);border:1px solid var(--line);font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.d-turn.done{background:rgba(10,200,185,.12)}
.d-rpsrow{display:flex;gap:12px;align-items:stretch;justify-content:center;flex-wrap:wrap}
.d-rpsbox{flex:1;min-width:220px;border:1px solid var(--line2);border-radius:14px;padding:12px}
.d-rpsbtns{display:flex;gap:6px;flex-wrap:wrap}.d-rpsbtns .btn{flex:1;font-size:15px;padding:12px 8px}
.d-ready{text-align:center;padding:14px 0;font-weight:800;color:var(--teal2)}
.d-vs{align-self:center;font-weight:900;color:var(--gold2)}
.d-rpsres{text-align:center;font-size:16px;font-weight:800;margin:6px 0}
.d-blue{background:#1f4fa8;color:#fff;border:0;padding:14px 22px;font-size:15px}.d-red{background:#a8263b;color:#fff;border:0;padding:14px 22px;font-size:15px}
` }));
