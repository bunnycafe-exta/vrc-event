(() => {
  'use strict';

  // Apps Script のウェブアプリURL（staff-backend/Code.gs をデプロイして発行されるURL）
  const API_URL = 'https://script.google.com/macros/s/AKfycbyMTBxWcYZFxXXFRzoOnJ3ZdsJ1ZCnIQ80spkHgVLjB87Z5vfYqejeynore-E80IGLLpw/exec';

  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const DEMO = IS_LOCAL && (!API_URL || new URLSearchParams(location.search).has('demo'));
  const TOKEN_KEY = 'exta-staff-token';
  const TZ = 'Asia/Tokyo';
  const POLL_MS = 60000;

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- API ---------- */

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  async function api(action, payload = {}) {
    if (DEMO) return demoApi(action, payload);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: getToken(), ...payload })
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: '通信に失敗しました。電波の良い場所で再度お試しください' };
    }
  }

  /* ---------- Demo backend (localhost only, no real data) ---------- */

  const DEMO_KEY = 'exta-staff-demo';
  const DEMO_USERS = [
    { id: '1111', password: 'demo', name: 'てとら', role: 'owner' },
    { id: '2222', password: 'demo', name: 'ぷにねこ', role: 'cast' }
  ];
  const DEMO_CASTS = ['ぷにねこ', 'メガスターミー', 'はやしすん', 'オロシ', 'とらまる', 'ユトロス', 'しえる', 'ムレン', 'あかきのこ', 'はるるん'];
  const DEMO_STAFF = ['やさい', 'てばちゃ', 'お兄ちゃん', 'めいるな'];
  const DEMO_ALL = [...DEMO_CASTS.map((name) => ({ name, role: 'cast' })), ...DEMO_STAFF.map((name) => ({ name, role: 'staff' }))];

  function jstNowMinute() {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function dateJa(d) {
    const [y, m, day] = d.split('-').map(Number);
    const dow = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, day)).getUTCDay());
    return `${y}年${m}月${day}日（${dow}）`;
  }

  function demoMessage(e) {
    const lines = ['【EXTA 出勤確認】', '次回の営業日が決まりました。', '', `日時：${dateJa(e.date)} ${e.startTime}〜${e.endTime}`, `回答期限：${dateJa(e.deadline.slice(0, 10))} ${e.deadline.slice(11, 16)}`];
    if (e.note) lines.push('', e.note);
    lines.push('', 'ご都合を「出勤できます」「出勤できません」からお選びください。', '期限を過ぎると回答できなくなります。', '', '▼回答はこちら', 'https://bunnycafe-exta.github.io/vrc-event/staff.html');
    return lines.join('\n');
  }

  function demoLoad() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    return { events: demoPastEvents(), placements: {} };
  }

  // Four finished business days (about monthly) so the history view has something to show
  function demoPastEvents() {
    const today = jstNowMinute().slice(0, 10);
    const [y, m, d] = today.split('-').map(Number);
    const iso = (offsetDays) => new Date(Date.UTC(y, m - 1, d) + offsetDays * 86400000).toISOString().slice(0, 10);
    return [1, 2, 3, 4].map((i) => {
      const responses = {};
      [...DEMO_CASTS, ...DEMO_STAFF].forEach((name, idx) => {
        responses[name] = { answer: (name.length + i * 3 + idx) % 4 === 0 ? 'no' : 'yes' };
      });
      return { id: `past${i}`, date: iso(-28 * i), startTime: '22:00', endTime: '23:30', deadline: `${iso(-28 * i - 4)} 23:59`, note: '', status: 'archived', createdAt: `000${i}`, responses };
    });
  }

  function demoSave(db) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  // The placement logic below mirrors staff-backend/Code.gs (planCasts_ and friends) so the demo behaves like the real thing.
  const DEMO_POSITIONS = 6;

  function demoShuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function demoPlaceAvoiding(names, prevPos) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const slots = Array(DEMO_POSITIONS).fill('');
      const free = demoShuffle([...Array(DEMO_POSITIONS).keys()]);
      let ok = true;
      for (const name of demoShuffle(names)) {
        const idx = free.findIndex((x) => x !== prevPos[name]);
        if (idx < 0) { ok = false; break; }
        slots[free.splice(idx, 1)[0]] = name;
      }
      if (ok) return slots;
    }
    return Array(DEMO_POSITIONS).fill('');
  }

  function demoSpread(names, counts) {
    const size = { A: counts.A, B: counts.B };
    const result = { A: [], B: [] };
    demoShuffle(names).forEach((name) => {
      const g = size.A < size.B ? 'A' : (size.B < size.A ? 'B' : (Math.random() < 0.5 ? 'A' : 'B'));
      result[g].push(name); size[g]++;
    });
    return result;
  }

  function demoPlanCasts(castNames, staffCounts) {
    const all = demoShuffle(castNames);
    const first = all.slice(0, DEMO_POSITIONS);
    const secondMembers = all.slice(DEMO_POSITIONS).concat(demoShuffle(first)).slice(0, DEMO_POSITIONS);
    const firstSlots = demoPlaceAvoiding(first, {});
    const firstPos = {};
    firstSlots.forEach((name, i) => { if (name) firstPos[name] = i; });
    const secondSlots = demoPlaceAvoiding(secondMembers, firstPos);
    const toSlots = (slots) => slots.map((name, i) => ({ position: i + 1, stations: [i * 2 + 1, i * 2 + 2], name }));
    return [
      { rotation: 1, slots: toSlots(firstSlots), overflow: demoSpread(all.filter((n) => !first.includes(n)), staffCounts) },
      { rotation: 2, slots: toSlots(secondSlots), overflow: demoSpread(all.filter((n) => !secondMembers.includes(n)), staffCounts) }
    ];
  }

  function demoPlacement(db, date) {
    return db.placements[date] || null;
  }

  function demoPlacementMessage(e, p) {
    const rule = '───────────────────────────────';
    const lines = ['【EXTA 配置のお知らせ】', `${dateJa(e.date)} ${e.startTime}〜${e.endTime}`, rule];
    const sides = (label, names) => [label, ...(names.length ? names : ['—'])];
    const names = ['', '第一', '第二'];
    p.rotations.forEach((rot) => {
      lines.push('', `【${names[rot.rotation] || `第${rot.rotation}`}ローテ】`, '🐇キャスト');
      rot.slots.forEach((s, i) => lines.push(`${'①②③④⑤⑥'[i]}${s.name || '—'}`));
      lines.push('', '🎩スタッフ', ...sides('①～③サイド', rot.staffSides.A), '', ...sides('③～⑤サイド', rot.staffSides.B));
    });
    if (!p.rotations.length && p.staff) lines.push('', '🎩スタッフ', ...sides('①～③サイド', p.staff.A), '', ...sides('③～⑤サイド', p.staff.B));
    lines.push(rule);
    return lines.join('\n');
  }

  function demoApi(action, p) {
    const db = demoLoad();
    const user = DEMO_USERS.find((u) => getToken() === `demo-${u.id}`);
    const ok = (extra) => Promise.resolve({ ok: true, ...extra });
    const fail = (error) => Promise.resolve({ ok: false, error });

    if (action === 'login') {
      const u = DEMO_USERS.find((x) => x.id === String(p.id).trim() && x.password === p.password);
      return u ? ok({ token: `demo-${u.id}`, user: { name: u.name, role: u.role } }) : fail('IDまたはパスワードが違います');
    }
    if (!user) return fail('ログインの有効期限が切れました。もう一度ログインしてください');

    const current = () => db.events.filter((e) => e.status === 'active').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
    const phase = (e) => (jstNowMinute() >= e.deadline ? 'closed' : 'open');
    const eff = (e, name) => { const r = e.responses[name]; if (r && r.final) return r.final; return r && r.answer === 'yes' ? 'ok' : 'ng'; };
    const stateOf = () => {
      const e = current();
      const out = { user: { name: user.name, role: user.role }, event: null, myAnswer: '', placement: null };
      if (!e) return out;
      out.event = { id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime, deadline: e.deadline, note: e.note, phase: phase(e), message: demoMessage(e) };
      if (user.role === 'cast') out.myAnswer = (e.responses[user.name] || {}).answer || '';
      else {
        const rows = DEMO_ALL.map(({ name, role }) => ({ name, role, answer: (e.responses[name] || {}).answer || '', final: (e.responses[name] || {}).final || '', effective: eff(e, name) }));
        out.detail = { rows, counts: { yes: rows.filter((r) => r.answer === 'yes').length, no: rows.filter((r) => r.answer === 'no').length, none: rows.filter((r) => !r.answer).length, attend: rows.filter((r) => r.effective === 'ok').length } };
      }
      const placement = demoPlacement(db, e.date);
      const published = Boolean((db.published || {})[e.id]);
      if (user.role === 'owner') {
        out.placement = placement;
        out.placementStatus = placement ? (published ? 'published' : 'draft') : 'none';
        out.placementMessage = placement ? demoPlacementMessage(e, placement) : '';
      } else {
        out.placement = placement && published ? placement : null;
      }
      return out;
    };
    const parseInput = () => {
      const deadline = String(p.deadline || '').replace('T', ' ').slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { error: '日付の形式が正しくありません' };
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) return { error: '回答期限の形式が正しくありません' };
      if (deadline <= jstNowMinute()) return { error: '回答期限は現在より後の日時にしてください' };
      if (deadline > `${p.date} ${p.startTime}`) return { error: '回答期限は営業開始より前にしてください' };
      return { value: { date: p.date, startTime: p.startTime, endTime: p.endTime, deadline, note: String(p.note || '').trim().slice(0, 300) } };
    };
    const needOwner = () => (user.role === 'owner' ? null : fail('この操作はオーナーのみ可能です'));

    switch (action) {
      case 'state': return ok(stateOf());
      case 'answer': {
        if (user.role !== 'cast') return fail('回答できるのはキャストのみです');
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        if (phase(e) === 'closed') return fail('締め切られました。オーナーに直接ご連絡ください');
        e.responses[user.name] = { ...(e.responses[user.name] || {}), answer: p.answer };
        demoSave(db);
        return ok(stateOf());
      }
      case 'previewEvent': {
        if (needOwner()) return needOwner();
        const r = parseInput();
        return r.error ? fail(r.error) : ok({ message: demoMessage(r.value) });
      }
      case 'createEvent': {
        if (needOwner()) return needOwner();
        const r = parseInput();
        if (r.error) return fail(r.error);
        db.events.forEach((e) => { if (e.status === 'active') e.status = phase(e) === 'closed' ? 'archived' : 'cancelled'; });
        const responses = {};
        DEMO_CASTS.slice(1, 8).forEach((n) => { responses[n] = { answer: 'yes' }; });
        DEMO_CASTS.slice(8).forEach((n) => { responses[n] = { answer: 'no' }; });
        DEMO_STAFF.slice(0, 3).forEach((n) => { responses[n] = { answer: 'yes' }; });
        responses[DEMO_STAFF[3]] = { answer: 'no' };
        db.events.push({ id: String(Date.now()), ...r.value, status: 'active', createdAt: String(Date.now()), responses });
        demoSave(db);
        return ok(stateOf());
      }
      case 'closeNow': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        e.deadline = jstNowMinute(); demoSave(db);
        return ok(stateOf());
      }
      case 'cancelEvent': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        e.status = 'cancelled'; demoSave(db);
        return ok(stateOf());
      }
      case 'setFinal': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        if (phase(e) !== 'closed') return fail('回答の締め切り後に設定できます');
        e.responses[p.name] = { ...(e.responses[p.name] || {}), final: p.final };
        demoSave(db);
        return ok(stateOf());
      }
      case 'assign': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        if (phase(e) !== 'closed') return fail('回答の締め切り後に抽選できます');
        const castNames = DEMO_CASTS.filter((n) => eff(e, n) === 'ok');
        const staffNames = demoShuffle(DEMO_STAFF.filter((n) => eff(e, n) === 'ok'));
        if (!castNames.length && !staffNames.length) return fail('出勤する人がいません');
        let sizeA = Math.ceil(staffNames.length / 2);
        if (staffNames.length % 2 === 1 && Math.random() < 0.5) sizeA = staffNames.length - sizeA;
        const sideA = staffNames.slice(0, sizeA);
        const sideB = staffNames.slice(sizeA);
        db.placements[e.date] = {
          date: e.date,
          rotations: castNames.length ? demoPlanCasts(castNames, { A: sideA.length, B: sideB.length }).map((rot) => ({
            rotation: rot.rotation,
            slots: rot.slots,
            staffSides: { A: sideA.concat(rot.overflow.A), B: sideB.concat(rot.overflow.B) }
          })) : [],
          staff: { A: sideA, B: sideB }
        };
        db.published = db.published || {};
        delete db.published[e.id];
        demoSave(db);
        return ok(stateOf());
      }
      case 'history': {
        if (needOwner()) return needOwner();
        const limit = Number(p.limit) || 0;
        let events = db.events.filter((e) => (e.status === 'active' || e.status === 'archived') && phase(e) === 'closed')
          .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1)));
        if (limit) events = events.slice(0, limit);
        const mark = (name, e) => (eff(e, name) === 'ok' ? 'ok' : 'ng');
        return ok({
          events: events.map((e) => ({
            id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime,
            attend: DEMO_ALL.filter((x) => mark(x.name, e) === 'ok').map((x) => x.name),
            absent: DEMO_ALL.filter((x) => mark(x.name, e) === 'ng').map((x) => x.name)
          })),
          people: DEMO_ALL.map(({ name, role }) => {
            const marks = events.map((e) => mark(name, e));
            const attended = marks.filter((x) => x === 'ok').length;
            return { name, role, attended, total: marks.length, rate: marks.length ? Math.round((attended / marks.length) * 1000) / 10 : null, marks };
          })
        });
      }
      case 'staffList': case 'reissue': case 'addStaff': case 'setActive': {
        if (needOwner()) return needOwner();
        if (!db.people) {
          db.people = [{ name: 'てとら', role: 'owner', id: '1111', active: true }, ...DEMO_ALL.map((x, i) => ({ name: x.name, role: x.role, id: x.name === 'ぷにねこ' ? '2222' : String(3000 + i), active: true }))];
        }
        const randomPassword = () => Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
        const name = String(p.name || '').trim();
        const person = db.people.find((x) => x.name === name);
        if (action === 'staffList') return ok({ people: db.people });
        if (action === 'reissue') {
          if (!person) return fail('対象の人が見つかりません');
          return ok({ credential: { name, id: person.id, password: randomPassword() } });
        }
        if (action === 'setActive') {
          if (!person) return fail('対象の人が見つかりません');
          if (person.role === 'owner') return fail('オーナーは無効にできません');
          person.active = Boolean(p.active); demoSave(db);
          return ok({ people: db.people });
        }
        if (!name || name.length > 20) return fail('名前は1〜20文字で入力してください');
        if (p.role !== 'cast' && p.role !== 'staff') return fail('役割はキャストかスタッフを選んでください');
        if (person) return fail('同じ名前の人がすでにいます');
        const id = String(1000 + Math.floor(Math.random() * 9000));
        db.people.push({ name, role: p.role, id, active: true }); demoSave(db);
        return ok({ credential: { name, id, password: randomPassword() }, people: db.people });
      }
      case 'publishPlacement': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        if (!demoPlacement(db, e.date)) return fail('先に配置を抽選してください');
        db.published = db.published || {};
        db.published[e.id] = true;
        demoSave(db);
        return ok(stateOf());
      }
      default: return fail('不明な操作です');
    }
  }

  /* ---------- UI ---------- */

  const loginView = $('loginView');
  const offlineView = $('offlineView');
  const appView = $('appView');
  let me = null;
  let currentState = null;
  let pendingEvent = null;

  function say(node, text, isOk) {
    node.textContent = text || '';
    node.classList.toggle('is-ok', Boolean(isOk));
  }

  function showView(name) {
    loginView.hidden = name !== 'login';
    offlineView.hidden = name !== 'offline';
    appView.hidden = name !== 'app';
  }

  function logout() {
    setToken('');
    me = null;
    currentState = null;
    manageLoaded = false;
    lastHistoryLoad = 0;
    $('issuedList').replaceChildren(); // 発行したパスワードを画面に残さない
    $('manageBody').replaceChildren();
    $('loginPassword').value = '';
    showView('login');
  }

  function handleAuthError(res) {
    if (res && !res.ok && /有効期限/.test(res.error || '')) {
      logout();
      say($('loginMessage'), res.error);
      return true;
    }
    return false;
  }

  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];
  const ROTATION_NAMES = ['', '第一', '第二'];
  const SIDE_LABELS = { A: '①～③サイド', B: '③～⑤サイド' };

  function renderSides(container, sides) {
    container.append(el('p', 'placement-note', '🎩スタッフ'));
    const grid = el('div', 'placement-grid placement-grid-staff');
    ['A', 'B'].forEach((key) => {
      const names = sides[key];
      const card = el('div', 'placement-slot' + (me && names.includes(me.name) ? ' is-me' : ''));
      card.append(el('span', 'placement-stations', SIDE_LABELS[key]));
      if (!names.length) card.append(el('span', 'placement-name', '—'));
      names.forEach((n) => card.append(el('span', 'placement-name', n)));
      grid.append(card);
    });
    container.append(grid);
  }

  function renderPlacement(container, placement) {
    container.replaceChildren();
    if (!placement) return;
    placement.rotations.forEach((rot) => {
      container.append(el('h3', 'staff-rot-title', `${ROTATION_NAMES[rot.rotation] || `第${rot.rotation}`}ローテ`));
      container.append(el('p', 'placement-note', '🐇キャスト'));
      const grid = el('div', 'placement-grid');
      rot.slots.forEach((slot, i) => {
        const card = el('div', 'placement-slot' + (slot.name ? '' : ' is-empty') + (me && slot.name === me.name ? ' is-me' : ''));
        card.append(el('span', 'placement-stations', `${CIRCLED[i]}（${slot.stations.join('・')}番）`), el('span', 'placement-name', slot.name || '—'));
        grid.append(card);
      });
      container.append(grid);
      renderSides(container, rot.staffSides || { A: [], B: [] });
    });
    if (!placement.rotations.length && placement.staff) {
      container.append(el('h3', 'staff-rot-title', 'スタッフ'));
      renderSides(container, placement.staff);
    }
  }

  const ANSWER_LABEL = { yes: '出勤できます', no: '出勤できません', '': '未回答' };

  function deadlineLabel(deadline) {
    const [date, time] = deadline.split(' ');
    const [, m, d] = date.split('-').map(Number);
    return `${m}月${d}日 ${time}`;
  }

  function renderCast(state) {
    const e = state.event;
    $('castEmpty').hidden = Boolean(e);
    $('castEvent').hidden = !e;
    $('castPlacementCard').hidden = !state.placement;
    renderPlacement($('castPlacement'), state.placement);
    if (!e) return;

    const closed = e.phase === 'closed';
    const badge = $('castPhase');
    badge.textContent = closed ? '回答は締め切られました' : `回答受付中（${deadlineLabel(e.deadline)}まで）`;
    badge.classList.toggle('is-closed', closed);
    $('castMessage').textContent = e.message;
    $('castAnswerBlock').hidden = closed && !state.myAnswer;
    $('castAnswerBlock').querySelector('.staff-ask').textContent = closed ? 'あなたの回答' : 'この日時に出勤できますか？';
    [['answerYes', 'yes'], ['answerNo', 'no']].forEach(([id, value]) => {
      const btn = $(id);
      btn.classList.toggle('is-selected', state.myAnswer === value);
      btn.disabled = closed;
    });

    const info = [];
    if (closed) info.push('回答は締め切られました。変更・追加はオーナーに直接ご連絡ください。');
    else if (state.myAnswer) info.push('回答を受け付けました。（締め切りまでは変更できます）');
    else info.push('締め切りまでに、どちらかを選んでください。');
    if (state.myAnswer && !state.placement) info.push('配置場所が出るまでお待ちください。');
    $('castInfo').textContent = info.join('\n');
    $('castInfo').style.whiteSpace = 'pre-line';
  }

  function renderOwner(state) {
    loadHistory(false);
    loadManage(false);
    const e = state.event;
    $('ownerEmpty').hidden = Boolean(e);
    $('ownerEvent').hidden = !e;
    $('ownerPlacementCard').hidden = !e;
    if (!e) return;

    const closed = e.phase === 'closed';
    const badge = $('ownerPhase');
    badge.textContent = closed ? '締め切り済み' : '回答受付中';
    badge.classList.toggle('is-closed', closed);
    $('ownerMessage').textContent = e.message;
    $('closeNowBtn').hidden = closed;

    const c = state.detail.counts;
    $('ownerCounts').textContent = `出勤できます ${c.yes}名 ／ 出勤できません ${c.no}名 ／ 未回答 ${c.none}名`;

    const body = $('ownerBody');
    body.replaceChildren();
    state.detail.rows.forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', '', r.role === 'staff' ? `${r.name}（スタッフ）` : r.name));
      tr.append(el('td', r.answer === 'yes' ? 'staff-answer-yes' : (r.answer === 'no' ? 'staff-answer-no' : ''), ANSWER_LABEL[r.answer]));
      const judge = el('td');
      if (closed) {
        const group = el('div', 'staff-toggle');
        [['ok', '出勤'], ['ng', '欠勤']].forEach(([value, label]) => {
          const b = el('button', `is-${value}` + (r.effective === value ? ' is-active' : ''), label);
          b.type = 'button';
          b.addEventListener('click', () => setFinal(r.name, value));
          group.append(b);
        });
        judge.append(group);
      } else {
        judge.textContent = '—';
      }
      tr.append(judge);
      body.append(tr);
    });
    $('ownerHint').textContent = closed
      ? `現在の出勤予定は ${c.attend}名です。回答と異なる場合は「出勤／欠勤」を切り替えてください。`
      : '締め切り後に、各キャストの出勤の可否を決められます。';

    $('assignBtn').disabled = !closed;
    $('assignBtn').textContent = state.placement ? 'もう一度抽選する' : '配置を抽選する';
    renderPlacement($('ownerPlacement'), state.placement);

    const status = state.placementStatus;
    $('placementPreview').hidden = !state.placement;
    if (state.placement) {
      $('placementMessageBox').textContent = state.placementMessage;
      const badge = $('placementBadge');
      badge.textContent = status === 'published' ? '確定済み（キャスト・スタッフの画面に表示中）' : '抽選結果（確定するまで、あなたにだけ見えます）';
      badge.classList.toggle('is-closed', status !== 'published');
      $('publishBtn').hidden = status === 'published';
    }
  }

  function renderState(state) {
    currentState = state;
    me = state.user;
    $('userName').textContent = me.name;
    $('userRole').textContent = { owner: 'OWNER', cast: 'CAST', staff: 'STAFF' }[me.role] || '';
    $('castView').hidden = me.role === 'owner';
    $('ownerView').hidden = me.role !== 'owner';
    if (me.role === 'owner') renderOwner(state); else renderCast(state);
  }

  async function loadState(silent) {
    const res = await api('state');
    if (!res.ok) {
      if (!handleAuthError(res) && !silent) { showView('login'); say($('loginMessage'), res.error); }
      return false;
    }
    if (!('event' in res)) {
      if (!silent) { showView('login'); say($('loginMessage'), 'システムを更新中です。しばらくしてからもう一度お試しください'); }
      return false;
    }
    renderState(res);
    return true;
  }

  /* Cast actions */

  async function answer(value) {
    const msg = $('castMessageText');
    say(msg, '');
    const res = await api('answer', { answer: value });
    if (!res.ok) {
      if (!handleAuthError(res)) { say(msg, res.error); await loadState(true); }
      return;
    }
    renderState(res);
  }

  /* Owner actions */

  function eventFields() {
    return {
      date: $('eventDate').value,
      startTime: $('eventStart').value,
      endTime: $('eventEnd').value,
      deadline: $('eventDeadline').value,
      note: $('eventNote').value
    };
  }

  function hidePreview() {
    pendingEvent = null;
    $('eventPreview').hidden = true;
  }

  async function previewEvent(e) {
    e.preventDefault();
    const msg = $('eventFormMessage');
    say(msg, '');
    const fields = eventFields();
    const res = await api('previewEvent', fields);
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); hidePreview(); return; }
    pendingEvent = fields;
    $('previewMessage').textContent = res.message;
    $('eventPreview').hidden = false;
  }

  async function confirmEvent() {
    if (!pendingEvent) return;
    const prev = currentState && currentState.event;
    if (prev && !confirm(prev.phase === 'closed'
      ? '現在の出勤確認は履歴に保存され、新しい出勤確認に切り替わります。よろしいですか？'
      : '現在の出勤確認はまだ締め切られていないため、取り消されて新しい内容に置き換わります。よろしいですか？')) return;
    const msg = $('eventFormMessage');
    const res = await api('createEvent', pendingEvent);
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    hidePreview();
    $('eventNote').value = '';
    renderState(res);
    loadHistory(true);
    say(msg, '確定しました。キャストの画面に表示されます。下の「現在の出勤確認」から文面をコピーして、連絡にお使いください。', true);
  }

  async function copyText(sourceId, msgId) {
    const msg = $(msgId);
    try {
      await navigator.clipboard.writeText($(sourceId).textContent);
      say(msg, '文面をコピーしました。', true);
    } catch (e) {
      say(msg, 'コピーできませんでした。文面を長押し（選択）してコピーしてください。');
    }
  }

  async function ownerAction(action, payload, successText) {
    const msg = $('ownerMessageText');
    say(msg, '');
    const res = await api(action, payload);
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderState(res);
    loadHistory(true);
    if (successText) say(msg, successText, true);
  }

  /* Staff management (owner): IDs, password reissue, add / disable */

  const STAFF_PAGE_URL = 'https://bunnycafe-exta.github.io/vrc-event/staff.html';
  const ROLE_LABEL = { owner: 'オーナー', cast: 'キャスト', staff: 'スタッフ' };
  let manageLoaded = false;

  function credentialMessage(c) {
    return ['【EXTA スタッフページ】', `${c.name}さん`, '', `ログインID：${c.id}`, `パスワード：${c.password}`, '', '▼ログインはこちら', STAFF_PAGE_URL, '', '※他の人には共有しないでください。'].join('\n');
  }

  async function copyValue(text, button, okLabel) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = el('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const original = button.textContent;
    button.textContent = okLabel || 'コピーしました';
    button.classList.add('is-ok');
    window.setTimeout(() => { button.textContent = original; button.classList.remove('is-ok'); }, 1400);
  }

  function addIssuedCard(c) {
    const card = el('div', 'issued-card');
    card.append(el('p', 'issued-title', `${c.name}さんの新しいログイン情報`), el('p', 'issued-sub', 'この表示は、画面を閉じる・再読み込みすると消えます。先にコピーして送ってください。'));
    [['ログインID', c.id], ['パスワード', c.password]].forEach(([label, value]) => {
      const row = el('div', 'issued-row');
      const btn = el('button', 'mini-btn', 'コピー');
      btn.type = 'button';
      btn.addEventListener('click', () => copyValue(value, btn));
      row.append(el('span', 'issued-label', label), el('span', 'issued-value', value), btn);
      card.append(row);
    });
    const actions = el('div', 'issued-actions');
    const all = el('button', 'mini-btn', 'まとめてコピー（そのまま送れる文面）');
    all.type = 'button';
    all.addEventListener('click', () => copyValue(credentialMessage(c), all));
    const close = el('button', 'mini-btn is-ghost', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => card.remove());
    actions.append(all, close);
    card.append(actions);
    $('issuedList').prepend(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderManage(people) {
    const body = $('manageBody');
    body.replaceChildren();
    people.forEach((p) => {
      const tr = el('tr', p.active ? '' : 'staff-inactive');
      const name = el('td', '', p.name);
      name.append(el('small', 'staff-user-role', ROLE_LABEL[p.role] || p.role));
      const idCell = el('td');
      idCell.append(document.createTextNode(`${p.id} `));
      const copyId = el('button', 'mini-btn is-ghost', 'コピー');
      copyId.type = 'button';
      copyId.addEventListener('click', () => copyValue(p.id, copyId));
      idCell.append(copyId);

      const actions = el('td');
      const reissueBtn = el('button', 'mini-btn', 'パスワードを再発行');
      reissueBtn.type = 'button';
      reissueBtn.addEventListener('click', () => reissue(p.name));
      actions.append(reissueBtn);
      if (p.role !== 'owner') {
        const toggle = el('button', 'mini-btn is-ghost', p.active ? '無効にする' : '有効にする');
        toggle.type = 'button';
        toggle.style.marginLeft = '6px';
        toggle.addEventListener('click', () => setActive(p.name, !p.active));
        actions.append(toggle);
      }
      tr.append(name, idCell, el('td', '', p.active ? '有効' : '無効'), actions);
      body.append(tr);
    });
  }

  async function loadManage(force) {
    if (!force && manageLoaded) return;
    manageLoaded = true;
    const res = await api('staffList');
    if (!res.ok) { if (!handleAuthError(res)) say($('manageMessage'), res.error); return; }
    renderManage(res.people);
  }

  async function reissue(name) {
    if (!confirm(`${name}さんのパスワードを再発行します。今のパスワードは使えなくなります。よろしいですか？`)) return;
    say($('manageMessage'), '');
    const res = await api('reissue', { name });
    if (!res.ok) { if (!handleAuthError(res)) say($('manageMessage'), res.error); return; }
    addIssuedCard(res.credential);
    say($('manageMessage'), `${name}さんの新しいパスワードを作りました。上の枠からコピーして送ってください。`, true);
  }

  async function setActive(name, active) {
    if (!active && !confirm(`${name}さんを無効にします。ログインできなくなり、出勤確認・配置・出勤率の対象から外れます。よろしいですか？`)) return;
    say($('manageMessage'), '');
    const res = await api('setActive', { name, active });
    if (!res.ok) { if (!handleAuthError(res)) say($('manageMessage'), res.error); return; }
    renderManage(res.people);
    loadHistory(true);
  }

  async function addStaff(e) {
    e.preventDefault();
    say($('manageMessage'), '');
    const res = await api('addStaff', { name: $('addName').value, role: $('addRole').value });
    if (!res.ok) { if (!handleAuthError(res)) say($('manageMessage'), res.error); return; }
    $('addName').value = '';
    addIssuedCard(res.credential);
    renderManage(res.people);
    say($('manageMessage'), `${res.credential.name}さんを追加しました。上の枠からコピーして送ってください。`, true);
  }

  /* History (owner) */

  let lastHistoryLoad = 0;

  function renderHistory(res) {
    $('historyEmpty').hidden = res.events.length > 0;
    $('historyBody').hidden = res.events.length === 0;
    if (!res.events.length) return;

    const shortDate = (d) => { const [, m, day] = d.split('-').map(Number); return `${m}/${day}`; };
    const head = $('matrixHead');
    head.replaceChildren();
    const headRow = el('tr');
    ['名前', '出勤率', '出勤'].forEach((t) => headRow.append(el('th', '', t)));
    res.events.forEach((e) => headRow.append(el('th', '', shortDate(e.date))));
    head.append(headRow);

    const people = res.people.slice().sort((a, b) => (b.rate === null) - (a.rate === null) || (b.rate || 0) - (a.rate || 0));
    const body = $('matrixBody');
    body.replaceChildren();
    people.forEach((p) => {
      const tr = el('tr');
      tr.append(el('td', '', p.role === 'staff' ? `${p.name}（スタッフ）` : p.name));
      tr.append(el('td', 'staff-rate', p.rate === null ? '—' : `${p.rate}%`));
      tr.append(el('td', '', p.total ? `${p.attended}/${p.total}` : '—'));
      p.marks.forEach((m) => tr.append(el('td', m === 'ok' ? 'staff-mark-ok' : 'staff-mark-ng', m === 'ok' ? '○' : (m === 'ng' ? '×' : ''))));
      body.append(tr);
    });

    const list = $('eventHistory');
    list.replaceChildren();
    res.events.forEach((e) => {
      const item = el('details', 'staff-history-item');
      item.append(el('summary', '', `${dateJa(e.date)} ${e.startTime}〜${e.endTime} ／ 出勤 ${e.attend.length}名 ・ 欠勤 ${e.absent.length}名`));
      item.append(el('p', '', `出勤：${e.attend.join('、') || '—'}`), el('p', '', `欠勤：${e.absent.join('、') || '—'}`));
      list.append(item);
    });
  }

  async function loadHistory(force) {
    if (!force && Date.now() - lastHistoryLoad < 30000) return;
    lastHistoryLoad = Date.now();
    const res = await api('history', { limit: Number($('historyRange').value) });
    if (!res.ok) {
      if (!handleAuthError(res)) say($('historyMessage'), res.error);
      return;
    }
    say($('historyMessage'), '');
    renderHistory(res);
  }

  function setFinal(name, value) {
    return ownerAction('setFinal', { name, final: value });
  }

  async function assign() {
    const msg = $('placementMessage');
    say(msg, '');
    if (currentState && currentState.placementStatus === 'published' &&
      !confirm('確定済みの配置を取り消して、抽選し直します。キャストの画面からは、確定するまで配置が消えます。よろしいですか？')) return;
    const res = await api('assign');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderState(res);
    say(msg, '配置を抽選しました。内容を確認して、よければ下の「確定」を押してください。', true);
  }

  async function publishPlacement() {
    const msg = $('placementMessage');
    say(msg, '');
    const res = await api('publishPlacement');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderState(res);
    say(msg, '確定しました。キャスト・スタッフの画面に表示されます。下の文面をコピーして、お知らせにお使いください。', true);
  }

  /* ---------- Wiring ---------- */

  async function init() {
    if (!API_URL && !DEMO) { showView('offline'); return; }

    if (DEMO) {
      const hint = $('demoHint');
      hint.hidden = false;
      hint.textContent = 'デモモード（このパソコン上だけで動作・保存データはこのブラウザ内のみ）｜オーナー: ID 1111 / パスワード demo｜キャスト: ID 2222 / パスワード demo';
    }

    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('loginSubmit');
      btn.disabled = true;
      say($('loginMessage'), '');
      const res = await api('login', { id: $('loginId').value, password: $('loginPassword').value });
      btn.disabled = false;
      if (!res.ok) { say($('loginMessage'), res.error); return; }
      setToken(res.token);
      $('loginPassword').value = '';
      if (await loadState()) showView('app');
    });

    $('logoutBtn').addEventListener('click', logout);
    $('answerYes').addEventListener('click', () => answer('yes'));
    $('answerNo').addEventListener('click', () => answer('no'));

    $('eventForm').addEventListener('submit', previewEvent);
    $('eventForm').addEventListener('input', hidePreview);
    $('eventEdit').addEventListener('click', hidePreview);
    $('eventConfirm').addEventListener('click', confirmEvent);
    $('eventCopy').addEventListener('click', () => copyText('previewMessage', 'eventFormMessage'));
    $('ownerCopy').addEventListener('click', () => copyText('ownerMessage', 'ownerMessageText'));
    $('closeNowBtn').addEventListener('click', () => {
      if (confirm('今すぐ回答を締め切ります。以降、キャストは回答できなくなります。よろしいですか？')) ownerAction('closeNow', {}, '締め切りました。');
    });
    $('cancelEventBtn').addEventListener('click', () => {
      if (confirm('この出勤確認を取り消します。キャストの回答も見えなくなります。よろしいですか？')) ownerAction('cancelEvent', {}, '取り消しました。');
    });
    $('assignBtn').addEventListener('click', assign);
    $('publishBtn').addEventListener('click', publishPlacement);
    $('historyRange').addEventListener('change', () => loadHistory(true));
    $('addStaffForm').addEventListener('submit', addStaff);
    $('placementCopy').addEventListener('click', () => copyText('placementMessageBox', 'placementMessage'));

    window.setInterval(() => {
      if (!appView.hidden && document.visibilityState === 'visible') loadState(true);
    }, POLL_MS);

    // Lock the answer buttons as soon as the deadline passes, even if the page was left open
    window.setInterval(() => {
      const e = currentState && currentState.event;
      if (!appView.hidden && e && e.phase === 'open' && jstNowMinute() >= e.deadline) loadState(true);
    }, 5000);

    if (getToken() && await loadState()) showView('app');
    else showView('login');
  }

  init();
})();
