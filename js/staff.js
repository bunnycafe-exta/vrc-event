(() => {
  'use strict';

  // Apps Script のウェブアプリURL（staff-backend/Code.gs をデプロイして発行されるURL）
  const API_URL = 'https://script.google.com/macros/s/AKfycbxnsu8F6veXx1C90dQJ0w5nOYPfQdu3DIW-FrqLWNKHKl5EgiKOvXIG0gnHxnI-O42MUw/exec';

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

  function demoNowMinute() {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function demoDateJa(d) {
    const [y, m, day] = d.split('-').map(Number);
    const dow = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, day)).getUTCDay());
    return `${y}年${m}月${day}日（${dow}）`;
  }

  function demoMessage(e) {
    const lines = ['【EXTA 出勤確認】', '次回の営業日が決まりました。', '', `日時：${demoDateJa(e.date)} ${e.startTime}〜${e.endTime}`, `回答期限：${demoDateJa(e.deadline.slice(0, 10))} ${e.deadline.slice(11, 16)}`];
    if (e.note) lines.push('', e.note);
    lines.push('', 'ご都合を「出勤できます」「出勤できません」からお選びください。', '期限を過ぎると回答できなくなります。', '', '▼回答はこちら', 'https://bunnycafe-exta.github.io/vrc-event/staff.html');
    return lines.join('\n');
  }

  function demoLoad() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    return { events: [], placements: {} };
  }

  function demoSave(db) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  function demoPlacement(db, date) {
    const rows = db.placements[date];
    if (!rows) return null;
    const rotations = {};
    rows.forEach((r) => { (rotations[r.rotation] = rotations[r.rotation] || []).push({ position: r.position, stations: [r.position * 2 - 1, r.position * 2], name: r.name }); });
    return { date, rotations: Object.keys(rotations).map(Number).sort((a, b) => a - b).map((rot) => ({ rotation: rot, slots: rotations[rot].sort((a, b) => a.position - b.position) })) };
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
    const phase = (e) => (demoNowMinute() >= e.deadline ? 'closed' : 'open');
    const eff = (e, name) => { const r = e.responses[name]; if (r && r.final) return r.final; return r && r.answer === 'yes' ? 'ok' : 'ng'; };
    const stateOf = () => {
      const e = current();
      const out = { user: { name: user.name, role: user.role }, event: null, myAnswer: '', placement: null };
      if (!e) return out;
      out.event = { id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime, deadline: e.deadline, note: e.note, phase: phase(e), message: demoMessage(e) };
      if (user.role === 'cast') out.myAnswer = (e.responses[user.name] || {}).answer || '';
      else {
        const rows = DEMO_CASTS.map((name) => ({ name, answer: (e.responses[name] || {}).answer || '', final: (e.responses[name] || {}).final || '', effective: eff(e, name) }));
        out.detail = { rows, counts: { yes: rows.filter((r) => r.answer === 'yes').length, no: rows.filter((r) => r.answer === 'no').length, none: rows.filter((r) => !r.answer).length, attend: rows.filter((r) => r.effective === 'ok').length } };
      }
      out.placement = demoPlacement(db, e.date);
      return out;
    };
    const parseInput = () => {
      const deadline = String(p.deadline || '').replace('T', ' ').slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { error: '日付の形式が正しくありません' };
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) return { error: '回答期限の形式が正しくありません' };
      if (deadline <= demoNowMinute()) return { error: '回答期限は現在より後の日時にしてください' };
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
        db.events.forEach((e) => { if (e.status === 'active') e.status = 'cancelled'; });
        const responses = {};
        DEMO_CASTS.slice(1, 8).forEach((n) => { responses[n] = { answer: 'yes' }; });
        DEMO_CASTS.slice(8).forEach((n) => { responses[n] = { answer: 'no' }; });
        db.events.push({ id: String(Date.now()), ...r.value, status: 'active', createdAt: String(Date.now()), responses });
        demoSave(db);
        return ok(stateOf());
      }
      case 'closeNow': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        e.deadline = demoNowMinute(); demoSave(db);
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
        const names = DEMO_CASTS.filter((n) => eff(e, n) === 'ok');
        if (!names.length) return fail('出勤するキャストがいません');
        for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
        db.placements[e.date] = names.map((name, i) => ({ rotation: Math.floor(i / 6) + 1, position: (i % 6) + 1, name }));
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

  function renderPlacement(container, placement) {
    container.replaceChildren();
    if (!placement) return;
    placement.rotations.forEach((rot) => {
      container.append(el('h3', 'staff-rot-title', `第${rot.rotation}ローテーション`));
      const grid = el('div', 'placement-grid');
      rot.slots.forEach((slot) => {
        const card = el('div', 'placement-slot' + (me && slot.name === me.name ? ' is-me' : ''));
        card.append(el('span', 'placement-stations', `${slot.stations.join('・')}番`), el('span', 'placement-name', slot.name));
        grid.append(card);
      });
      container.append(grid);
    });
  }

  const ANSWER_LABEL = { yes: '出勤できます', no: '出勤できません', '': '未回答' };

  function renderCast(state) {
    const e = state.event;
    $('castEmpty').hidden = Boolean(e);
    $('castEvent').hidden = !e;
    $('castPlacementCard').hidden = !state.placement;
    renderPlacement($('castPlacement'), state.placement);
    if (!e) return;

    const closed = e.phase === 'closed';
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
    if (state.myAnswer && !state.placement) info.push('配置場所が出るまでお待ちください。');
    $('castInfo').textContent = info.join('\n');
    $('castInfo').style.whiteSpace = 'pre-line';
  }

  function renderOwner(state) {
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
      tr.append(el('td', '', r.name));
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
    renderPlacement($('ownerPlacement'), state.placement);
  }

  function renderState(state) {
    currentState = state;
    me = state.user;
    $('userName').textContent = me.name;
    $('userRole').textContent = me.role === 'owner' ? 'OWNER' : 'CAST';
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
    if (currentState && currentState.event && !confirm('現在の出勤確認は取り消され、新しい内容に置き換わります。よろしいですか？')) return;
    const msg = $('eventFormMessage');
    const res = await api('createEvent', pendingEvent);
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    hidePreview();
    $('eventNote').value = '';
    renderState(res);
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
    if (successText) say(msg, successText, true);
  }

  function setFinal(name, value) {
    return ownerAction('setFinal', { name, final: value });
  }

  async function assign() {
    const msg = $('placementMessage');
    say(msg, '');
    const res = await api('assign');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderState(res);
    say(msg, '配置を抽選しました。キャストの画面にも表示されます。', true);
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

    window.setInterval(() => {
      if (!appView.hidden && document.visibilityState === 'visible') loadState(true);
    }, POLL_MS);

    if (getToken() && await loadState()) showView('app');
    else showView('login');
  }

  init();
})();
