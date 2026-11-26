/* =========================================================
   👥 멤버 — 롤가다 구성원 명단 (시즌·내전 종류와 무관)
   닉네임 · 티어 · 주라인 · 부라인. 멤버 추가는 이 탭에서만.
   명단 자체는 S.players(팀 대항전·팀 뽑기와 공유), 티어·라인은 Firestore season4_games/roster/{멤버id}
   ========================================================= */
// 마스터부터 세분화. 마스터는 LP로 나누고, 1000LP 이상(그마·챌린저 포함)은 최고 티어 하나로
const M_TIERS = [['M10', '1000LP 이상', '#f4c874'], ['M8', '마스터 800~999LP', '#e0609e'], ['M5', '마스터 500~799LP', '#d066e0'],
  ['M2', '마스터 200~499LP', '#b36cf0'], ['M0', '마스터 0~199LP', '#9b7cf0'], ['DI', '다이아', '#5aa6f0'],
  ['EM', '에메랄드', '#3fc98a'], ['PL', '플래티넘', '#4fc1c4'], ['GO', '골드', '#e0b04a'], ['SI', '실버', '#9fb0bf'], ['BR', '브론즈', '#b07a55'], ['IR', '아이언', '#8a8a8a']];
const MT = Object.fromEntries(M_TIERS.map(([k, n, c], i) => [k, { k, n, c, i }]));
const MEM = { q: '', view: 'all' };
const rosterOf = id => (GM.roster && GM.roster[id]) || {};
const mTierBadge = k => MT[k] ? `<span class="m-tier" style="--c:${MT[k].c}">${MT[k].n}</span>` : '<span class="sub">미정</span>';
const M_EMO = { SUP: '🩹' }; // 멤버 탭에서만 서폿 = 힐 느낌
const mLane = k => PK[k] ? `${M_EMO[k] || PK[k].e} ${PK[k].n}` : '';
const mSel = (attrs, cur, opts, ph) => `<select class="inp m-sel" ${attrs}><option value="">${ph}</option>${opts.map(([k, n]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
const M_LANES = () => G_POS.map(k => [k, mLane(k)]);

function renderMembers() {
  const A = isAdmin(), q = MEM.q.trim().toLowerCase(), v = PK[MEM.view] ? MEM.view : 'all';
  const tierI = p => MT[rosterOf(p.id).tier]?.i ?? 99, byTier = (a, b) => tierI(a) - tierI(b) || a.name.localeCompare(b.name, 'ko');
  const mainOf = p => rosterOf(p.id).main, laneN = k => S.players.filter(p => mainOf(p) === k).length;
  // 기본은 전체 멤버 티어순, 라인 탭은 그 라인이 주라인인 멤버만
  const list = S.players.filter(p => (v === 'all' || mainOf(p) === v) && (!q || p.name.toLowerCase().includes(q))).sort(byTier);
  const row = p => { const r = rosterOf(p.id); return `<tr>
      <td class="g-nm"><b>${esc(p.name)}</b></td>
      <td>${A ? mSel(`data-c="mtier" data-id="${p.id}"`, r.tier, M_TIERS, '티어 미정') : mTierBadge(r.tier)}</td>
      <td>${A ? mSel(`data-c="mmain" data-id="${p.id}"`, r.main, M_LANES(), '미정') : (mLane(r.main) || '<span class="sub">미정</span>')}</td>
      <td>${A ? mSel(`data-c="msub" data-id="${p.id}"`, r.sub, M_LANES().filter(([k]) => k !== r.main), '없음') : (mLane(r.sub) || '<span class="sub">–</span>')}</td></tr>` };
  const rows = list.map(row).join('');
  V.innerHTML = `<div class="sec-head"><div><div class="h1">👥 멤버</div>
    <div class="sub">롤가다 구성원 ${S.players.length}명 · 여기 등록된 멤버가 팀 뽑기·팀 대항전에 나와요 · ${A ? '티어·라인은 고르면 바로 저장돼요' : '티어·라인은 운영진이 설정해요'}</div></div>
    ${A ? '<button class="btn pri" data-a="mnew">＋ 멤버 추가</button>' : ''}</div>
  <div class="card"><div class="h2">📋 멤버 목록 <span class="sub">티어순</span>
      <input class="inp mla" style="width:180px" data-i="mq" placeholder="🔍 닉네임 검색" value="${esc(MEM.q)}"></div>
    <div class="g-seg m-lanes">${[['all', `전체 <span class="sub">${S.players.length}</span>`], ...G_POS.map(k => [k, `${mLane(k)} <span class="sub">${laneN(k)}</span>`])].map(([k, n]) => `<button class="chip ${v === k ? 'on' : ''}" data-a="msort" data-v="${k}">${n}</button>`).join('')}</div>
    <div class="g-scroll"><table class="g-tbl g-rank m-tbl"><thead><tr><th>닉네임</th><th>티어</th><th>주라인</th><th>부라인</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty-note">${v === 'all' ? '멤버가 없어요' : `${mLane(v)}이(가) 주라인인 멤버가 아직 없어요`}</td></tr>`}</tbody></table></div></div>`;
}

const mWrite = (id, r) => fb.fs.setDoc(gDoc('roster', String(id)), { tier: r.tier || '', main: r.main || '', sub: r.sub || '', at: Date.now() });
async function mSave(el, field) {
  if (!isAdmin()) { toast('운영진만 바꿀 수 있어요', 'err'); render(); return }
  const id = Number(el.dataset.id), cur = { ...rosterOf(id) }; cur[field] = el.value || '';
  if (field === 'main' && cur.sub === cur.main) cur.sub = '';
  GM.roster = { ...(GM.roster || {}), [id]: cur }; render(); // 화면 먼저 바꾸고 저장
  try { await mWrite(id, cur) } catch (e) { console.error(e); toast('저장 실패 — 다시 시도해 주세요', 'err') }
}
function mNewModal() {
  if (!isAdmin()) { toast('운영진만 추가할 수 있어요', 'err'); return }
  modal(`<div class="mh">➕ 멤버 추가</div>
    <div class="af">
      <div><label class="fl">닉네임 *</label><input class="inp" style="width:100%" id="mnName" maxlength="20" placeholder="예) 말차" autocomplete="off"></div>
      <div class="row2"><div><label class="fl">티어</label>${mSel('id="mnTier"', '', M_TIERS, '티어 미정')}</div>
        <div><label class="fl">주라인</label>${mSel('id="mnMain"', '', M_LANES(), '미정')}</div>
        <div><label class="fl">부라인</label>${mSel('id="mnSub"', '', M_LANES(), '없음')}</div></div>
    </div>
    <div class="mbtns"><button class="btn" data-a="mclose">취소</button><button class="btn pri" data-a="mnsave">✅ 추가하기</button></div>`);
  setTimeout(() => $('#mnName')?.focus(), 40);
}
async function mNewSave() {
  const name = ($('#mnName')?.value || '').trim().slice(0, 20);
  if (!name) { toast('닉네임을 입력해주세요 ✍️', 'err'); $('#mnName')?.focus(); return }
  if (S.players.some(p => p.name === name)) { toast(`'${name}'은(는) 이미 멤버예요`, 'err'); $('#mnName')?.focus(); return }
  const r = { tier: $('#mnTier').value, main: $('#mnMain').value, sub: $('#mnSub').value }; if (r.sub === r.main) r.sub = '';
  let id = null;
  if (!commit(() => { const p = mkPlayer(S, { name }); id = p.id; S.players.push(p) })) return;
  closeModal(); toast(`✅ '${name}' 님 추가 완료! (총 ${S.players.length}명)`);
  if (r.tier || r.main) { GM.roster = { ...(GM.roster || {}), [id]: r }; render(); try { await mWrite(id, r) } catch (e) { console.error(e); toast('티어·라인 저장 실패 — 목록에서 다시 골라주세요', 'err') } }
}
Object.assign(CHG, { mtier: el => mSave(el, 'tier'), mmain: el => mSave(el, 'main'), msub: el => mSave(el, 'sub') });
Object.assign(ACT, { msort: el => { MEM.view = el.dataset.v; render() }, mnew: mNewModal, mnsave: mNewSave });
Object.assign(INP, { mq: el => { MEM.q = el.value; const pos = el.selectionStart; render(); const n = $('[data-i="mq"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch (_) {} } } });

document.head.append(Object.assign(document.createElement('style'), { textContent: `
.m-tier{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:800;font-size:12px;color:var(--c);border:1px solid var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.m-sel{min-width:110px;padding:4px 6px;font-size:13px}
.m-tbl td{vertical-align:middle}
.m-lanes{margin:0 0 10px;flex-wrap:wrap}
` }));
