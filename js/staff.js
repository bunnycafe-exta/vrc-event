(() => {
  'use strict';

  // Apps Script のウェブアプリURL（staff-backend/Code.gs をデプロイして発行されるURL）
  const API_URL = window.EXTA_API_URL || '';

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

  // スタッフの配置エリア（4か所）。サーバーの STAFF_AREAS と同じ
  const AREAS = ['A-1', 'A-2', 'B-1', 'B-2'];
  const emptyAreas = () => Object.fromEntries(AREAS.map((a) => [a, []]));

  function demoSplitStaff(names) {
    const groups = emptyAreas();
    const bigger = demoShuffle(AREAS).slice(0, names.length % AREAS.length);
    const base = Math.floor(names.length / AREAS.length);
    let next = 0;
    AREAS.forEach((a) => {
      const size = base + (bigger.includes(a) ? 1 : 0);
      groups[a] = names.slice(next, next + size);
      next += size;
    });
    return groups;
  }

  function demoSpread(names, counts) {
    const size = Object.fromEntries(AREAS.map((a) => [a, counts[a] || 0]));
    const result = emptyAreas();
    demoShuffle(names).forEach((name) => {
      const min = Math.min(...AREAS.map((a) => size[a]));
      const candidates = AREAS.filter((a) => size[a] === min);
      const g = candidates[Math.floor(Math.random() * candidates.length)];
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

  function demoPlacementMessage(e) {
    return [
      '【EXTA 配置のお知らせ】',
      `${dateJa(e.date)} ${e.startTime}〜${e.endTime}`,
      '当日の配置が確定しましたのでご確認ください。',
      '',
      'https://bunnycafe-exta.github.io/vrc-event/staff.html',
      '',
      '変更希望等ございましたら、オーナーまでお問合せください。'
    ].join('\n');
  }

  // Same rules as swapPlacement_ in staff-backend/Code.gs. Returns an error message, or '' when swapped.
  function demoSwap(pl, a, b) {
    if (JSON.stringify(a) === JSON.stringify(b)) return '同じ場所です';
    const rotOf = (n) => pl.rotations.find((r) => r.rotation === Number(n));
    const find = (ref) => {
      if (!ref) return null;
      if (ref.kind === 'slot') {
        const rot = rotOf(ref.rotation);
        const slot = rot && rot.slots.find((s) => s.position === Number(ref.position));
        return slot ? { kind: 'slot', rot, slot } : null;
      }
      if (ref.kind === 'extra') {
        const rot = rotOf(ref.rotation);
        const member = rot && rot.sideMembers[ref.side].find((m) => m.kind === 'extra' && m.name === ref.name);
        return member ? { kind: 'extra', rot, side: ref.side, member } : null;
      }
      if (ref.kind === 'staff') {
        return pl.staff[ref.side] && pl.staff[ref.side].includes(ref.name) ? { kind: 'staff', side: ref.side, name: ref.name } : null;
      }
      return null;
    };
    const A = find(a);
    const B = find(b);
    if (!A || !B) return '最新の配置と合いません。画面を更新してください';
    const sameRotation = () => A.rot === B.rot;
    if (A.kind === 'slot' && B.kind === 'slot') {
      if (!sameRotation()) return '同じローテの中で入れ替えてください';
      [A.slot.name, B.slot.name] = [B.slot.name, A.slot.name];
      if (!A.slot.name && !B.slot.name) return '入れ替える相手がいません';
    } else if ((A.kind === 'slot' && B.kind === 'extra') || (A.kind === 'extra' && B.kind === 'slot')) {
      const s = A.kind === 'slot' ? A : B;
      const x = A.kind === 'extra' ? A : B;
      if (s.rot !== x.rot) return '同じローテの中で入れ替えてください';
      const previous = s.slot.name;
      s.slot.name = x.member.name;
      if (previous) x.member.name = previous;
      else x.rot.sideMembers[x.side] = x.rot.sideMembers[x.side].filter((m) => m !== x.member);
    } else if (A.kind === 'extra' && B.kind === 'extra') {
      if (!sameRotation()) return '同じローテの中で入れ替えてください';
      if (A.side === B.side) return '同じエリアです。別のエリアの人を選んでください';
      A.rot.sideMembers[A.side] = A.rot.sideMembers[A.side].map((m) => (m === A.member ? B.member : m));
      B.rot.sideMembers[B.side] = B.rot.sideMembers[B.side].map((m) => (m === B.member ? A.member : m));
    } else if (A.kind === 'staff' && B.kind === 'staff') {
      if (A.side === B.side) return '同じエリアです。別のエリアの人を選んでください';
      const move = (name, from, to) => {
        pl.staff[from] = pl.staff[from].filter((n) => n !== name);
        pl.staff[to].push(name);
        pl.rotations.forEach((r) => {
          const m = r.sideMembers[from].find((x) => x.kind === 'staff' && x.name === name);
          r.sideMembers[from] = r.sideMembers[from].filter((x) => x !== m);
          r.sideMembers[to].unshift(m);
        });
      };
      move(A.name, A.side, B.side);
      move(B.name, B.side, A.side);
    } else {
      return 'この組み合わせは入れ替えできません（キャスト同士・エリア同士で入れ替えてください）';
    }
    pl.rotations.forEach((r) => { r.staffSides = Object.fromEntries(AREAS.map((a) => [a, r.sideMembers[a].map((m) => m.name)])); });
    return '';
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

    // 出勤確認は、日付が違えば、複数同時に出せる（営業日が過ぎたものは出さない）。操作の対象は、p.eventId で選ぶ
    const activeList = () => db.events.filter((e) => e.status === 'active' && e.date >= jstNowMinute().slice(0, 10))
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.createdAt < b.createdAt ? -1 : 1)));
    const current = () => (p.eventId ? activeList().find((e) => e.id === p.eventId) : activeList()[0]) || null;
    const phase = (e) => (jstNowMinute() >= e.deadline ? 'closed' : 'open');
    const eff = (e, name) => { const r = e.responses[name]; if (r && r.final) return r.final; return r && r.answer === 'yes' ? 'ok' : 'ng'; };
    const entryOf = (e) => {
      const out = { event: { id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime, deadline: e.deadline, note: e.note, phase: phase(e), message: demoMessage(e) }, myAnswer: '', placement: null };
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
    const stateOf = () => {
      const events = activeList().map(entryOf);
      return { user: { name: user.name, role: user.role }, events, event: null, myAnswer: '', placement: null, ...(events[0] || {}) };
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
        e.responses[user.name] = { ...(e.responses[user.name] || {}), answer: p.answer, final: '' };
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
        activeList().filter((e) => e.date === r.value.date).forEach((e) => { e.status = phase(e) === 'closed' ? 'archived' : 'cancelled'; });
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
      case 'reopen': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        if (phase(e) !== 'closed') return fail('すでに回答を受け付けています');
        const deadline = String(p.deadline || '').replace('T', ' ').slice(0, 16);
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) return fail('回答期限の形式が正しくありません');
        if (deadline <= jstNowMinute()) return fail('回答期限は現在より後の日時にしてください');
        if (deadline > `${e.date} ${e.startTime}`) return fail('回答期限は営業開始より前にしてください');
        e.deadline = deadline;
        delete db.placements[e.date];
        if (db.published) delete db.published[e.id];
        demoSave(db);
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
        const groups = demoSplitStaff(staffNames);
        const counts = Object.fromEntries(AREAS.map((a) => [a, groups[a].length]));
        db.placements[e.date] = {
          date: e.date,
          rotations: castNames.length ? demoPlanCasts(castNames, counts).map((rot) => ({
            rotation: rot.rotation,
            slots: rot.slots,
            staffSides: Object.fromEntries(AREAS.map((a) => [a, groups[a].concat(rot.overflow[a])])),
            sideMembers: Object.fromEntries(AREAS.map((a) => [a, groups[a].map((name) => ({ name, kind: 'staff' })).concat(rot.overflow[a].map((name) => ({ name, kind: 'extra' })))]))
          })) : [],
          staff: groups
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
      case 'getMaintenance': case 'setMaintenance': {
        if (needOwner()) return needOwner();
        if (action === 'setMaintenance') db.maintenance = p.on === true;
        demoSave(db);
        return ok({ on: db.maintenance === true });
      }
      case 'getNextOpen': case 'setNextOpen': case 'clearNextOpen': {
        if (needOwner()) return needOwner();
        if (action === 'setNextOpen') db.nextOpen = { date: p.date, startTime: p.startTime, endTime: p.endTime };
        if (action === 'clearNextOpen') delete db.nextOpen;
        demoSave(db);
        return ok({ next: db.nextOpen || null });
      }
      case 'reservationHistory': {
        if (needOwner()) return needOwner();
        const past = demoPastEvents();
        const mk = (name, guests, ordinal, cancelled) => ({ name, guests, ordinal, cancelled: Boolean(cancelled), time: 0 });
        const days = [
          { date: past[0].date, reservations: [mk('さくら', 2, 3), mk('ひなた', 1, 2), mk('はなこ', 1, 1), mk('ゆず', 3, 0, true)], guests: 4, cancelledCount: 1 },
          { date: past[1].date, reservations: [mk('さくら', 2, 2), mk('ひなた', 1, 1)], guests: 3, cancelledCount: 0 },
          { date: past[2].date, reservations: [mk('さくら', 1, 1)], guests: 1, cancelledCount: 0 }
        ];
        return ok({
          days,
          customers: [
            { name: 'さくら', visits: 3, reservations: 3, guests: 5, firstDate: past[2].date, lastDate: past[0].date },
            { name: 'ひなた', visits: 2, reservations: 2, guests: 2, firstDate: past[1].date, lastDate: past[0].date },
            { name: 'はなこ', visits: 1, reservations: 1, guests: 1, firstDate: past[0].date, lastDate: past[0].date }
          ],
          stats: { customers: 3, repeaters: 2, businessDays: 3 }
        });
      }
      case 'vip': case 'vipDraw': case 'vipUndo': case 'vipAdjust': case 'vipNominate': {
        if (needOwner()) return needOwner();
        const WEIGHTS = [4, 2, 1];
        const MIN = 4;
        const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
        const prevDate = demoPastEvents()[0].date;
        const vip = db.vip = db.vip || { log: [{ date: prevDate, key: 'usr-hinata', name: 'ひなた', status: 'win', choice: 'none', nominee: '', carry: '' }, { date: '2000-01-01', key: 'usr-yuzu', name: 'ゆず', status: 'win', choice: '', nominee: '', carry: '' }], adj: {} };
        const CAST = [{ name: 'しえる', attend: 'ok' }, { name: 'とらまる', attend: 'ng' }, { name: 'はやしすん', attend: 'ok' }, { name: 'あかきのこ', attend: 'ng' }, { name: 'てとら', attend: 'unknown' }];
        const people = [
          { key: 'usr-sakura', name: 'さくら', guests: 2, ordinal: 4 },
          { key: 'usr-hinata', name: 'ひなた', guests: 1, ordinal: 5 },
          { key: 'usr-hanako', name: 'はなこ', guests: 1, ordinal: 1 },
          { key: 'usr-yuzu', name: 'ゆず', guests: 1, ordinal: 6 },
          { key: 'usr-mike', name: 'みけ', guests: 1, ordinal: 4 }
        ];
        const sat = (l) => l.status === 'win' || l.status === 'carry';
        const view = () => {
          const winRow = vip.log.find((l) => sat(l) && l.date === date);
          let carryOffer = null;
          let carryLapsed = null;
          if (!winRow) {
            const src = vip.log.find((l) => l.status === 'win' && l.carry === 'yes' && l.date === prevDate);
            if (src) {
              const who = people.find((x) => x.key === src.key);
              if (who) carryOffer = { key: src.key, name: who.name, nominee: src.nominee, from: src.date };
              else carryLapsed = { name: src.name, nominee: src.nominee, from: src.date };
            }
          }
          const cands = people.map((p) => {
            const a = vip.adj[p.key] || { visit: 0, win: 0 };
            const past = vip.log.filter((l) => l.key === p.key && l.status === 'win' && l.date !== date);
            const lastWin = vip.log.filter((l) => l.key === p.key && sat(l) && l.date !== date).reduce((m, l) => (l.date > m ? l.date : m), '');
            const visits = p.ordinal + a.visit;
            const wins = Math.max(0, past.length + a.win);
            const declined = vip.log.some((l) => l.key === p.key && l.status === 'declined' && l.date === date);
            let reason = '';
            if (winRow && winRow.key === p.key) reason = winRow.status === 'carry' ? '持ち越しのVIP' : '今回の当選';
            else if (declined) reason = '辞退（今回は対象外）';
            else if (carryOffer && carryOffer.key === p.key) reason = '持ち越しのVIP（抽選なし）';
            else if (carryOffer) reason = '持ち越しのVIPがいるため、今回は抽選なし';
            else if (visits < MIN) reason = `来店${Math.max(visits, 0)}回目（${MIN}回目から対象）`;
            else if (lastWin === prevDate) reason = '前回の営業でVIPに当選（連続は避ける）';
            return { key: p.key, name: p.name, guests: p.guests, visits, visitBase: p.ordinal, visitAdjust: a.visit, wins, winBase: past.length, winAdjust: a.win, lastWin, eligible: !reason, reason, weight: WEIGHTS[Math.min(wins, 2)], isWinner: Boolean(winRow && winRow.key === p.key), isCarry: Boolean(carryOffer && carryOffer.key === p.key), percent: 0 };
          });
          const pool = cands.filter((c) => c.eligible);
          const total = pool.reduce((s, c) => s + c.weight, 0);
          pool.forEach((c) => { c.percent = Math.round((c.weight / total) * 1000) / 10; });
          cands.sort((a, b) => (b.isWinner - a.isWinner) || (b.isCarry - a.isCarry) || (b.eligible - a.eligible) || (b.visits - a.visits));
          const noteOf = (l) => (l.status === 'carry' ? '持ち越し' : '')
            + (l.choice === 'cast' && l.nominee ? (l.status === 'carry' ? '・' : '') + '指名：' + l.nominee + (l.carry === 'yes' ? '（当日不在のため、次回へ持ち越し）' : '') : '')
            + (l.choice === 'none' ? (l.status === 'carry' ? '・' : '') + '指名なし' : '');
          return {
            date, prevDate, minVisits: MIN, weights: WEIGHTS, candidates: cands, eligibleCount: pool.length,
            winner: winRow ? { key: winRow.key, name: winRow.name, date, type: winRow.status, choice: winRow.choice || '', nominee: winRow.nominee || '', carry: winRow.carry === 'yes', carryFrom: winRow.carryFrom || '' } : null,
            carryOffer, carryLapsed, cast: CAST, attendState: 'closed',
            history: vip.log.filter(sat).sort((a, b) => (a.date < b.date ? 1 : -1)).map((l) => ({ date: l.date, name: l.name, note: noteOf(l) }))
          };
        };
        const v = view();
        if (action === 'vipDraw') {
          if (v.winner) return fail('この営業日は、すでに抽選済みです');
          let none = false;
          if (v.carryOffer) {
            const o = v.carryOffer;
            vip.log.push({ date, key: o.key, name: o.name, status: 'carry', choice: o.nominee ? 'cast' : '', nominee: o.nominee, carry: '', carryFrom: o.from });
          } else {
            const pool = v.candidates.filter((c) => c.eligible);
            none = pool.length === 0;
            if (pool.length) {
              let r = Math.random() * pool.reduce((s, c) => s + c.weight, 0);
              let pick = pool[pool.length - 1];
              for (const c of pool) { r -= c.weight; if (r < 0) { pick = c; break; } }
              vip.log.push({ date, key: pick.key, name: pick.name, status: 'win', choice: '', nominee: '', carry: '' });
            }
          }
          demoSave(db);
          return ok({ ...view(), none });
        }
        if (action === 'vipUndo') {
          if (!v.winner) return fail('いまの営業日に、当選者はいません。画面を更新してください');
          const i = vip.log.findIndex((l) => sat(l) && l.date === date);
          if (p.mode === 'void' || vip.log[i].status === 'carry') vip.log.splice(i, 1); else vip.log[i].status = 'declined';
          demoSave(db);
          return ok(view());
        }
        if (action === 'vipNominate') {
          if (!v.winner) return fail('いまの営業日に、当選者はいません。画面を更新してください');
          const row = vip.log.find((l) => sat(l) && l.date === date);
          const isCarryIn = row.status === 'carry';
          let choice = 'none';
          let nominee = '';
          let carry = '';
          if (p.mode === 'cast') {
            const hit = CAST.find((c) => c.name === p.cast);
            if (!hit) return fail('指名するキャストを選んでください（キャストの一覧にない名前です）');
            choice = 'cast';
            nominee = hit.name;
            const auto = hit.attend === 'ng';
            const want = p.carry === undefined || p.carry === null ? auto : Boolean(p.carry);
            if (isCarryIn) {
              if (want || auto) return fail(nominee + 'さんは、その日も出勤しません。持ち越しは1回だけなので、別のキャストを選ぶか、「指名しない」にしてください');
            } else if (want) carry = 'yes';
          } else if (p.mode !== 'none') return fail('指名するか、しないかを選んでください');
          Object.assign(row, { choice, nominee, carry });
          demoSave(db);
          return ok(view());
        }
        if (action === 'vipAdjust') {
          const visit = Math.round(Number(p.visitAdjust));
          const win = Math.round(Number(p.winAdjust));
          if (!isFinite(visit) || !isFinite(win) || Math.abs(visit) > 50 || Math.abs(win) > 50) return fail('手直しは、-50〜50の整数で入力してください');
          if (visit === 0 && win === 0) delete vip.adj[p.key]; else vip.adj[p.key] = { visit, win };
          demoSave(db);
          return ok(view());
        }
        return ok(v);
      }
      case 'setReservationCap': case 'resetReservationCount': case 'cancelReservation': case 'reopenReservation': case 'reservations': {
        if (needOwner()) return needOwner();
        const lim = db.limit = db.limit || { cap: 6, reset: false, accepting: true, cancelled: [] };
        const sample = [
          ['2026/10/20 21:14:08', '参加済み', '2', 'さくら', 'https://vrchat.com/home/user/usr_00000000-demo', 'https://x.com/sample_a', 'はじめてです。よろしくお願いします。'],
          ['2026/10/19 08:02:41', '参加済み', '', 'ひなた', 'https://vrchat.com/home/user/usr_00000000-demo2', 'https://x.com/sample_b', ''],
          ['2026/10/18 12:00:00', '参加済み', '3', 'ゆず', 'https://vrchat.com/home/user/usr_00000000-demo3', 'https://x.com/sample_c', '']
        ].map((values, i) => ({ row: i + 2, key: `${values[0]}|${values[3]}`, values, ordinal: [3, 2, 1][i], date: ''  }));
        const guestsOf = (r) => Number(r.values[2]) || 1;
        const usedNow = () => sample.filter((r) => !lim.cancelled.includes(r.key) && !lim.reset).reduce((s, r) => s + guestsOf(r), 0);
        const status = () => {
          const used = usedNow();
          const full = lim.cap > 0 && used >= lim.cap;
          if (full) lim.accepting = false;
          demoSave(db);
          return { cap: lim.cap, used, full, accepting: lim.accepting, error: '' };
        };
        if (action === 'setReservationCap') { lim.cap = Number(p.cap); if (usedNow() < lim.cap || lim.cap === 0) lim.accepting = true; }
        if (action === 'resetReservationCount') { lim.reset = true; lim.accepting = true; }
        if (action === 'cancelReservation') {
          lim.cancelled = lim.cancelled.filter((k) => k !== p.key);
          if (p.cancelled) lim.cancelled.push(p.key);
        }
        if (action === 'reopenReservation') {
          const s = status();
          if (s.full) return fail('まだ満席です。上限の人数を増やすか、キャンセルにしてから、再開してください');
          lim.accepting = true;
        }
        if (action !== 'reservations') return ok({ limit: status() });
        const active = sample.filter((r) => !lim.cancelled.includes(r.key));
        return ok({
          headers: ['タイムスタンプ', '当イベントのグループ参加はされてますか？', '何名様でご来店予定ですか？', 'お名前(VRChatの表示名)', 'VRCアカウントURL', 'X(旧Twitter)のアカウントURL', 'ご来店前に確認しておきたい事項等'],
          rows: sample.map((r) => ({ ...r, cancelled: lim.cancelled.includes(r.key), counted: !lim.cancelled.includes(r.key) && !lim.reset })),
          total: active.length, cancelledCount: sample.length - active.length, guests: active.reduce((s, r) => s + guestsOf(r), 0), shown: sample.length,
          limit: status(), next: db.nextOpen || null
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
      case 'swapPlacement': {
        if (needOwner()) return needOwner();
        const e = current();
        if (!e) return fail('現在、出勤の確認はありません');
        const pl = demoPlacement(db, e.date);
        if (!pl) return fail('先に配置を抽選してください');
        const error = demoSwap(pl, p.a, p.b);
        if (error) return fail(error);
        demoSave(db);
        return ok(stateOf());
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

  const OWNER_TAB_KEY = 'exta-owner-tab';
  const OWNER_TABS = ['status', 'create', 'placement', 'reservations', 'vip', 'history', 'manage'];
  let ownerTabReady = false;

  // オーナー画面のタブ切り替え。選んだタブは、再読み込みしても覚えている
  function activateOwnerTab(name, scrollTop) {
    if (!OWNER_TABS.includes(name)) name = 'status';
    document.querySelectorAll('#ownerTabs .staff-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    document.querySelectorAll('.staff-tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    try { sessionStorage.setItem(OWNER_TAB_KEY, name); } catch (e) { /* storage unavailable */ }
    if (name === 'reservations') loadReservations(false);
    if (name === 'vip') loadVip(false);
    if (name === 'create') loadNextOpen();
    if (name === 'manage') loadMaintenance();
    if (scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function restoreOwnerTab() {
    let saved = 'status';
    try { saved = sessionStorage.getItem(OWNER_TAB_KEY) || 'status'; } catch (e) { /* storage unavailable */ }
    activateOwnerTab(saved, false);
  }

  function logout() {
    setToken('');
    me = null;
    currentState = null;
    ownerTabReady = false;
    manageLoaded = false;
    lastHistoryLoad = 0;
    lastReservationLoad = 0;
    $('reservationList').replaceChildren(); // 予約者の個人情報を画面に残さない
    $('rhDays').replaceChildren();
    $('rhCustomers').replaceChildren();
    reserveDays = {};
    $('reservationSummary').hidden = true;
    $('vipBody').replaceChildren(); // VIPの抽選に出ていたお客様の名前も、画面に残さない
    $('vipHistory').replaceChildren();
    $('vipWinnerBox').hidden = true;
    $('vipAdjustForm').hidden = true;
    vipData = null;
    lastVipLoad = 0;
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
  const SIDE_LABELS = Object.fromEntries(AREAS.map((a) => [a, a])); // スタッフのエリアの表示（A-1 など）

  // 入れ替えの相手を選ぶプルダウン。先頭が今の人で、ほかの人を選ぶと、その人と入れ替わる
  function swapSelect(label, currentText, options, selfRef) {
    const select = el('select', 'placement-select');
    select.setAttribute('aria-label', label);
    const current = el('option', '', currentText);
    current.value = '';
    select.append(current);
    options.forEach((o) => {
      const opt = el('option', '', o.label);
      opt.value = JSON.stringify(o.ref);
      select.append(opt);
    });
    select.addEventListener('change', () => {
      if (select.value) swapCells(selfRef, JSON.parse(select.value));
    });
    return select;
  }

  const slotRef = (rot, slot) => ({ kind: 'slot', rotation: rot.rotation, position: slot.position });
  const memberRef = (rot, side, m) => (m.kind === 'extra'
    ? { kind: 'extra', rotation: rot.rotation, side, name: m.name }
    : { kind: 'staff', side, name: m.name });

  // 入れ替えできる相手（バックエンドの swapPlacement_ と同じルール）
  function slotOptions(rot, slot) {
    const others = rot.slots.filter((s) => s.position !== slot.position && (s.name || slot.name))
      .map((s) => ({ label: `${s.name || '空き'}（${CIRCLED[s.position - 1]}）`, ref: slotRef(rot, s) }));
    const extras = AREAS.flatMap((side) => ((rot.sideMembers && rot.sideMembers[side]) || [])
      .filter((m) => m.kind === 'extra')
      .map((m) => ({ label: `${m.name}（${SIDE_LABELS[side]}）`, ref: memberRef(rot, side, m) })));
    return others.concat(extras);
  }

  function memberOptions(rot, side, member) {
    const list = AREAS.filter((area) => area !== side).flatMap((area) => (rot.sideMembers[area] || [])
      .filter((m) => m.kind === member.kind)
      .map((m) => ({ label: `${m.name}（${SIDE_LABELS[area]}）`, ref: memberRef(rot, area, m) })));
    if (member.kind === 'extra') {
      const slots = rot.slots.map((s) => ({ label: `${s.name || '空き'}（${CIRCLED[s.position - 1]}）`, ref: slotRef(rot, s) }));
      return slots.concat(list);
    }
    return list;
  }

  function renderSides(container, rot, editable) {
    const sides = rot.staffSides || emptyAreas();
    container.append(el('p', 'placement-note', '🎩スタッフ'));
    const grid = el('div', 'placement-grid placement-grid-staff');
    AREAS.forEach((key) => {
      const names = sides[key] || [];
      const card = el('div', 'placement-slot' + (me && names.includes(me.name) ? ' is-me' : ''));
      card.append(el('span', 'placement-stations', SIDE_LABELS[key]));
      if (!names.length) card.append(el('span', 'placement-name', '—'));
      const members = editable && rot.sideMembers ? rot.sideMembers[key] : null;
      if (members) {
        members.forEach((m) => {
          const options = memberOptions(rot, key, m);
          card.append(options.length
            ? swapSelect(`${SIDE_LABELS[key]}の ${m.name} を入れ替える`, m.name, options, memberRef(rot, key, m))
            : el('span', 'placement-name', m.name));
        });
      } else {
        names.forEach((n) => card.append(el('span', 'placement-name', n)));
      }
      grid.append(card);
    });
    container.append(grid);
  }

  function renderPlacement(container, placement, editable) {
    container.replaceChildren();
    if (!placement) return;
    placement.rotations.forEach((rot) => {
      container.append(el('h3', 'staff-rot-title', `${ROTATION_NAMES[rot.rotation] || `第${rot.rotation}`}ローテ`));
      container.append(el('p', 'placement-note', '🐇キャスト'));
      const grid = el('div', 'placement-grid');
      rot.slots.forEach((slot, i) => {
        const card = el('div', 'placement-slot' + (slot.name ? '' : ' is-empty') + (me && slot.name === me.name ? ' is-me' : ''));
        card.append(el('span', 'placement-stations', `${CIRCLED[i]}（${slot.stations.join('・')}番）`));
        const options = editable ? slotOptions(rot, slot) : [];
        card.append(options.length
          ? swapSelect(`${CIRCLED[i]}の担当を入れ替える`, slot.name || '空き', options, slotRef(rot, slot))
          : el('span', 'placement-name', slot.name || '—'));
        grid.append(card);
      });
      container.append(grid);
      renderSides(container, rot, editable);
    });
    if (!placement.rotations.length && placement.staff) {
      container.append(el('h3', 'staff-rot-title', 'スタッフ'));
      renderSides(container, { rotation: 0, staffSides: placement.staff }, false);
    }
  }

  async function swapCells(a, b) {
    const msg = $('placementMessage');
    say(msg, '');
    const res = await api('swapPlacement', { a, b, eventId: selectedEventId });
    if (!res.ok) {
      if (!handleAuthError(res)) {
        say(msg, res.error);
        const entry = selectedEntry();
        renderPlacement($('ownerPlacement'), entry && entry.placement, true); // プルダウンを元に戻す
      }
      return;
    }
    renderState(res);
    say(msg, '入れ替えました。キャスト・スタッフの画面にも反映されます。', true);
  }

  const ANSWER_LABEL = { yes: '出勤できます', no: '出勤できません', '': '未回答' };

  function deadlineLabel(deadline) {
    const [date, time] = deadline.split(' ');
    const [, m, d] = date.split('-').map(Number);
    return `${m}月${d}日 ${time}`;
  }

  // 出勤確認は、日付が違えば、複数同時に出せる。state.events の1件ぶんを「entry」と呼ぶ
  // （古いサーバーは events を返さないので、そのときは、event などの項目から1件ぶんを作る）
  function entriesOf(state) {
    if (!state) return [];
    if (Array.isArray(state.events)) return state.events;
    if (!state.event) return [];
    const { event, myAnswer, detail, placement, placementStatus, placementMessage } = state;
    return [{ event, myAnswer, detail, placement, placementStatus, placementMessage }];
  }

  // オーナー画面で、いま開いている出勤確認
  let selectedEventId = '';

  function selectedEntry() {
    const list = entriesOf(currentState);
    return list.find((x) => x.event.id === selectedEventId) || list[0] || null;
  }

  function eventChipLabel(e) {
    const [y, m, d] = e.date.split('-').map(Number);
    const dow = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    return `${m}月${d}日（${dow}）`;
  }

  function castEventBlock(entry) {
    const e = entry.event;
    const closed = e.phase === 'closed';
    const wrap = el('div', 'staff-event');
    wrap.dataset.eventId = e.id;
    const phaseLine = el('p');
    phaseLine.append(el('span', 'staff-badge' + (closed ? ' is-closed' : ''), closed ? '回答は締め切られました' : `回答受付中（${deadlineLabel(e.deadline)}まで）`));
    wrap.append(phaseLine, el('pre', 'staff-message-box', e.message));

    if (!(closed && !entry.myAnswer)) {
      const block = el('div');
      block.append(el('p', 'staff-ask', closed ? 'あなたの回答' : 'この日時に出勤できますか？'));
      const actions = el('div', 'staff-answer-actions');
      [['yes', '出勤できます'], ['no', '出勤できません']].forEach(([value, label]) => {
        const btn = el('button', `staff-answer is-${value}` + (entry.myAnswer === value ? ' is-selected' : ''), label);
        btn.type = 'button';
        btn.disabled = closed;
        btn.addEventListener('click', () => answer(value, e.id));
        actions.append(btn);
      });
      block.append(actions);
      wrap.append(block);
    }

    const info = [];
    if (closed) info.push('回答は締め切られました。変更・追加はオーナーに直接ご連絡ください。');
    else if (entry.myAnswer) info.push('回答を受け付けました。（締め切りまでは変更できます）');
    else info.push('締め切りまでに、どちらかを選んでください。');
    if (entry.myAnswer && !entry.placement) info.push('配置場所が出るまでお待ちください。');
    const infoNode = el('p', 'staff-info', info.join('\n'));
    infoNode.style.whiteSpace = 'pre-line';
    wrap.append(infoNode);
    return wrap;
  }

  function renderCast(state) {
    const list = entriesOf(state);
    $('castEmpty').hidden = list.length > 0;
    const events = $('castEvents');
    events.replaceChildren();
    list.forEach((entry) => events.append(castEventBlock(entry)));

    const placements = $('castPlacements');
    placements.replaceChildren();
    list.filter((entry) => entry.placement).forEach((entry) => {
      const card = el('div', 'staff-card');
      card.append(el('h2', 'staff-h2', list.length > 1 ? `店内配置（${eventChipLabel(entry.event)}）` : '店内配置'));
      const body = el('div');
      renderPlacement(body, entry.placement);
      card.append(body);
      placements.append(card);
    });
  }

  // 出勤確認を切り替えるボタン。2件以上あるときだけ出す
  function renderOwnerPickers(list) {
    ['ownerPickerStatus', 'ownerPickerPlacement'].forEach((id) => {
      const box = $(id);
      box.replaceChildren();
      box.hidden = list.length < 2;
      list.forEach((entry) => {
        const e = entry.event;
        const chip = el('button', 'staff-event-chip' + (e.id === selectedEventId ? ' is-active' : ''), eventChipLabel(e));
        chip.type = 'button';
        chip.setAttribute('role', 'tab');
        chip.setAttribute('aria-selected', e.id === selectedEventId ? 'true' : 'false');
        chip.append(el('small', '', e.phase === 'closed' ? '締め切り済み' : '回答受付中'));
        chip.addEventListener('click', () => {
          selectedEventId = e.id;
          $('reopenForm').hidden = true;
          say($('ownerMessageText'), '');
          say($('placementMessage'), '');
          renderOwner(currentState);
        });
        box.append(chip);
      });
    });
  }

  function renderOwner(state) {
    loadHistory(false);
    loadManage(false);
    const list = entriesOf(state);
    const entry = selectedEntry();
    const e = entry && entry.event;
    if (entry) selectedEventId = e.id;
    renderOwnerPickers(list);
    $('ownerEmpty').hidden = Boolean(e);
    $('ownerEvent').hidden = !e;
    $('ownerPlacementCard').hidden = !e;
    $('placementEmpty').hidden = Boolean(e);
    if (!e) return;

    const closed = e.phase === 'closed';
    const badge = $('ownerPhase');
    badge.textContent = closed ? '締め切り済み' : '回答受付中';
    badge.classList.toggle('is-closed', closed);
    $('ownerMessage').textContent = e.message;
    $('closeNowBtn').hidden = closed;
    $('reopenBtn').hidden = !closed;
    if (!closed) $('reopenForm').hidden = true;

    const c = entry.detail.counts;
    $('ownerCounts').textContent = `出勤できます ${c.yes}名 ／ 出勤できません ${c.no}名 ／ 未回答 ${c.none}名`;

    const body = $('ownerBody');
    body.replaceChildren();
    entry.detail.rows.forEach((r) => {
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
    $('assignBtn').textContent = entry.placement ? 'もう一度抽選する' : '配置を抽選する';
    renderPlacement($('ownerPlacement'), entry.placement, true);
    $('swapHint').hidden = !entry.placement;

    const status = entry.placementStatus;
    $('placementPreview').hidden = !entry.placement;
    if (entry.placement) {
      $('placementMessageBox').textContent = entry.placementMessage;
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
    if (me.role === 'owner') {
      if (!ownerTabReady) { ownerTabReady = true; restoreOwnerTab(); }
      renderOwner(state);
    } else {
      renderCast(state);
    }
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

  async function answer(value, eventId) {
    const msg = $('castMessageText');
    say(msg, '');
    const res = await api('answer', { answer: value, eventId });
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
    // 営業日が違えば、いまの出勤確認と並べて出せる。同じ営業日のものがあるときだけ、置き換わる
    const prevEntry = entriesOf(currentState).find((x) => x.event.date === pendingEvent.date);
    const prev = prevEntry && prevEntry.event;
    if (prev && !confirm(prev.phase === 'closed'
      ? '同じ営業日の出勤確認は履歴に保存され、新しい出勤確認に切り替わります。よろしいですか？'
      : '同じ営業日の出勤確認は、まだ締め切られていないため、取り消されて新しい内容に置き換わります。よろしいですか？')) return;
    const msg = $('eventFormMessage');
    const createdDate = pendingEvent.date;
    const res = await api('createEvent', pendingEvent);
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    hidePreview();
    $('eventNote').value = '';
    const created = entriesOf(res).find((x) => x.event.date === createdDate);
    if (created) selectedEventId = created.event.id; // 作った出勤確認を、すぐ開く
    renderState(res);
    loadHistory(true);
    activateOwnerTab('status', true);
    say($('ownerMessageText'), '確定しました。キャストの画面に表示されます。下の「文面をコピー」を押して、連絡にお使いください。', true);
    say(msg, '');
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
    const res = await api(action, { eventId: selectedEventId, ...payload });
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
      const name = el('td');
      const nameBtn = el('button', 'name-link', p.name);
      nameBtn.type = 'button';
      nameBtn.title = 'タップして、ログイン情報を作ってコピー';
      nameBtn.addEventListener('click', () => reissue(p.name));
      name.append(nameBtn, el('small', 'staff-user-role', ROLE_LABEL[p.role] || p.role));
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

  async function tryCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function reissue(name) {
    if (!confirm(`${name}さんの新しいパスワードを作って、送る文面をコピーします。\n今のパスワードは使えなくなります。よろしいですか？`)) return;
    say($('manageMessage'), '');
    const res = await api('reissue', { name });
    if (!res.ok) { if (!handleAuthError(res)) say($('manageMessage'), res.error); return; }
    addIssuedCard(res.credential);
    const copied = await tryCopy(credentialMessage(res.credential));
    say($('manageMessage'), copied
      ? `${name}さんのログイン情報をコピーしました。そのまま貼り付けて送れます。`
      : `${name}さんの新しいパスワードを作りました。上の枠の「まとめてコピー」を押してコピーしてください。`, true);
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
      const rl = el('p', 'staff-reserve-line', '予約のお客様：読み込み中…');
      rl.dataset.eventDate = e.date;
      item.append(rl);
      list.append(item);
    });
    if (reserveHistoryLoaded) fillEventReservations(false);
  }

  async function loadHistory(force) {
    if (!force && Date.now() - lastHistoryLoad < 30000) return;
    lastHistoryLoad = Date.now();
    loadReservationHistory();
    const res = await api('history', { limit: Number($('historyRange').value) });
    if (!res.ok) {
      if (!handleAuthError(res)) say($('historyMessage'), res.error);
      return;
    }
    say($('historyMessage'), '');
    renderHistory(res);
  }

  /* Reservation history & customer stats (owner) */

  let reserveDays = {};
  let reserveHistoryLoaded = false;

  const ordinalLabel = (n) => (n === 1 ? '初めて' : `${n}回目`);

  function reserveLine(day) {
    if (!day) return '予約のお客様：なし';
    const names = day.reservations.map((r) => (r.cancelled ? `${r.name}（キャンセル）` : `${r.name}（${ordinalLabel(r.ordinal)}）`));
    return `予約のお客様（${day.guests}名）：${names.join('、')}`;
  }

  function fillEventReservations(failed) {
    document.querySelectorAll('[data-event-date]').forEach((p) => {
      p.textContent = failed ? '予約のお客様：読み込めませんでした' : reserveLine(reserveDays[p.dataset.eventDate]);
    });
  }

  const slashDate = (d) => (d ? d.split('-').map(Number).join('/') : '—');

  function renderReservationHistory(res) {
    reserveDays = {};
    res.days.forEach((d) => { if (d.date) reserveDays[d.date] = d; });
    fillEventReservations(false);

    const empty = res.days.length === 0;
    $('rhEmpty').hidden = !empty;
    $('rhBody').hidden = empty;
    if (empty) return;
    const s = res.stats;
    const pct = s.customers ? Math.round((s.repeaters / s.customers) * 1000) / 10 : 0;
    $('rhSummary').textContent = `予約のお客様 ${s.customers}人 ／ 2回以上の方 ${s.repeaters}人（${pct}%） ／ 営業日 ${s.businessDays}回`;

    const days = $('rhDays');
    days.replaceChildren();
    res.days.forEach((d) => {
      const item = el('details', 'staff-history-item');
      item.append(el('summary', '', `${d.date ? dateJa(d.date) : '日付が未設定の予約'} ／ 予約 ${d.reservations.length - d.cancelledCount}件・${d.guests}名` + (d.cancelledCount ? `（キャンセル ${d.cancelledCount}件）` : '')));
      d.reservations.forEach((r) => {
        const line = el('p', r.cancelled ? 'staff-reserve-cancelled' : '', r.cancelled ? `${r.name}（キャンセル）` : `${r.name}　${r.guests}名　${ordinalLabel(r.ordinal)}`);
        item.append(line);
      });
      days.append(item);
    });

    const body = $('rhCustomers');
    body.replaceChildren();
    res.customers.forEach((c) => {
      const tr = el('tr');
      tr.append(el('td', '', c.name), el('td', 'staff-rate', `${c.visits}回`), el('td', '', slashDate(c.firstDate)), el('td', '', slashDate(c.lastDate)), el('td', c.visits >= 2 ? 'staff-mark-ok' : '', c.visits >= 2 ? 'リピーター' : '初めて'));
      body.append(tr);
    });
  }

  async function loadReservationHistory() {
    const res = await api('reservationHistory');
    if (!res.ok) {
      if (!handleAuthError(res)) { say($('rhMessage'), res.error); fillEventReservations(true); }
      return;
    }
    say($('rhMessage'), '');
    reserveHistoryLoaded = true;
    renderReservationHistory(res);
  }

  /* VIP seat lottery (owner) */

  let vipData = null;
  let vipAdjustKey = '';
  let lastVipLoad = 0;

  const ATTEND_LABEL = { ok: '出勤', ng: '欠勤', unknown: '出勤確認なし' };

  // 当選した人に送る文面。指名の聞き取り前／指名あり／指名なし／持ち越し、で内容が変わる
  function vipWinnerMessage(w) {
    const d = vipData && vipData.date ? dateJa(vipData.date) : '次回';
    const name = w.name;
    if (w.carry) {
      return [
        `${name}さん`, '',
        `BunnyCafe EXTA ${d}の営業で、VIP席にご当選されました！`,
        `ご指名の「${w.nominee}」さんが、当日は出勤できないため、VIP席へのご案内は、次回の営業に持ち越しとさせてください。`,
        '次回のご予約をいただければ、抽選なしで、VIP席にご案内いたします。',
        '', '申し訳ございません。次回のご来店を、お待ちしております。'
      ].join('\n');
    }
    const lines = [`${name}さん`, ''];
    if (w.type === 'carry') {
      lines.push(`前回からの持ち越しで、BunnyCafe EXTA ${d}の営業は、VIP席にご案内いたします！`);
    } else {
      lines.push(`BunnyCafe EXTA ${d}の営業で、VIP席にご当選されました！`);
    }
    if (w.choice === 'cast') {
      lines.push(`ご指名は「${w.nominee}」さんで、承りました。`);
    } else if (w.choice === 'none') {
      lines.push('ご指名は、なしで承りました（当日、お好きなキャストをお選びいただくことも可能です）。');
    } else {
      lines.push(
        'VIP席では、お好きなキャストを1名、ご指名いただけます（1:1の接客です。40分・2ローテーション分のご指名も可能です）。',
        '', 'ご指名の「あり」「なし」と、ご指名のキャストを、このDMでお知らせください。',
        '※ご指名のキャストが、当日出勤していない場合は、VIP席へのご案内は、次回の営業に持ち越しとなります。'
      );
    }
    lines.push('', '当日のご来店を、お待ちしております。');
    return lines.join('\n');
  }

  function fillVipNominate(res) {
    const w = res.winner;
    const select = $('vipCastSelect');
    select.replaceChildren();
    res.cast.forEach((c) => {
      const o = el('option', '', `${c.name}（${ATTEND_LABEL[c.attend] || ''}）`);
      o.value = c.name;
      select.append(o);
    });
    const radios = document.querySelectorAll('input[name="vipChoice"]');
    radios.forEach((r) => { r.checked = (w.choice === 'cast' ? 'cast' : (w.choice === 'none' ? 'none' : '')) === r.value; });
    if (w.choice === 'cast' && w.nominee) select.value = w.nominee;
    select.disabled = !(w.choice === 'cast');

    $('vipAttendNote').textContent = res.attendState === 'none'
      ? 'その営業日の出勤確認が、まだありません。出勤しているかどうかは、自動では分かりません（必要なときは、下のボタンで、手で持ち越しにできます）。'
      : (res.attendState === 'open'
        ? 'その営業日の出勤確認は、まだ締め切られていません。締め切ったあとに、もう一度「保存」を押すと、持ち越しが自動で決まります。'
        : 'カッコの中は、その営業日の出勤確認の結果です。欠勤のキャストを指名したときは、次回の営業に持ち越しになります。');

    const result = $('vipNomResult');
    let text = '';
    if (w.carry) text = `指名：${w.nominee}さん ― 当日は出勤しないため、今回のVIPは「なし」です。次回の営業に持ち越します（次回の営業で、この人が予約していれば、抽選せずにVIPになります）。`;
    else if (w.choice === 'cast') text = `指名：${w.nominee}さん` + (w.type === 'carry' ? '（前回からの持ち越し。変えるときは、選び直して「保存」）' : '');
    else if (w.choice === 'none') text = '指名なし';
    result.textContent = text;
    result.hidden = !text;

    const note = $('vipWinnerNote');
    note.textContent = w.type === 'carry' ? `${w.carryFrom ? dateJa(w.carryFrom) : '前回'}の当選からの、持ち越しです。` : '';
    note.hidden = !note.textContent;

    const showCarry = w.choice === 'cast' && w.type === 'win';
    $('vipCarryRow').hidden = !showCarry;
    $('vipCarryOn').hidden = w.carry;
    $('vipCarryOff').hidden = !w.carry;
  }

  function renderVip(res) {
    vipData = res;
    $('vipMinVisits').textContent = res.minVisits;
    const w = res.weights || [];
    const dateText = res.date ? dateJa(res.date) : '営業日が未設定';
    const offer = res.carryOffer;
    $('vipSummary').textContent = `対象の営業日：${dateText} ／ 予約のお客様 ${res.candidates.length}人 ／ `
      + (res.winner ? `抽選済み（当選：${res.winner.name}${res.winner.carry ? '・次回へ持ち越し' : ''}）` : (offer ? `持ち越しのVIP：${offer.name}さん` : `抽選の対象 ${res.eligibleCount}人`))
      + (w.length && !offer && !res.winner ? `（重み：当選0回=${w[0]}、1回=${w[1]}、2回以上=${w[w.length - 1]}）` : '')
      + (!res.winner && !offer && res.eligibleCount === 0 && res.candidates.length ? ' ／ 対象の人がいないため、今回は「VIPなし」です' : '');

    const box = $('vipWinnerBox');
    box.hidden = !res.winner;
    $('vipDrawRow').hidden = Boolean(res.winner);
    $('vipCopyText').hidden = true;
    if (res.winner) {
      $('vipWinnerName').textContent = res.winner.name;
      fillVipNominate(res);
    }
    const banner = $('vipCarryBanner');
    let bannerText = '';
    if (!res.winner && offer) {
      bannerText = `前回（${dateJa(offer.from)}）の当選者「${offer.name}」さんは、指名した「${offer.nominee}」さんが出勤しなかったため、今回に持ち越しです。抽選はせず、この人がVIPになります。`;
    } else if (!res.winner && res.carryLapsed) {
      const l = res.carryLapsed;
      bannerText = `前回（${dateJa(l.from)}）の持ち越し（${l.name}さん・指名：${l.nominee}さん）は、今回の予約がないため、終了しました（持ち越しは1回だけです）。今回は、通常どおり抽選します。`;
    }
    banner.textContent = bannerText;
    banner.hidden = !bannerText;
    $('vipDraw').textContent = offer ? `持ち越しのVIPを確定する（${offer.name}さん）` : '抽選する';
    $('vipDraw').disabled = !offer && res.eligibleCount === 0;

    const empty = res.candidates.length === 0;
    $('vipEmpty').hidden = !empty;
    $('vipTable').hidden = empty;
    const body = $('vipBody');
    body.replaceChildren();
    res.candidates.forEach((c) => {
      const tr = el('tr');
      const visitText = `${c.visits}回目` + (c.visitAdjust ? `（手直し ${c.visitAdjust > 0 ? '+' : ''}${c.visitAdjust}）` : '');
      const winText = `${c.wins}回` + (c.winAdjust ? `（手直し ${c.winAdjust > 0 ? '+' : ''}${c.winAdjust}）` : '');
      const state = c.isWinner ? c.reason : (c.eligible ? '対象' : c.reason);
      const stateCls = c.isWinner || c.isCarry || c.eligible ? 'staff-mark-ok' : 'staff-muted';
      const btn = el('button', 'btn btn-outline', '手直し');
      btn.type = 'button';
      btn.addEventListener('click', () => openVipAdjust(c));
      const act = el('td');
      act.append(btn);
      tr.append(el('td', '', c.name), el('td', '', visitText), el('td', '', winText), el('td', stateCls, state), el('td', 'staff-rate', c.eligible ? `${c.percent}%` : '—'), act);
      body.append(tr);
    });

    const hist = $('vipHistory');
    hist.replaceChildren();
    $('vipHistoryEmpty').hidden = res.history.length > 0;
    res.history.forEach((h) => hist.append(el('p', '', `${h.date ? dateJa(h.date) : '日付なし'}　${h.name}` + (h.note ? `（${h.note}）` : ''))));
    if (vipAdjustKey && !res.candidates.some((c) => c.key === vipAdjustKey)) closeVipAdjust();
  }

  async function loadVip(force) {
    if (!force && Date.now() - lastVipLoad < 10000) return;
    lastVipLoad = Date.now();
    const res = await api('vip');
    if (!res.ok) {
      lastVipLoad = 0;
      if (!handleAuthError(res)) say($('vipMessage'), res.error);
      return;
    }
    say($('vipMessage'), '');
    renderVip(res);
  }

  async function vipCall(action, params, doneText) {
    const msg = $('vipMessage');
    say(msg, '');
    const res = await api(action, params || {});
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return null; }
    lastVipLoad = Date.now();
    renderVip(res);
    if (doneText) say(msg, typeof doneText === 'function' ? doneText(res) : doneText, true);
    return res;
  }

  function vipDraw() {
    const offer = vipData && vipData.carryOffer;
    if (!offer && vipData && vipData.eligibleCount === 0) return;
    if (!confirm(offer
      ? `前回からの持ち越しで、「${offer.name}」さんを、今回のVIPにします（抽選はしません）。よろしいですか？`
      : `抽選の対象 ${vipData ? vipData.eligibleCount : 0}人から、1人を引きます。よろしいですか？`)) return;
    vipCall('vipDraw', {}, (res) => (res.none
      ? '抽選の対象の人がいないので、今回は「VIPなし」です（何も記録していません）。'
      : (res.winner.type === 'carry'
        ? `持ち越しのVIPを確定しました（${res.winner.name}さん）。指名のキャストが、今回出勤しているか、下の「指名の確認」で確かめてください。`
        : `抽選しました。当選は「${res.winner.name}」さんです。連絡して、「指名するか、しないか」を聞いてください。`)));
  }

  function vipNominate(e) {
    e.preventDefault();
    const choice = (document.querySelector('input[name="vipChoice"]:checked') || {}).value;
    if (!choice) { say($('vipMessage'), '「指名しない」か「指名する」を選んでください。'); return; }
    const cast = $('vipCastSelect').value;
    if (choice === 'cast' && !cast) { say($('vipMessage'), '指名するキャストを選んでください。'); return; }
    vipCall('vipNominate', choice === 'cast' ? { mode: 'cast', cast } : { mode: 'none' }, (res) => {
      const w = res.winner;
      if (w.carry) return `「${w.nominee}」さんは、その日出勤しないため、次回の営業に持ち越しにしました。当選した人に、連絡してください。`;
      return w.choice === 'cast' ? `指名「${w.nominee}」さんで、記録しました。` : '「指名なし」で、記録しました。';
    });
  }

  function vipSetCarry(carry) {
    const w = vipData && vipData.winner;
    if (!w || !w.nominee) return;
    const ask = carry
      ? `「${w.nominee}」さんが出勤しないことにして、今回のVIPはなし、次回の営業に持ち越します。よろしいですか？`
      : '持ち越しをやめて、今回のVIPにします。よろしいですか？';
    if (!confirm(ask)) return;
    vipCall('vipNominate', { mode: 'cast', cast: w.nominee, carry }, carry ? '次回の営業に持ち越しにしました。' : '持ち越しをやめて、今回のVIPにしました。');
  }

  function vipUndo(mode) {
    const name = vipData && vipData.winner ? vipData.winner.name : '';
    const ask = mode === 'void'
      ? `「${name}」さんの当選を取り消して、記録を消します（今回の抽選の対象には戻ります）。よろしいですか？`
      : `「${name}」さんが辞退されたことにして、引き直せる状態にします（この人は今回の対象から外れ、当選の回数にも数えません）。よろしいですか？`;
    if (!confirm(ask)) return;
    vipCall('vipUndo', { mode }, mode === 'void' ? '当選を取り消しました。もう一度、抽選できます。' : '辞退として記録しました。「抽選する」で、引き直せます。');
  }

  function openVipAdjust(c) {
    vipAdjustKey = c.key;
    $('vipAdjustTitle').textContent = `回数の手直し：${c.name}さん`;
    $('vipAdjustInfo').textContent = `いまの来店回数は ${c.visits}回目（予約から数えた ${c.visitBase}回 ＋ 手直し ${c.visitAdjust}）、VIP当選は ${c.wins}回（記録 ${c.winBase}回 ＋ 手直し ${c.winAdjust}）です。数字は、予約から数えた回数との「差」を入れます（例：あと1回多く数えたいときは +1）。`;
    $('vipAdjVisit').value = c.visitAdjust;
    $('vipAdjWin').value = c.winAdjust;
    $('vipAdjustForm').hidden = false;
    $('vipAdjustForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function closeVipAdjust() {
    vipAdjustKey = '';
    $('vipAdjustForm').hidden = true;
  }

  async function saveVipAdjust(e) {
    e.preventDefault();
    const c = vipData && vipData.candidates.find((x) => x.key === vipAdjustKey);
    if (!c) { closeVipAdjust(); return; }
    const res = await vipCall('vipAdjust', { key: c.key, name: c.name, visitAdjust: Number($('vipAdjVisit').value), winAdjust: Number($('vipAdjWin').value) }, `「${c.name}」さんの回数を手直ししました。`);
    if (res) closeVipAdjust();
  }

  async function copyVipMessage() {
    if (!vipData || !vipData.winner) return;
    const box = $('vipCopyText');
    box.textContent = vipWinnerMessage(vipData.winner);
    box.hidden = false;
    await copyText('vipCopyText', 'vipMessage');
  }

  /* Public site "Coming Soon" switch (owner) */

  function showMaintenance(on) {
    $('maintStatus').textContent = on
      ? '今は、お客様の画面が「Coming Soon」になっています（ホームページは、お休み中です）。'
      : '今は、ホームページを公開しています。';
    $('maintOn').hidden = on;
    $('maintOff').hidden = !on;
  }

  async function loadMaintenance() {
    const res = await api('getMaintenance');
    if (!res.ok) { if (!handleAuthError(res)) say($('maintMessage'), res.error); return; }
    showMaintenance(res.on);
  }

  async function setMaintenance(on) {
    if (!confirm(on
      ? 'お客様の画面を「Coming Soon」に切り替えます。ホームページは、見られなくなります。よろしいですか？'
      : 'ホームページの公開を再開します。お客様の画面が、元のホームページに戻ります。よろしいですか？')) return;
    const msg = $('maintMessage');
    say(msg, '');
    const res = await api('setMaintenance', { on });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    showMaintenance(res.on);
    say(msg, res.on ? '「Coming Soon」に切り替えました。数十秒ほどで、お客様の画面に反映されます。' : '公開を再開しました。数十秒ほどで、お客様の画面に反映されます。', true);
  }

  /* Next open day shown on the public site (owner) */

  function showNextOpen(next) {
    const cur = $('nextOpenCurrent');
    if (!next) { cur.textContent = '今は、ホームページに「Coming Soon」と表示されています。'; return; }
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
    cur.textContent = next.date < today
      ? `設定中：${dateJa(next.date)}（日付が過ぎたため、ホームページには「Coming Soon」と表示されています）`
      : `表示中：${dateJa(next.date)} ${next.startTime}〜${next.endTime}`;
    $('nextOpenDate').value = next.date >= today ? next.date : '';
    $('nextOpenStart').value = next.startTime;
    $('nextOpenEnd').value = next.endTime;
  }

  async function loadNextOpen() {
    const res = await api('getNextOpen');
    if (!res.ok) { if (!handleAuthError(res)) say($('nextOpenMessage'), res.error); return; }
    showNextOpen(res.next);
  }

  async function saveNextOpen(e) {
    e.preventDefault();
    const msg = $('nextOpenMessage');
    say(msg, '');
    const res = await api('setNextOpen', { date: $('nextOpenDate').value, startTime: $('nextOpenStart').value, endTime: $('nextOpenEnd').value });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    showNextOpen(res.next);
    say(msg, 'ホームページに表示しました（反映まで、数十秒かかることがあります）。', true);
  }

  async function clearNextOpen() {
    if (!confirm('ホームページの「次回営業日」を、「Coming Soon」に戻します。よろしいですか？')) return;
    const msg = $('nextOpenMessage');
    say(msg, '');
    const res = await api('clearNextOpen');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    showNextOpen(null);
    say(msg, '「Coming Soon」に戻しました。', true);
  }

  /* Reservations (owner) */

  let lastReservationLoad = 0;

  // 値が URL だけのときは、タップして開けるリンクにする（http / https のみ）
  function reservationValue(text) {
    const dd = el('dd');
    const t = text.trim();
    if (/^https?:\/\/\S+$/.test(t)) {
      const a = el('a', '', t);
      a.href = t;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      dd.append(a);
    } else {
      dd.textContent = t;
    }
    return dd;
  }

  let lastLimit = null;
  let lastNext = null;

  function renderLimit(l) {
    const s = $('limitStatus');
    if (l.full) s.textContent = `満席：${l.used}名 ／ 上限${l.cap}名。フォームの受付を終了しました。`;
    else if (l.cap === 0) s.textContent = `受付中：現在 ${l.used}名（上限なし）`;
    else s.textContent = `受付中：現在 ${l.used}名 ／ 上限${l.cap}名（あと${l.cap - l.used}名）`;
    const notes = [];
    if (l.error) notes.push(l.error);
    else if (l.accepting === false && !l.full) notes.push(l.cap > 0 ? `空きが出ています（あと${l.cap - l.used}名）。再募集するときは、下の「受付を再開する」を押してください。` : 'フォームは、今、受付を止めています。');
    $('limitWarn').textContent = notes.join(' ');
    $('limitCap').value = l.cap;
    lastLimit = l;
    $('limitRecruit').hidden = false;
    $('limitReopen').hidden = !(l.accepting === false && !l.full);
  }

  async function saveLimit(e) {
    e.preventDefault();
    const msg = $('limitMessage');
    say(msg, '');
    const res = await api('setReservationCap', { cap: $('limitCap').value });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderLimit(res.limit);
    say(msg, '上限を保存しました。', true);
    loadReservations(true);
  }

  async function resetLimit() {
    if (!confirm('これまでの予約を、人数に数えなくして、受付を再開します（一覧には残ります）。新しい営業日の予約を始めるときに、押してください。よろしいですか？')) return;
    const msg = $('limitMessage');
    say(msg, '');
    const res = await api('resetReservationCount');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderLimit(res.limit);
    say(msg, '人数を0に戻して、受付を再開しました。', true);
    loadReservations(true);
  }

  function renderReservations(res) {
    lastNext = res.next || null;
    if (res.limit) renderLimit(res.limit);
    const list = $('reservationList');
    list.replaceChildren();
    const any = res.rows.length > 0;
    $('reservationEmpty').hidden = any;
    const summary = $('reservationSummary');
    summary.hidden = !any;
    if (!any) return;
    summary.textContent = `予約 ${res.total}件 ／ 合計 ${res.guests}名` + (res.cancelledCount ? `（キャンセル ${res.cancelledCount}件は除く）` : '');

    const heads = res.headers;
    const nameIdx = heads.findIndex((h) => /お名前|名前/.test(h));
    const guestIdx = heads.findIndex((h) => /何名|人数/.test(h));
    res.rows.forEach((r) => {
      const item = el('details', `staff-history-item staff-reserve-item${r.cancelled ? ' is-cancelled' : ''}`);
      const name = nameIdx >= 0 && r.values[nameIdx].trim() ? r.values[nameIdx].trim() : '（お名前なし）';
      const guests = guestIdx >= 0 && r.values[guestIdx].trim() ? ` ・ ${r.values[guestIdx].trim()}名` : '';
      const badge = !r.cancelled && r.ordinal ? ` ・ ${ordinalLabel(r.ordinal)}` : '';
      const summ = el('summary', '', `${r.cancelled ? '【キャンセル】' : ''}${name}${guests}${badge}`);
      let note = '';
      if (r.cancelled) note = '　（人数に数えていません）';
      else if (r.counted === false) note = '　（前回分・人数に数えていません）';
      summ.append(el('span', 'staff-reserve-sub', `　${r.values[0]}${note}`));
      item.append(summ);
      const dl = el('dl');
      heads.forEach((h, i) => {
        if (i === 0 || i === nameIdx || !r.values[i].trim()) return;
        const box = el('div');
        box.append(el('dt', '', h), reservationValue(r.values[i]));
        dl.append(box);
      });
      item.append(dl);
      const actions = el('div', 'staff-preview-actions staff-reserve-actions');
      if (!r.cancelled) {
        const doneBtn = el('button', 'btn btn-outline', '完了のお知らせをコピー');
        doneBtn.type = 'button';
        doneBtn.addEventListener('click', () => copyDoneMessage(r, name));
        actions.append(doneBtn);
      }
      const cancelBtn = el('button', r.cancelled ? 'btn btn-outline' : 'staff-delete', r.cancelled ? 'キャンセルを取り消す' : 'キャンセルにする');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => cancelReservation(r, name));
      actions.append(cancelBtn);
      item.append(actions);
      list.append(item);
    });
  }

  // 予約が完了したお客様に送る文面。営業日は、その予約が入った営業日（なければ、設定中の次回営業日）
  function doneMessage(r, name) {
    const date = r.date || (lastNext ? lastNext.date : '');
    let when = '次回営業日';
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      const dow = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
      when = `${m}月${d}日（${dow}）`;
    }
    const start = lastNext && lastNext.date === date ? lastNext.startTime : '';
    return [
      `${name}様`,
      '',
      '-----ご予約完了のお知らせ-----',
      '受付フォームよりご来店ご予約をいただきありがとうございます。',
      start ? `つきましては${when}の${start}～からの営業となります。` : `つきましては${when}の営業となります。`,
      '',
      '事前ご予約のお客様は事前にオーナー',
      '【Tetra_POD】へフレンド申請をお願いいたします。',
      'https://vrchat.com/home/user/usr_ef5b5658-bf5c-4e27-90d6-d3a45ebc3011',
      '',
      'フレンド承認後、当日21:40頃に待機所に招待いたしますので、スタッフと一緒に入っていただきます。',
      '',
      '当日までにご来店が難しくなってしまった場合には、こちらのDMにてご連絡いただければと思いますので',
      'どうぞよろしくお願いいたします。'
    ].join('\n');
  }

  async function copyDoneMessage(r, name) {
    const msg = $('reservationMessage');
    try {
      await navigator.clipboard.writeText(doneMessage(r, name));
      say(msg, `${name}さん宛ての「ご予約完了のお知らせ」をコピーしました。DMなどに貼って、送ってください。`, true);
    } catch (e) {
      say(msg, 'コピーできませんでした。');
    }
  }

  async function cancelReservation(r, name) {
    const cancelling = !r.cancelled;
    if (!confirm(cancelling
      ? `${name}さんの予約を、キャンセルにします。その人数は、空きになります（受付は、自動では再開しません）。よろしいですか？`
      : `${name}さんのキャンセルを取り消して、予約に戻します。人数が、上限を超えることがあります。よろしいですか？`)) return;
    const msg = $('reservationMessage');
    say(msg, '');
    const res = await api('cancelReservation', { key: r.key, cancelled: cancelling });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderLimit(res.limit);
    await loadReservations(true);
    say(msg, cancelling
      ? `キャンセルにしました。再募集するときは、上の「受付の人数制限」の「受付を再開する」を押してください。`
      : 'キャンセルを取り消しました。', true);
  }

  async function reopenReservation() {
    const msg = $('limitMessage');
    say(msg, '');
    const res = await api('reopenReservation');
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderLimit(res.limit);
    say(msg, '受付を再開しました。公開サイトの予約ボタンも、受付中に戻ります。下の「再募集の文面をコピー」で、お知らせを出せます。', true);
    loadReservations(true);
  }

  function recruitMessage() {
    const l = lastLimit;
    const lines = ['【BunnyCafe EXTA】来店予約の再募集', 'キャンセルが出たため、来店予約を再募集します。'];
    if (lastNext) lines.push('', `次回営業日：${dateJa(lastNext.date)} ${lastNext.startTime}〜${lastNext.endTime}`);
    if (l && l.cap > 0) lines.push(`残り：あと${Math.max(0, l.cap - l.used)}名`);
    lines.push('', '▼ご予約はこちら', 'https://bunnycafe-exta.github.io/vrc-event/#reservation', '', '定員になり次第、受付を終了します。');
    return lines.join('\n');
  }

  async function copyRecruit() {
    const box = $('limitRecruitText');
    box.textContent = recruitMessage();
    box.hidden = false;
    await copyText('limitRecruitText', 'limitMessage');
  }

  async function loadReservations(force) {
    if (!force && Date.now() - lastReservationLoad < 10000) return;
    lastReservationLoad = Date.now();
    const res = await api('reservations');
    if (!res.ok) {
      lastReservationLoad = 0;
      if (!handleAuthError(res)) say($('reservationMessage'), res.error);
      return;
    }
    say($('reservationMessage'), '');
    renderReservations(res);
  }

  function setFinal(name, value) {
    return ownerAction('setFinal', { name, final: value });
  }

  async function assign() {
    const msg = $('placementMessage');
    say(msg, '');
    const entry = selectedEntry();
    if (entry && entry.placementStatus === 'published' &&
      !confirm('確定済みの配置を取り消して、抽選し直します。キャストの画面からは、確定するまで配置が消えます。よろしいですか？')) return;
    const res = await api('assign', { eventId: selectedEventId });
    if (!res.ok) { if (!handleAuthError(res)) say(msg, res.error); return; }
    renderState(res);
    say(msg, '配置を抽選しました。内容を確認して、よければ下の「確定」を押してください。', true);
  }

  async function publishPlacement() {
    const msg = $('placementMessage');
    say(msg, '');
    const res = await api('publishPlacement', { eventId: selectedEventId });
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

    $('eventForm').addEventListener('submit', previewEvent);
    $('eventForm').addEventListener('input', hidePreview);
    $('eventEdit').addEventListener('click', hidePreview);
    $('eventConfirm').addEventListener('click', confirmEvent);
    $('eventCopy').addEventListener('click', () => copyText('previewMessage', 'eventFormMessage'));
    $('ownerCopy').addEventListener('click', () => copyText('ownerMessage', 'ownerMessageText'));
    $('closeNowBtn').addEventListener('click', () => {
      if (confirm('今すぐ回答を締め切ります。以降、キャストは回答できなくなります。よろしいですか？')) ownerAction('closeNow', {}, '締め切りました。');
    });
    $('reopenBtn').addEventListener('click', () => { $('reopenForm').hidden = !$('reopenForm').hidden; });
    $('reopenCancel').addEventListener('click', () => { $('reopenForm').hidden = true; });
    $('reopenForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm('もう一度、回答を受け付けます。配置の抽選結果は取り消されます。よろしいですか？')) return;
      await ownerAction('reopen', { deadline: $('reopenDeadline').value }, '再募集を始めました。キャスト・スタッフが、新しい締め切りまで回答できます。上の文面をコピーして連絡してください。');
      const entry = selectedEntry();
      if (entry && entry.event.phase === 'open') $('reopenForm').hidden = true;
    });
    $('cancelEventBtn').addEventListener('click', () => {
      if (confirm('この出勤確認を取り消します。キャストの回答も見えなくなります。よろしいですか？')) ownerAction('cancelEvent', {}, '取り消しました。');
    });
    $('assignBtn').addEventListener('click', assign);
    $('publishBtn').addEventListener('click', publishPlacement);
    $('ownerTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.staff-tab');
      if (tab) activateOwnerTab(tab.dataset.tab, true);
    });
    $('goCreate').addEventListener('click', () => activateOwnerTab('create', true));
    $('historyRange').addEventListener('change', () => loadHistory(true));
    $('reservationReload').addEventListener('click', () => loadReservations(true));
    $('vipReload').addEventListener('click', () => loadVip(true));
    $('vipDraw').addEventListener('click', vipDraw);
    $('vipDecline').addEventListener('click', () => vipUndo('declined'));
    $('vipVoid').addEventListener('click', () => vipUndo('void'));
    $('vipCopy').addEventListener('click', copyVipMessage);
    $('vipNominateForm').addEventListener('submit', vipNominate);
    $('vipNominateForm').addEventListener('change', (e) => { if (e.target.name === 'vipChoice') $('vipCastSelect').disabled = e.target.value !== 'cast'; });
    $('vipCarryOn').addEventListener('click', () => vipSetCarry(true));
    $('vipCarryOff').addEventListener('click', () => vipSetCarry(false));
    $('vipAdjustForm').addEventListener('submit', saveVipAdjust);
    $('vipAdjCancel').addEventListener('click', closeVipAdjust);
    $('maintOn').addEventListener('click', () => setMaintenance(true));
    $('maintOff').addEventListener('click', () => setMaintenance(false));
    $('limitForm').addEventListener('submit', saveLimit);
    $('limitReset').addEventListener('click', resetLimit);
    $('limitReopen').addEventListener('click', reopenReservation);
    $('limitRecruitCopy').addEventListener('click', copyRecruit);
    $('nextOpenForm').addEventListener('submit', saveNextOpen);
    $('nextOpenClear').addEventListener('click', clearNextOpen);
    $('addStaffForm').addEventListener('submit', addStaff);
    $('placementCopy').addEventListener('click', () => copyText('placementMessageBox', 'placementMessage'));

    window.setInterval(() => {
      if (!appView.hidden && document.visibilityState === 'visible') loadState(true);
    }, POLL_MS);

    // Lock the answer buttons as soon as the deadline passes, even if the page was left open
    window.setInterval(() => {
      const expired = entriesOf(currentState).some((x) => x.event.phase === 'open' && jstNowMinute() >= x.event.deadline);
      if (!appView.hidden && expired) loadState(true);
    }, 5000);

    if (getToken() && await loadState()) showView('app');
    else showView('login');
  }

  init();
})();
