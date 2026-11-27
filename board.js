'use strict';
/* =========================================================
   📝 공지 → 게시판 — 누구나 글쓰기 · 실시간 공유
   Firestore lolgadaCenter/season4_posts 문서 하나에 글 목록(JSON)을 담는다.
   삭제: 글쓴 브라우저 또는 운영진 · 📌 고정: 운영진
   index.html 의 전역(fb, esc, toast, ask, isAdmin, render, UI, V …)을 그대로 쓴다.
   ========================================================= */
const FB_DOC_P = ['lolgadaCenter', (typeof G_DEV !== 'undefined' && G_DEV) ? 'season4_posts_dev' : 'season4_posts'];
const BP_MAX = 300, BP_TEXT = 1000, BP_NAME = 20;
const BRD = { posts: [], got: false, unsub: null, name: '', text: '', me: '' };
try { BRD.name = localStorage.getItem('lolgada.board.name') || ''; BRD.me = localStorage.getItem('lolgada.board.me') || '' } catch (_) {}
if (!BRD.me) { BRD.me = Math.random().toString(36).slice(2) + Date.now().toString(36); try { localStorage.setItem('lolgada.board.me', BRD.me) } catch (_) {} }

const normPost = p => ({ id: String(p?.id || ''), name: String(p?.name || '익명').slice(0, BP_NAME), text: String(p?.text || '').slice(0, BP_TEXT), at: +p?.at || 0, by: String(p?.by || ''), pin: !!p?.pin });
const normPosts = a => Array.isArray(a) ? a.map(normPost).filter(p => p.id && p.text) : [];
const pRef = () => fb.fs.doc(fb.db, ...FB_DOC_P);
const boardOpen = () => UI.tab === 'rules' && UI.rtab === 'board';

function startBoardSync() {
  stopBoardSync();
  BRD.unsub = fb.fs.onSnapshot(pRef(), snap => {
    BRD.got = true; const d = snap.exists() ? snap.data() : null;
    try { BRD.posts = normPosts(d && d.json ? JSON.parse(d.json) : []) } catch (e) { console.error(e) }
    if (boardOpen() && M.classList.contains('hidden')) { const el = $('#bplist'); if (el) el.innerHTML = boardListHTML(); else render() } // 글 쓰는 중이어도 입력칸은 건드리지 않음
  }, e => console.error('board sync', e));
}
function stopBoardSync() { try { BRD.unsub && BRD.unsub() } catch (_) {} BRD.unsub = null; BRD.got = false }
async function commitP(fn) {
  if (!fb || !fb.fs) { toast('서버에 연결되면 글을 쓸 수 있어요', 'err'); return false }
  try {
    let ok = true;
    await fb.fs.runTransaction(fb.db, async tx => {
      const s = await tx.get(pRef()); const cur = normPosts(s.exists() && s.data().json ? JSON.parse(s.data().json) : []);
      if (fn(cur) === false) { ok = false; return }
      const keep = cur.filter(p => p.pin).concat(cur.filter(p => !p.pin).sort((a, b) => b.at - a.at)).slice(0, BP_MAX);
      tx.set(pRef(), { json: JSON.stringify(keep), at: Date.now() });
    });
    return ok;
  } catch (e) { console.error(e); toast('저장 실패 — 연결을 확인해주세요', 'err'); return false }
}

/* ---------- 화면 ---------- */
function bpTime(t) {
  const d = new Date(t), now = Date.now(), m = Math.floor((now - t) / 60000);
  if (m < 1) return '방금'; if (m < 60) return `${m}분 전`; if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function boardListHTML() {
  if (!fb || !fb.fs) return '<div class="empty-note">🔌 서버에 연결되면 게시판이 보여요</div>';
  if (!BRD.got) return '<div class="empty-note">⏳ 불러오는 중…</div>';
  const A = isAdmin(), list = [...BRD.posts].sort((a, b) => (b.pin - a.pin) || (b.at - a.at));
  return list.map(p => `<div class="bp ${p.pin ? 'pin' : ''}">
      <div class="bp-h"><b>${esc(p.name)}</b>${p.pin ? '<span class="tag t-amber">📌 고정</span>' : ''}<span class="sub">${bpTime(p.at)}</span>
        <span class="mla row gap">${A ? `<button class="btn sm" data-a="bppin" data-id="${esc(p.id)}">${p.pin ? '고정 해제' : '📌 고정'}</button>` : ''}${A || p.by === BRD.me ? `<button class="btn sm danger" data-a="bpdel" data-id="${esc(p.id)}">삭제</button>` : ''}</span></div>
      <div class="bp-t">${esc(p.text)}</div></div>`).join('') || '<div class="empty-note">아직 글이 없어요 · 첫 글을 남겨보세요 ✍️</div>';
}
function boardHTML() {
  return `<div class="card"><div class="h2">✍️ 글쓰기 <span class="sub">누구나 · 내전 후기, 건의, 모집 등 자유롭게</span></div>
      <div class="bp-form">
        <input class="inp" data-i="bpname" maxlength="${BP_NAME}" placeholder="닉네임" value="${esc(BRD.name)}">
        <textarea class="inp" data-i="bptext" maxlength="${BP_TEXT}" rows="3" placeholder="내용을 입력하세요">${esc(BRD.text)}</textarea>
        <div class="row"><span class="sub" id="bpcnt">${BRD.text.length}/${BP_TEXT}</span><button class="btn pri mla" data-a="bpadd">📝 올리기</button></div>
      </div></div>
    <div class="card"><div class="h2">📝 게시판 <span class="tag t-mut">${BRD.posts.length}개</span></div><div class="bp-list" id="bplist">${boardListHTML()}</div></div>`;
}

/* ---------- 이벤트 ---------- */
Object.assign(ACT, {
  bpadd: async () => {
    const name = BRD.name.trim(), text = BRD.text.trim();
    if (!name) return toast('닉네임을 입력해주세요', 'err');
    if (!text) return toast('내용을 입력해주세요', 'err');
    const post = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, text, at: Date.now(), by: BRD.me, pin: false };
    if (await commitP(cur => { cur.unshift(post) })) { BRD.text = ''; try { localStorage.setItem('lolgada.board.name', name) } catch (_) {} render(); toast('📝 글을 올렸어요!') }
  },
  bpdel: el => { const id = el.dataset.id; ask('🗑 글 삭제', '이 글을 삭제할까요?', () => commitP(cur => { const i = cur.findIndex(p => p.id === id); if (i < 0) return false; if (!isAdmin() && cur[i].by !== BRD.me) return false; cur.splice(i, 1) }), '삭제') },
  bppin: el => { if (!isAdmin()) return; const id = el.dataset.id; commitP(cur => { const p = cur.find(x => x.id === id); if (!p) return false; p.pin = !p.pin }) },
});
Object.assign(INP, {
  bpname: el => { BRD.name = el.value },
  bptext: el => { BRD.text = el.value; const c = $('#bpcnt'); if (c) c.textContent = `${el.value.length}/${BP_TEXT}` },
});
if (fb && fb.fs && !BRD.unsub) startBoardSync();

document.head.append(Object.assign(document.createElement('style'), { textContent: `
.bp-form{display:flex;flex-direction:column;gap:8px}.bp-form input{max-width:220px}.bp-form textarea{width:100%;resize:vertical;min-height:84px;font:inherit;line-height:1.5}
.bp-list{display:flex;flex-direction:column;gap:10px}
.bp{padding:12px 14px;border-radius:14px;border:1px solid var(--line2);background:var(--panel2)}
.bp.pin{border-color:var(--gold);background:rgba(200,170,110,.08)}
.bp-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}.bp-h b{font-size:15px}
.bp-t{white-space:pre-wrap;word-break:break-word;line-height:1.6}
` }));
