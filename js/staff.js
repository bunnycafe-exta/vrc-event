(() => {
  'use strict';

  // Apps Script のウェブアプリURLを設定する（staff-backend/Code.gs のデプロイ後に発行されるURL）
  const API_URL = 'https://script.google.com/macros/s/AKfycbysGgVYH_NhpAX_uFGJrUI4LPp1tbJf5Q2RboaRTkuBuIHzVmApibtd-qY8zRtGYOSsxQ/exec';

  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const DEMO = !API_URL && IS_LOCAL;
  const TOKEN_KEY = 'exta-staff-token';
  const TZ = 'Asia/Tokyo';
  const DAY_CHANGE_HOUR = 6;
  const SHIFT_LABEL = { available: '出勤できます', absent: '欠席です' };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- Time helpers (JST) ---------- */

  function jstParts(date) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return parts;
  }

  function jstDate(date) {
    const p = jstParts(date);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function jstTime(date) {
    const p = jstParts(date);
    return `${p.hour}:${p.minute}:${p.second}`;
  }

  function businessDate(date) {
    return jstDate(new Date(date.getTime() - DAY_CHANGE_HOUR * 3600 * 1000));
  }

  function formatMinutes(min) {
    if (!min) return '—';
    return `${Math.floor(min / 60)}時間${String(min % 60).padStart(2, '0')}分`;
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

  function demoLoad() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    const today = businessDate(new Date());
    return {
      attendance: DEMO_CASTS.slice(1, 9).map((name, i) => ({ name, date: today, type: 'in', time: `22:0${i}` })),
      shifts: [], placements: {}
    };
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

  function demoSummary(records) {
    const firstIn = records.find((r) => r.type === 'in');
    if (!firstIn) return { inTime: '', outTime: '', minutes: 0 };
    const outs = records.filter((r) => r.type === 'out' && r.time > firstIn.time);
    const lastOut = outs[outs.length - 1];
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return { inTime: firstIn.time.slice(0, 5), outTime: lastOut ? lastOut.time.slice(0, 5) : '', minutes: lastOut ? Math.max(0, toMin(lastOut.time) - toMin(firstIn.time)) : 0 };
  }

  function demoApi(action, p) {
    const db = demoLoad();
    const user = DEMO_USERS.find((u) => getToken() === `demo-${u.id}`);
    const today = businessDate(new Date());
    const ok = (extra) => Promise.resolve({ ok: true, ...extra });
    const fail = (error) => Promise.resolve({ ok: false, error });

    if (action === 'login') {
      const u = DEMO_USERS.find((x) => x.id === String(p.id).trim() && x.password === p.password);
      return u ? ok({ token: `demo-${u.id}`, user: { name: u.name, role: u.role } }) : fail('IDまたはパスワードが違います');
    }
    if (!user) return fail('ログインの有効期限が切れました。もう一度ログインしてください');

    const mine = db.attendance.filter((r) => r.name === user.name && r.date === today);
    const stateOf = () => {
      const last = mine.length ? mine[mine.length - 1].type : '';
      return { user: { name: user.name, role: user.role }, businessDate: today, status: last === 'in' ? 'in' : last === 'out' ? 'out' : 'none', records: mine.map((r) => ({ type: r.type, time: r.time.slice(0, 5) })), placement: demoPlacement(db, today) };
    };

    switch (action) {
      case 'state': return ok(stateOf());
      case 'punch': {
        const last = mine.length ? mine[mine.length - 1].type : '';
        if (p.type === 'in' && last === 'in') return fail('すでに出勤済みです');
        if (p.type === 'out' && last !== 'in') return fail('出勤の打刻がないため退勤できません');
        const rec = { name: user.name, date: today, type: p.type, time: jstTime(new Date()) };
        db.attendance.push(rec); mine.push(rec); demoSave(db);
        return ok(stateOf());
      }
      case 'history': {
        const dates = [...new Set(db.attendance.filter((r) => r.name === user.name).map((r) => r.date))].sort().reverse();
        return ok({ days: dates.map((d) => ({ date: d, ...demoSummary(db.attendance.filter((r) => r.name === user.name && r.date === d)) })) });
      }
      case 'shifts':
        return ok({ shifts: db.shifts.filter((s) => s.name === user.name && s.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1)).map(({ date, status }) => ({ date, status })) });
      case 'saveShift': {
        if (p.date < today) return fail('過去の日付は登録できません');
        db.shifts = db.shifts.filter((s) => !(s.name === user.name && s.date === p.date));
        db.shifts.push({ name: user.name, date: p.date, status: p.status }); demoSave(db);
        return demoApi('shifts', {});
      }
      case 'deleteShift':
        db.shifts = db.shifts.filter((s) => !(s.name === user.name && s.date === p.date)); demoSave(db);
        return demoApi('shifts', {});
      case 'placement': return ok({ placement: demoPlacement(db, p.date) });
      case 'assign': {
        if (user.role !== 'owner') return fail('この操作はオーナーのみ可能です');
        const names = p.source === 'shift'
          ? db.shifts.filter((s) => s.date === p.date && s.status === 'available' && DEMO_CASTS.includes(s.name)).map((s) => s.name)
          : [...new Set(db.attendance.filter((r) => r.date === p.date && r.type === 'in' && DEMO_CASTS.includes(r.name)).map((r) => r.name))];
        if (!names.length) return fail(p.source === 'shift' ? 'この日に出勤予定のキャストがいません' : 'この日に出勤打刻したキャストがいません');
        for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
        db.placements[p.date] = names.map((name, i) => ({ rotation: Math.floor(i / 6) + 1, position: (i % 6) + 1, name })); demoSave(db);
        return ok({ placement: demoPlacement(db, p.date) });
      }
      case 'overview': {
        const everyone = [{ name: 'てとら', role: 'owner' }, ...DEMO_CASTS.map((name) => ({ name, role: 'cast' }))];
        return ok({ date: p.date, rows: everyone.map((s) => ({ ...s, shift: (db.shifts.find((x) => x.name === s.name && x.date === p.date) || {}).status || '', ...demoSummary(db.attendance.filter((r) => r.name === s.name && r.date === p.date)) })) });
      }
      case 'month': {
        const everyone = [{ name: 'てとら', role: 'owner' }, ...DEMO_CASTS.map((name) => ({ name, role: 'cast' }))];
        return ok({ month: p.month, rows: everyone.map((s) => {
          const dates = [...new Set(db.attendance.filter((r) => r.name === s.name && r.date.slice(0, 7) === p.month).map((r) => r.date))];
          let days = 0; let minutes = 0;
          dates.forEach((d) => { const sm = demoSummary(db.attendance.filter((r) => r.name === s.name && r.date === d)); if (sm.inTime) days++; minutes += sm.minutes; });
          return { ...s, days, minutes };
        }) });
      }
      default: return fail('不明な操作です');
    }
  }

  /* ---------- UI ---------- */

  const loginView = $('loginView');
  const offlineView = $('offlineView');
  const appView = $('appView');
  let me = null;
  let businessToday = '';

  function say(node, text, isOk) {
    node.textContent = text || '';
    node.classList.toggle('is-ok', Boolean(isOk));
  }

  function showView(name) {
    loginView.hidden = name !== 'login';
    offlineView.hidden = name !== 'offline';
    appView.hidden = name !== 'app';
  }

  function activateTab(name) {
    document.querySelectorAll('.staff-tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === name));
    document.querySelectorAll('.staff-panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
    if (name === 'history') loadHistory();
    if (name === 'shift') loadShifts();
    if (name === 'placement') loadPlacement();
    if (name === 'admin') { loadOverview(); loadMonth(); }
  }

  function logout() {
    setToken('');
    me = null;
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

  /* Punch */

  function renderPlacement(container, placement) {
    container.replaceChildren();
    if (!placement) {
      container.append(el('p', 'staff-muted', 'この日の配置はまだ決まっていません。'));
      return;
    }
    placement.rotations.forEach((rot) => {
      container.append(el('h3', 'staff-rot-title', `第${rot.rotation}ローテーション`));
      const grid = el('div', 'placement-grid');
      rot.slots.forEach((slot) => {
        const card = el('div', 'placement-slot' + (slot.name && me && slot.name === me.name ? ' is-me' : ''));
        card.append(el('span', 'placement-stations', `${slot.stations.join('・')}番`), el('span', 'placement-name', slot.name || '—'));
        grid.append(card);
      });
      container.append(grid);
    });
  }

  function renderState(state) {
    me = state.user;
    businessToday = state.businessDate;
    $('userName').textContent = me.name;
    $('userRole').textContent = me.role === 'owner' ? 'OWNER' : 'CAST';
    $('adminTab').hidden = me.role !== 'owner';
    $('assignControls').hidden = me.role !== 'owner';

    const statusText = { none: '未出勤', in: '出勤中', out: '退勤済み' }[state.status];
    const lastIn = [...state.records].reverse().find((r) => r.type === 'in');
    $('punchStatus').textContent = state.status === 'in' && lastIn ? `出勤中（${lastIn.time}〜）` : statusText;
    $('punchIn').disabled = state.status === 'in';
    $('punchOut').disabled = state.status !== 'in';

    const list = $('todayRecords');
    list.replaceChildren();
    state.records.forEach((r) => list.append(el('li', '', `${r.type === 'in' ? '出勤' : '退勤'} ${r.time}`)));
    renderPlacement($('todayPlacement'), state.placement);
  }

  async function loadState() {
    const res = await api('state');
    if (!res.ok) {
      if (!handleAuthError(res)) { showView('login'); say($('loginMessage'), res.error); }
      return false;
    }
    renderState(res);
    return true;
  }

  async function punch(type) {
    const msg = $('punchMessage');
    say(msg, '');
    $('punchIn').disabled = true;
    $('punchOut').disabled = true;
    const res = await api('punch', { type });
    if (!res.ok) {
      if (!handleAuthError(res)) { say(msg, res.error); await loadState(); }
      return;
    }
    renderState(res);
    say(msg, type === 'in' ? '出勤を記録しました。今日もよろしくお願いします！' : '退勤を記録しました。お疲れさまでした！', true);
  }

  /* History */

  async function loadHistory() {
    const body = $('historyBody');
    const res = await api('history');
    if (!res.ok) { handleAuthError(res); return; }
    body.replaceChildren();
    if (!res.days.length) {
      const tr = el('tr'); const td = el('td', 'staff-muted', 'まだ記録がありません');
      td.colSpan = 4; tr.append(td); body.append(tr); return;
    }
    res.days.forEach((d) => {
      const tr = el('tr');
      [d.date, d.inTime || '—', d.outTime || '—', formatMinutes(d.minutes)].forEach((v) => tr.append(el('td', '', v)));
      body.append(tr);
    });
  }

  /* Shifts */

  function renderShifts(shifts) {
    const list = $('shiftList');
    list.replaceChildren();
    if (!shifts.length) { list.append(el('li', 'staff-muted', '登録済みの予定はありません')); return; }
    shifts.forEach((s) => {
      const li = el('li');
      const left = el('span', '', s.date);
      left.append(el('span', 'staff-shift-state' + (s.status === 'absent' ? ' is-absent' : ''), SHIFT_LABEL[s.status] || s.status));
      const del = el('button', 'staff-delete', '取り消し');
      del.type = 'button';
      del.addEventListener('click', async () => {
        const res = await api('deleteShift', { date: s.date });
        if (res.ok) renderShifts(res.shifts); else handleAuthError(res);
      });
      li.append(left, del);
      list.append(li);
    });
  }

  async function loadShifts() {
    if (!$('shiftDate').value) $('shiftDate').value = businessToday;
    $('shiftDate').min = businessToday;
    const res = await api('shifts');
    if (res.ok) renderShifts(res.shifts); else handleAuthError(res);
  }

  /* Placement */

  async function loadPlacement() {
    const input = $('placementDate');
    if (!input.value) input.value = businessToday;
    const res = await api('placement', { date: input.value });
    if (!res.ok) { handleAuthError(res); return; }
    renderPlacement($('placementView'), res.placement);
  }

  async function assign() {
    const msg = $('placementMessage');
    say(msg, '');
    const res = await api('assign', { date: $('placementDate').value, source: $('assignSource').value });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderPlacement($('placementView'), res.placement);
    say(msg, '配置を抽選しました。', true);
    loadState();
  }

  /* Admin */

  async function loadOverview() {
    const input = $('overviewDate');
    if (!input.value) input.value = businessToday;
    const res = await api('overview', { date: input.value });
    if (!res.ok) { handleAuthError(res); return; }
    const body = $('overviewBody');
    body.replaceChildren();
    res.rows.forEach((r) => {
      const tr = el('tr');
      [r.name, SHIFT_LABEL[r.shift] || '—', r.inTime || '—', r.outTime || '—', formatMinutes(r.minutes)].forEach((v) => tr.append(el('td', '', v)));
      body.append(tr);
    });
  }

  async function loadMonth() {
    const input = $('monthPicker');
    if (!input.value) input.value = businessToday.slice(0, 7);
    const res = await api('month', { month: input.value });
    if (!res.ok) { handleAuthError(res); return; }
    const body = $('monthBody');
    body.replaceChildren();
    res.rows.forEach((r) => {
      const tr = el('tr');
      [r.name, `${r.days}日`, formatMinutes(r.minutes)].forEach((v) => tr.append(el('td', '', v)));
      body.append(tr);
    });
  }

  /* ---------- Wiring ---------- */

  function startClock() {
    const tick = () => {
      const now = new Date();
      $('clockTime').textContent = jstTime(now);
      $('clockDate').textContent = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(now);
    };
    tick();
    window.setInterval(tick, 1000);
  }

  async function init() {
    if (!API_URL && !DEMO) { showView('offline'); return; }

    if (DEMO) {
      const hint = $('demoHint');
      hint.hidden = false;
      hint.textContent = 'デモモード（このパソコン上だけで動作・保存データはこのブラウザ内のみ）｜オーナー: ID 1111 / パスワード demo｜キャスト: ID 2222 / パスワード demo';
    }

    startClock();

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
      if (await loadState()) { showView('app'); activateTab('punch'); }
    });

    $('logoutBtn').addEventListener('click', logout);
    $('punchIn').addEventListener('click', () => punch('in'));
    $('punchOut').addEventListener('click', () => punch('out'));
    $('staffTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.staff-tab');
      if (tab) activateTab(tab.dataset.tab);
    });

    $('shiftForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('shiftMessage');
      const res = await api('saveShift', { date: $('shiftDate').value, status: $('shiftStatus').value });
      if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
      renderShifts(res.shifts);
      say(msg, '登録しました。', true);
    });

    $('placementDate').addEventListener('change', loadPlacement);
    $('assignBtn').addEventListener('click', assign);
    $('overviewDate').addEventListener('change', loadOverview);
    $('monthPicker').addEventListener('change', loadMonth);

    if (getToken() && await loadState()) {
      showView('app');
      activateTab('punch');
    } else {
      showView('login');
    }
  }

  init();
})();
