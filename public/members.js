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
  const A = isAdmin(), unk = mUnknown(), tab = MEM.tab === 'unk' ? 'unk' : 'list';
  V.innerHTML = `<div class="sec-head"><div><div class="h1">👥 멤버</div>
    <div class="sub">롤가다 구성원 ${S.players.length}명 · 여기 등록된 멤버가 팀 뽑기·팀 대항전에 나와요 · ${A ? '티어·라인은 고르면 바로 저장돼요' : '티어·라인은 운영진이 설정해요'}</div></div>
    ${A ? '<button class="btn pri" data-a="mnew">＋ 멤버 추가</button>' : ''}</div>
  <div class="g-vtabs"><button class="${tab === 'list' ? 'on' : ''}" data-a="mtab" data-v="list">👥 멤버 목록</button><button class="${tab === 'unk' ? 'on' : ''}" data-a="mtab" data-v="unk">❔ 미등록 닉네임${unk.length ? ` <b class="m-cnt">${unk.length}</b>` : ''}</button></div>
  ${tab === 'unk' ? mUnknownHTML(unk, A) : mListHTML(A)}`;
}
function mListHTML(A) {
  const q = MEM.q.trim().toLowerCase(), v = PK[MEM.view] ? MEM.view : 'all';
  const tierI = p => MT[rosterOf(p.id).tier]?.i ?? 99, byTier = (a, b) => tierI(a) - tierI(b) || a.name.localeCompare(b.name, 'ko');
  const mainOf = p => rosterOf(p.id).main, laneN = k => S.players.filter(p => mainOf(p) === k).length;
  // 기본은 전체 멤버 티어순, 라인 탭은 그 라인이 주라인인 멤버만
  const list = S.players.filter(p => (v === 'all' || mainOf(p) === v) && (!q || p.name.toLowerCase().includes(q))).sort(byTier);
  const row = p => { const r = rosterOf(p.id), m = mPref(p); return `<tr>
      <td class="g-nm"><b>${esc(p.name)}</b></td>
      <td>${A ? mSel(`data-c="mtier" data-id="${p.id}"`, r.tier, M_TIERS, '티어 미정') : mTierBadge(r.tier)}</td>
      <td><div class="prefs m-prefs">${G_POS.map(k => { const i = m.pref.indexOf(k), no = m.no.includes(k);
        return `<button class="pf ${i >= 0 ? 'on' : ''} ${i === 0 ? 'p1' : ''} ${no ? 'no' : ''}" data-a="mpref" data-id="${p.id}" data-v="${k}" ${A ? '' : 'disabled'} title="${A ? '누를 때마다 지망 추가 → 🚫 불가 → 해제' : ''}"><span>${M_EMO[k] || PK[k].e}</span>${PK[k].n}${i >= 0 ? `<i>${i + 1}</i>` : no ? '<i>✕</i>' : ''}</button>` }).join('')}</div></td></tr>` };
  return `<div class="card"><div class="h2">📋 멤버 목록 <span class="sub">티어순</span>
      <input class="inp mla" style="width:180px" data-i="mq" placeholder="🔍 닉네임 검색" value="${esc(MEM.q)}"></div>
    <div class="g-seg m-lanes">${[['all', `전체 <span class="sub">${S.players.length}</span>`], ...G_POS.map(k => [k, `${mLane(k)} <span class="sub">${laneN(k)}</span>`])].map(([k, n]) => `<button class="chip ${v === k ? 'on' : ''}" data-a="msort" data-v="${k}">${n}</button>`).join('')}</div>
    <div class="g-scroll"><table class="g-tbl g-rank m-tbl"><thead><tr><th>닉네임</th><th>티어</th><th>포지션 <span class="sub">숫자 = 지망 순서 (1지망 = 주라인) · ✕ = 불가</span></th></tr></thead>
      <tbody>${list.map(row).join('') || `<tr><td colspan="3" class="empty-note">${v === 'all' ? '멤버가 없어요' : `${mLane(v)}이(가) 주라인인 멤버가 아직 없어요`}</td></tr>`}</tbody></table></div></div>`;
}

// ❔ 미등록 닉네임: 멤버로 연결 안 된 게임 닉네임별 통계 (전 시즌·전 종류)
function mUnknown() {
  const by = new Map();
  for (const g of GM.games) g.teams.forEach((t, ti) => t.players.forEach(p => {
    if (!p.rid.trim() || linkOf(p.rid)) return;
    const k = nkey(p.rid), s = by.get(k) || by.set(k, { rid: p.rid, n: 0, w: 0, k: 0, d: 0, a: 0, ch: {}, last: '', seasons: new Set() }).get(k);
    s.n++; if (g.win === ti + 1) s.w++; s.k += p.k; s.d += p.d; s.a += p.a; s.ch[p.champ] = (s.ch[p.champ] || 0) + 1; if (g.date > s.last) s.last = g.date; s.seasons.add(g.season);
  }));
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last) || b.n - a.n);
}
function mUnknownHTML(unk, A) {
  const memberSel = rid => `<select class="inp m-sel" data-c="glink" data-v="${esc(rid)}"><option value="">멤버 선택…</option><option value="guest">🎟 게스트 (랭킹 제외)</option>
    ${[...S.players].sort(nameSort).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`;
  const rows = unk.map(x => { const most = Object.entries(x.ch).sort((a, b) => b[1] - a[1]).slice(0, 3), sg = A ? gSuggest(x.rid) : [];
    return `<tr><td class="g-nm"><b>${esc(x.rid)}</b><div class="sub">${[...x.seasons].sort((a, b) => a - b).map(seasonName).join(' · ')}</div></td>
      <td>${x.n}</td><td><b class="${x.w / x.n >= 0.5 ? 'g-up' : 'g-dn'}">${pct(x.w / x.n)}</b></td><td>${((x.k + x.a) / Math.max(1, x.d)).toFixed(2)}</td>
      <td class="g-mosts">${most.map(([id, c]) => `<span class="g-most" title="${esc(champName(id))} ${c}판"><img src="${champImg(id)}" alt="">${c > 1 ? `<i>${c}</i>` : ''}</span>`).join('')}</td>
      <td class="sub">${x.last}</td>
      ${A ? `<td><div class="m-merge">${sg.map(s => `<button class="btn sm pri" data-a="gmerge" data-v="${esc(x.rid)}" data-id="${s.id}" title="이름 유사도 ${Math.round(s.sim * 100)}% · 같은 경기에 함께 나온 적 없음">→ ${esc(player(s.id).name)}</button>`).join('')}${memberSel(x.rid)}<button class="btn sm gold" data-a="mnreg" data-v="${esc(x.rid)}" title="기존 멤버가 아니면 새 멤버로 등록">＋ 새 멤버로 등록</button></div></td>` : ''}</tr>` }).join('');
  // 이미 연결된 닉네임 (운영진: 연결 끊기)
  const byMember = new Map(); Object.values(GM.ids).forEach(v => { const k = String(v.mid); if (!byMember.has(k)) byMember.set(k, []); byMember.get(k).push(v.name) });
  return `<div class="card"><div class="h2">❔ 미등록 닉네임 <span class="sub">멤버로 연결 안 된 게임 닉네임 ${unk.length}개 · 이 기록은 통계·순위에서 빠져 있어요 · 멤버를 고르면 지난 기록까지 그 멤버로 바로 합산돼요</span></div>
    ${unk.length ? `<div class="g-scroll"><table class="g-tbl g-rank m-tbl"><thead><tr><th>닉네임</th><th>판수</th><th>승률</th><th>KDA</th><th>주챔프</th><th>최근 경기</th>${A ? '<th>어떤 멤버인가요?</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
      ${A ? '' : '<div class="sub" style="margin-top:8px">누구인지 아시면 운영진에게 알려주세요 · 연결은 운영진이 해요</div>'}`
    : '<div class="empty-note">✅ 모든 게임 닉네임이 멤버에 연결돼 있어요</div>'}
    ${A ? `<details class="g-linked" style="margin-top:14px"><summary class="sub" style="cursor:pointer;font-weight:800">🔗 이미 연결된 닉네임 보기 (멤버 ${byMember.size}명)</summary>
      <div class="g-ids" style="margin-top:10px">${[...byMember.entries()].sort((a, b) => (a[0] === 'guest') - (b[0] === 'guest')).map(([mid, xs]) => `<div class="g-idgrp"><b>${mid === 'guest' ? '🎟 게스트' : esc(player(+mid)?.name || '?')}</b>
        <div>${xs.map(n => `<span class="g-alias">${esc(n)}<button class="g-x" data-a="gunlink" data-v="${esc(n)}" title="연결 끊기">✕</button></span>`).join('')}</div></div>`).join('')}</div></details>` : ''}
  </div>`;
}

// 🏠 홈: 포지션 수급 현황 (멤버 탭의 주라인·부라인 기준)
function mSupplyHTML() {
  const n = S.players.length, mx = Math.max(1, n / 2);
  const sup = G_POS.map(k => ({ k, main: S.players.filter(p => rosterOf(p.id).main === k).length, sub: S.players.filter(p => rosterOf(p.id).sub === k).length }));
  const none = S.players.filter(p => !PK[rosterOf(p.id).main]).length;
  return `<div class="card"><div class="h2">🧭 포지션 수급 현황 <span class="sub">멤버 ${n}명 기준</span><button class="btn sm mla" data-a="tab" data-v="members">👥 멤버 보기 ›</button></div>
    <div class="supply">${sup.map(s => `<div class="sup"><span>${PK[s.k].e} ${PK[s.k].n}</span>
      <div class="track"><i class="any" style="width:${Math.min(100, (s.main + s.sub) / mx * 100)}%"></i><i class="first" style="width:${Math.min(100, s.main / mx * 100)}%"></i></div>
      <em>주 ${s.main} · 부 ${s.sub}</em></div>`).join('')}</div>
    <div class="sub" style="margin-top:10px">진한 막대 = 주라인 · 연한 막대 = 부라인까지 포함${none ? ` · ❔ 주라인 미정 <b style="color:var(--txt)">${none}명</b> — 👥 멤버 탭에서 정해주세요` : ' · 모든 멤버 주라인 등록 완료 👏'}</div></div>`;
}

const mWrite =(id, r) => fb.fs.setDoc(gDoc('roster', String(id)), { tier: r.tier || '', main: r.main || '', sub: r.sub || '',
  ...(Array.isArray(r.pref) ? { pref: r.pref, no: r.no || [] } : {}), at: Date.now() });
// 지망·불가: 멤버 탭에서 한 번이라도 고쳤으면 roster.pref/no, 아니면 주/부라인 + 예전 팀 대항전 3~5지망·불가
function mPref(p) {
  const r = rosterOf(p.id);
  if (Array.isArray(r.pref)) return { pref: r.pref, no: (r.no || []).filter(k => !r.pref.includes(k)) };
  const ml = [r.main, r.sub].filter((k, i, a) => PK[k] && a.indexOf(k) === i);
  const pref = ml.length ? [...ml, ...(p.pos || []).filter(k => !ml.includes(k))] : [...(p.pos || [])];
  return { pref, no: (p.no || []).filter(k => !pref.includes(k)) };
}
async function mPrefSave(el) {
  if (!isAdmin()) { toast('운영진만 바꿀 수 있어요', 'err'); return }
  const id = Number(el.dataset.id), k = el.dataset.v, p = player(id); if (!p) return;
  let { pref, no } = mPref(p); pref = [...pref]; no = [...no];
  if (pref.includes(k)) { pref = pref.filter(x => x !== k); no.push(k) } // 지망 → 불가
  else if (no.includes(k)) no = no.filter(x => x !== k);                // 불가 → 해제
  else pref.push(k);                                                    // 해제 → 다음 지망
  const cur = { ...rosterOf(id), pref, no, main: pref[0] || '', sub: pref[1] || '' };
  GM.roster = { ...(GM.roster || {}), [id]: cur }; render();
  try { await mWrite(id, cur) } catch (e) { console.error(e); toast('저장 실패 — 다시 시도해 주세요', 'err') }
}
async function mSave(el, field) {
  if (!isAdmin()) { toast('운영진만 바꿀 수 있어요', 'err'); render(); return }
  const id = Number(el.dataset.id), cur = { ...rosterOf(id) }; cur[field] = el.value || '';
  if (field === 'main' && cur.sub === cur.main) cur.sub = '';
  GM.roster = { ...(GM.roster || {}), [id]: cur }; render(); // 화면 먼저 바꾸고 저장
  try { await mWrite(id, cur) } catch (e) { console.error(e); toast('저장 실패 — 다시 시도해 주세요', 'err') }
}
// rid: 미등록 닉네임에서 바로 등록할 때 그 게임 닉네임 (저장 후 새 멤버에 연결)
function mNewModal(rid = null) {
  if (!isAdmin()) { toast('운영진만 추가할 수 있어요', 'err'); return }
  MEM.newRid = rid;
  modal(`<div class="mh">➕ ${rid ? '새 멤버로 등록' : '멤버 추가'}</div>
    ${rid ? `<div class="sub">게임 닉네임 <b style="color:var(--txt)">${esc(rid)}</b>의 지난 기록이 새 멤버 통계로 바로 들어가요 · 멤버 이름은 바꿔도 돼요</div>` : ''}
    <div class="af">
      <div><label class="fl">닉네임 *</label><input class="inp" style="width:100%" id="mnName" maxlength="20" placeholder="예) 말차" autocomplete="off" value="${esc(rid || '')}"></div>
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
  // 팀 대항전 참가는 시즌마다 ✋ 참가자 탭에서 따로 체크 → 새 멤버는 미참가로 시작
  if (!commit(() => { const p = mkPlayer(S, { name, active: false }); id = p.id; S.players.push(p) })) return;
  closeModal(); toast(`✅ '${name}' 님 추가 완료! (총 ${S.players.length}명)`);
  const rid = MEM.newRid; MEM.newRid = null; if (rid) await gSetLink(rid, String(id)); // 그 닉네임 기록을 새 멤버로
  if (r.tier || r.main) { GM.roster = { ...(GM.roster || {}), [id]: r }; render(); try { await mWrite(id, r) } catch (e) { console.error(e); toast('티어·라인 저장 실패 — 목록에서 다시 골라주세요', 'err') } }
}
Object.assign(CHG, { mtier: el => mSave(el, 'tier'), mmain: el => mSave(el, 'main'), msub: el => mSave(el, 'sub') });
Object.assign(ACT, { mpref: mPrefSave, msort: el => { MEM.view = el.dataset.v; render() }, mtab: el => { MEM.tab = el.dataset.v; render() }, mnew: () => mNewModal(), mnreg: el => mNewModal(el.dataset.v), mnsave: mNewSave });
Object.assign(INP, { mq: el => { MEM.q = el.value; const pos = el.selectionStart; render(); const n = $('[data-i="mq"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch (_) {} } } });

document.head.append(Object.assign(document.createElement('style'), { textContent: `
.m-tier{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:800;font-size:12px;color:var(--c);border:1px solid var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.m-sel{min-width:110px;padding:4px 6px;font-size:13px}
.m-tbl td{vertical-align:middle}
.sup{grid-template-columns:72px 1fr 92px}
.m-lanes{margin:0 0 10px;flex-wrap:wrap}
.m-cnt{display:inline-block;min-width:18px;padding:0 5px;border-radius:99px;background:var(--pink,#ff5d8f);color:#fff;font-size:11px;margin-left:4px}
.m-merge{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.m-prefs{min-width:260px;max-width:340px}.m-prefs .pf{cursor:pointer;padding:5px 2px}.m-prefs .pf:disabled{cursor:default}
` }));
