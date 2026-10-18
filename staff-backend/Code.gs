/**
 * EXTA スタッフ出勤確認システム（Google Apps Script / スプレッドシート連携）
 *
 * セットアップ:
 *  1. 新しいGoogleスプレッドシートを作成 → 拡張機能 → Apps Script を開き、このコードを貼り付けて保存
 *  2. 関数「setup」を1回だけ実行（権限の承認が必要）。シートが作られ、「配布用」シートに各自のID/パスワードが出力される
 *  3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」→ 実行ユーザー「自分」/ アクセス「全員」→ デプロイ
 *  4. 表示されたウェブアプリURLを js/staff.js の API_URL に設定
 *  5. 「配布用」シートの内容を各スタッフへ個別に伝え、伝え終わったらシートを削除
 *
 * コードを更新したとき: 「setup」を再実行（足りないシートだけ追加される）→
 *   デプロイ → デプロイを管理 → 鉛筆アイコン → バージョン「新バージョン」→ デプロイ（URLは変わらない）
 * スタッフ追加・パスワード再発行・無効化: オーナー画面の「スタッフ管理」からできる
 *   （画面を使わない場合は、下の TARGETS に名前と役割を書いて「issueCredentials」を実行）
 *   役割: cast=キャスト（①〜⑥の配置） / staff=スタッフ（①～③サイド・④～⑥サイド） / owner=オーナー（配置の対象外）
 */

// スプレッドシートに紐づけず script.google.com で単独のプロジェクトとして作る場合のみ、
// スプレッドシートのURLの /d/ と /edit の間の文字列をここに入れる（紐づけて作る場合は空のまま）
const SPREADSHEET_ID = '';

const STAFF_PAGE_URL = 'https://bunnycafe-exta.github.io/vrc-event/staff.html';

const TZ = 'Asia/Tokyo';
const SESSION_SECONDS = 21600; // ログインの有効時間（6時間）
const MAX_FAILS = 5;           // ログイン失敗の許容回数
const LOCK_SECONDS = 600;      // 超えた場合のロック時間（10分）
const POSITIONS_PER_ROTATION = 6; // 1ローテーションの人数（店内番号1〜12を2つずつ担当）

const STAFF_LIST = [
  { name: 'てとら', role: 'owner' },
  { name: 'ぷにねこ', role: 'cast' },
  { name: 'メガスターミー', role: 'cast' },
  { name: 'はやしすん', role: 'cast' },
  { name: 'オロシ', role: 'cast' },
  { name: 'とらまる', role: 'cast' },
  { name: 'ユトロス', role: 'cast' },
  { name: 'しえる', role: 'cast' },
  { name: 'ムレン', role: 'cast' },
  { name: 'あかきのこ', role: 'cast' },
  { name: 'はるるん', role: 'cast' }
];

// issueCredentials の対象（例: { name: 'ひなた', role: 'staff' },）。
// すでに登録済みの名前は、{ name: '…', role: '…', reissue: true } としたときだけパスワードを再発行する
const TARGETS = [
];

const SHEETS = {
  Staff: ['id', 'name', 'role', 'salt', 'hash', 'active', 'joinedAt'],
  Events: ['eventId', 'date', 'startTime', 'endTime', 'deadline', 'note', 'status', 'createdAt'],
  Responses: ['eventId', 'staffId', 'name', 'answer', 'final', 'updatedAt'],
  Placements: ['date', 'rotation', 'position', 'name', 'createdAt']
};

class AppError extends Error {}

/* ---------- Web app entry ---------- */

function doGet() {
  return json_({ ok: true, service: 'EXTA staff API', version: 12 });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '不正なリクエストです' });
  }
  try {
    return json_(route_(req));
  } catch (err) {
    if (err instanceof AppError) return json_({ ok: false, error: err.message });
    console.error(err);
    return json_({ ok: false, error: 'サーバーエラーが発生しました' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(message) {
  throw new AppError(message);
}

function route_(req) {
  const action = String(req.action || '');
  if (action === 'login') return login_(req);

  const user = requireSession_(req.token);
  switch (action) {
    case 'state': return state_(user);
    case 'answer': return withLock_(() => answer_(user, req));
    case 'previewEvent': requireOwner_(user); return previewEvent_(req);
    case 'createEvent': requireOwner_(user); return withLock_(() => createEvent_(user, req));
    case 'closeNow': requireOwner_(user); return withLock_(() => closeNow_(user));
    case 'cancelEvent': requireOwner_(user); return withLock_(() => cancelEvent_(user));
    case 'reopen': requireOwner_(user); return withLock_(() => reopen_(user, req));
    case 'setFinal': requireOwner_(user); return withLock_(() => setFinal_(user, req));
    case 'history': requireOwner_(user); return history_(req);
    case 'staffList': requireOwner_(user); return staffList_();
    case 'addStaff': requireOwner_(user); return withLock_(() => addStaff_(req));
    case 'reissue': requireOwner_(user); return withLock_(() => reissue_(req));
    case 'setActive': requireOwner_(user); return withLock_(() => setActive_(req));
    case 'assign': requireOwner_(user); return withLock_(() => assign_(user));
    case 'publishPlacement': requireOwner_(user); return withLock_(() => publishPlacement_(user));
    case 'swapPlacement': requireOwner_(user); return withLock_(() => swapPlacement_(user, req));
    default: return fail_('不明な操作です');
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Auth ---------- */

function login_(req) {
  const id = String(req.id || '').trim().slice(0, 20);
  const password = String(req.password || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) fail_('ログイン失敗が続いたため、しばらくロックされています。時間をおいてお試しください');

  const staff = readRows_('Staff').find(r => String(r.id) === id);
  const valid = staff && String(staff.active).toUpperCase() !== 'FALSE' &&
    hash_(String(staff.salt), password) === String(staff.hash);
  if (!valid) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    fail_('IDまたはパスワードが違います');
  }
  cache.remove(failKey);

  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const user = { id: String(staff.id), name: String(staff.name), role: String(staff.role) };
  cache.put('sess_' + token, JSON.stringify(user), SESSION_SECONDS);
  return { ok: true, token: token, user: { name: user.name, role: user.role } };
}

function requireSession_(token) {
  const raw = CacheService.getScriptCache().get('sess_' + String(token || ''));
  if (!raw) fail_('ログインの有効期限が切れました。もう一度ログインしてください');
  return JSON.parse(raw);
}

function requireOwner_(user) {
  if (user.role !== 'owner') fail_('この操作はオーナーのみ可能です');
}

function hash_(salt, password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ---------- Sheets helpers ---------- */

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function notify_(message) {
  Logger.log(message);
  try { ss_().toast(message); } catch (e) { /* 単独プロジェクトでは表示されないことがある */ }
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) fail_('シート「' + name + '」がありません。setup を実行してください');
  return sh;
}

function readRows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const header = values[0];
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 };
    header.forEach((key, c) => { obj[key] = row[c]; });
    return obj;
  });
}

function asDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
}

function asTime_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'HH:mm') : String(v).slice(0, 5);
}

function asStamp_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v);
}

function nowMinute_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
}

function nowSecond_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function checkDate_(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail_('日付の形式が正しくありません');
  return s;
}

function checkTime_(v) {
  const s = String(v || '');
  if (!/^\d{2}:\d{2}$/.test(s)) fail_('時刻の形式が正しくありません');
  return s;
}

/* ---------- Events ---------- */

function eventFromRow_(r) {
  return {
    _row: r._row,
    id: String(r.eventId),
    date: asDate_(r.date),
    startTime: asTime_(r.startTime),
    endTime: asTime_(r.endTime),
    deadline: asStamp_(r.deadline).slice(0, 16),
    note: String(r.note || ''),
    status: String(r.status),
    createdAt: asStamp_(r.createdAt)
  };
}

function currentEvent_() {
  const list = readRows_('Events').map(eventFromRow_)
    .filter(e => e.status === 'active')
    .sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  return list.length ? list[0] : null;
}

function phaseOf_(e) {
  return nowMinute_() >= e.deadline ? 'closed' : 'open';
}

function dateJa_(d) {
  const p = d.split('-').map(Number);
  const dow = '月火水木金土日'.charAt(Number(Utilities.formatDate(new Date(d + 'T00:00:00+09:00'), TZ, 'u')) - 1);
  return p[0] + '年' + p[1] + '月' + p[2] + '日（' + dow + '）';
}

function buildMessage_(e) {
  const lines = [
    '【EXTA 出勤確認】',
    '次回の営業日が決まりました。',
    '',
    '日時：' + dateJa_(e.date) + ' ' + e.startTime + '〜' + e.endTime,
    '回答期限：' + dateJa_(e.deadline.slice(0, 10)) + ' ' + e.deadline.slice(11, 16)
  ];
  if (e.note) lines.push('', e.note);
  lines.push(
    '',
    'ご都合を「出勤できます」「出勤できません」からお選びください。',
    '期限を過ぎると回答できなくなります。',
    '',
    '▼回答はこちら',
    STAFF_PAGE_URL
  );
  return lines.join('\n');
}

function eventView_(e) {
  return {
    id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime,
    deadline: e.deadline, note: e.note, phase: phaseOf_(e), message: buildMessage_(e)
  };
}

function parseEventInput_(req) {
  const date = checkDate_(req.date);
  const startTime = checkTime_(req.startTime);
  const endTime = checkTime_(req.endTime);
  const deadline = String(req.deadline || '').replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) fail_('回答期限の形式が正しくありません');
  if (deadline <= nowMinute_()) fail_('回答期限は現在より後の日時にしてください');
  if (deadline > date + ' ' + startTime) fail_('回答期限は営業開始より前にしてください');
  const note = String(req.note || '').trim().slice(0, 300);
  return { date: date, startTime: startTime, endTime: endTime, deadline: deadline, note: note };
}

function previewEvent_(req) {
  return { ok: true, message: buildMessage_(parseEventInput_(req)) };
}

function createEvent_(user, req) {
  const input = parseEventInput_(req);
  const sh = sheet_('Events');
  // 前の出勤確認が締め切り済みなら「履歴に保存(archived)」、締め切り前の作り直しなら「取り消し(cancelled)」
  readRows_('Events').map(eventFromRow_).filter(e => e.status === 'active')
    .forEach(e => sh.getRange(e._row, 7).setValue(phaseOf_(e) === 'closed' ? 'archived' : 'cancelled'));
  clearPlacement_(input.date); // 同じ日付の古い配置が新しい出勤確認に混ざらないようにする
  sh.appendRow([
    Utilities.getUuid().slice(0, 8), input.date, input.startTime, input.endTime,
    input.deadline, input.note, 'active', nowSecond_()
  ]);
  return state_(user);
}

function closeNow_(user) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  sheet_('Events').getRange(e._row, 5).setValue(nowMinute_());
  return state_(user);
}

// 締め切り済みの出勤確認を、新しい締め切りでもう一度受け付ける。回答はそのまま残し、配置の抽選結果は取り消す
function reopen_(user, req) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (phaseOf_(e) !== 'closed') fail_('すでに回答を受け付けています');
  const deadline = String(req.deadline || '').replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) fail_('回答期限の形式が正しくありません');
  if (deadline <= nowMinute_()) fail_('回答期限は現在より後の日時にしてください');
  if (deadline > e.date + ' ' + e.startTime) fail_('回答期限は営業開始より前にしてください');
  sheet_('Events').getRange(e._row, 5).setValue(deadline);
  clearPlacement_(e.date);
  setPublished_(e.id, false);
  return state_(user);
}

function cancelEvent_(user) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  sheet_('Events').getRange(e._row, 7).setValue('cancelled');
  return state_(user);
}

/* ---------- Responses ---------- */

function responsesOf_(eventId) {
  return readRows_('Responses').filter(r => String(r.eventId) === eventId);
}

// 出勤確認・配置の対象は、キャストとスタッフ（オーナーは対象外）
function activeMembers_() {
  return readRows_('Staff').filter(r => String(r.role) !== 'owner' && String(r.active).toUpperCase() !== 'FALSE');
}

function effectiveOf_(resp) {
  if (resp && String(resp.final)) return String(resp.final);
  return resp && String(resp.answer) === 'yes' ? 'ok' : 'ng';
}

function detail_(e, responses) {
  const rows = activeMembers_().map(c => {
    const resp = responses.find(r => String(r.staffId) === String(c.id));
    return {
      name: String(c.name),
      role: String(c.role),
      answer: resp ? String(resp.answer) : '',
      final: resp ? String(resp.final) : '',
      effective: effectiveOf_(resp)
    };
  });
  return {
    rows: rows,
    counts: {
      yes: rows.filter(r => r.answer === 'yes').length,
      no: rows.filter(r => r.answer === 'no').length,
      none: rows.filter(r => !r.answer).length,
      attend: rows.filter(r => r.effective === 'ok').length
    }
  };
}

function state_(user) {
  const out = { ok: true, user: { name: user.name, role: user.role }, event: null, myAnswer: '', placement: null };
  const e = currentEvent_();
  if (!e) return out;
  out.event = eventView_(e);
  const responses = responsesOf_(e.id);
  if (user.role === 'owner') {
    out.detail = detail_(e, responses);
  } else {
    const mine = responses.find(r => String(r.staffId) === user.id);
    out.myAnswer = mine ? String(mine.answer) : '';
  }
  const placement = getPlacement_(e.date);
  if (user.role === 'owner') {
    out.placement = placement;
    out.placementStatus = placement ? (isPublished_(e.id) ? 'published' : 'draft') : 'none';
    out.placementMessage = placement ? buildPlacementMessage_(e) : '';
  } else {
    out.placement = placement && isPublished_(e.id) ? placement : null; // 確定するまではキャストに見せない
  }
  return out;
}

function answer_(user, req) {
  if (user.role === 'owner') fail_('オーナーは回答の対象ではありません');
  const answer = String(req.answer);
  if (answer !== 'yes' && answer !== 'no') fail_('回答が正しくありません');
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (phaseOf_(e) === 'closed') fail_('締め切られました。オーナーに直接ご連絡ください');

  const sh = sheet_('Responses');
  const existing = responsesOf_(e.id).find(r => String(r.staffId) === user.id);
  const stamp = nowSecond_();
  if (existing) {
    sh.getRange(existing._row, 4).setValue(answer);
    sh.getRange(existing._row, 5).setValue(''); // 回答し直した人は、オーナーが決めた出勤／欠勤より新しい回答を優先する
    sh.getRange(existing._row, 6).setValue(stamp);
  } else {
    sh.appendRow([e.id, user.id, user.name, answer, '', stamp]);
  }
  return state_(user);
}

function setFinal_(user, req) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (phaseOf_(e) !== 'closed') fail_('回答の締め切り後に設定できます');
  const value = String(req.final);
  if (value !== 'ok' && value !== 'ng') fail_('設定が正しくありません');
  const cast = activeMembers_().find(c => String(c.name) === String(req.name));
  if (!cast) fail_('対象の人が見つかりません');

  const sh = sheet_('Responses');
  const existing = responsesOf_(e.id).find(r => String(r.staffId) === String(cast.id));
  if (existing) {
    sh.getRange(existing._row, 5).setValue(value);
    sh.getRange(existing._row, 6).setValue(nowSecond_());
  } else {
    sh.appendRow([e.id, String(cast.id), String(cast.name), '', value, nowSecond_()]);
  }
  return state_(user);
}

/* ---------- Staff management (owner) ---------- */
// パスワードはハッシュで保存しているため、あとから表示はできない。再発行・追加のときだけ、その場で一度だけ返す。

function staffList_() {
  return {
    ok: true,
    people: readRows_('Staff').map(r => ({
      name: String(r.name),
      role: String(r.role),
      id: String(r.id),
      active: String(r.active).toUpperCase() !== 'FALSE'
    }))
  };
}

function reissue_(req) {
  const name = String(req.name || '').trim();
  const row = readRows_('Staff').find(r => String(r.name) === name);
  if (!row) fail_('対象の人が見つかりません');
  const password = randomString_(10);
  const salt = randomString_(16);
  sheet_('Staff').getRange(row._row, 4, 1, 2).setValues([[salt, hash_(salt, password)]]);
  CacheService.getScriptCache().remove('fail_' + String(row.id)); // ロック中でも新しいパスワードで入れるようにする
  return { ok: true, credential: { name: name, id: String(row.id), password: password } };
}

function addStaff_(req) {
  const name = String(req.name || '').trim();
  const role = String(req.role);
  if (!name || name.length > 20) fail_('名前は1〜20文字で入力してください');
  if (role !== 'cast' && role !== 'staff') fail_('役割はキャストかスタッフを選んでください');
  const rows = readRows_('Staff');
  if (rows.some(r => String(r.name) === name)) fail_('同じ名前の人がすでにいます');

  const used = {};
  rows.forEach(r => { used[String(r.id)] = true; });
  const id = randomId_(used);
  const password = randomString_(10);
  const salt = randomString_(16);
  sheet_('Staff').appendRow([id, name, role, salt, hash_(salt, password), 'TRUE', Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')]);
  return { ok: true, credential: { name: name, id: id, password: password }, people: staffList_().people };
}

function setActive_(req) {
  const name = String(req.name || '').trim();
  const row = readRows_('Staff').find(r => String(r.name) === name);
  if (!row) fail_('対象の人が見つかりません');
  if (String(row.role) === 'owner') fail_('オーナーは無効にできません');
  sheet_('Staff').getRange(row._row, 6).setValue(req.active ? 'TRUE' : 'FALSE');
  return staffList_();
}

/* ---------- History (owner) ---------- */

function joinedOf_(person) {
  return person.joinedAt ? asDate_(person.joinedAt) : ''; // 空=最初から（すべての営業日が対象）
}

// 締め切り済みの営業日ごとの出勤状況と、全員の出勤率。limit=直近N回（0なら全期間）
function history_(req) {
  const limit = Math.max(0, Math.min(60, Number(req.limit) || 0));
  let events = readRows_('Events').map(eventFromRow_)
    .filter(e => (e.status === 'active' || e.status === 'archived') && phaseOf_(e) === 'closed')
    .sort((a, b) => a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1));
  if (limit) events = events.slice(0, limit);

  const people = readRows_('Staff').filter(r => String(r.role) !== 'owner' && String(r.active).toUpperCase() !== 'FALSE');
  const byEvent = {};
  readRows_('Responses').forEach(r => { (byEvent[String(r.eventId)] = byEvent[String(r.eventId)] || []).push(r); });
  const markOf = (p, e) => {
    if (joinedOf_(p) > e.date) return ''; // 登録前の営業日は対象外
    const resp = (byEvent[e.id] || []).find(r => String(r.staffId) === String(p.id));
    return effectiveOf_(resp) === 'ok' ? 'ok' : 'ng';
  };

  const eventsOut = events.map(e => ({
    id: e.id, date: e.date, startTime: e.startTime, endTime: e.endTime,
    attend: people.filter(p => markOf(p, e) === 'ok').map(p => String(p.name)),
    absent: people.filter(p => markOf(p, e) === 'ng').map(p => String(p.name))
  }));
  const peopleOut = people.map(p => {
    const marks = events.map(e => markOf(p, e));
    const attended = marks.filter(m => m === 'ok').length;
    const total = marks.filter(m => m !== '').length;
    return {
      name: String(p.name), role: String(p.role), attended: attended, total: total,
      rate: total ? Math.round(attended / total * 1000) / 10 : null, marks: marks
    };
  });
  return { ok: true, events: eventsOut, people: peopleOut };
}

/* ---------- Placement ---------- */

// Placements シートの rotation 列:
//   数字(1,2)=キャストのローテーション番号 / A1・B2 など=そのローテーションで「あふれて」スタッフグループに加わるキャスト
//   A・B=スタッフ側のサイド（スタッフ。両ローテーション共通）
// 返す配置の rotations[].staffSides は「サイドのスタッフ＋そのローテーションであふれたキャスト」
function getPlacement_(date) {
  const rows = readRows_('Placements').filter(r => asDate_(r.date) === date);
  if (!rows.length) return null;
  const rotations = {};
  const overflow = {};
  const sides = { A: [], B: [] };
  rows.forEach(r => {
    const key = String(r.rotation);
    const joined = key.match(/^([AB])(\d+)$/);
    if (/^\d+$/.test(key)) {
      (rotations[Number(key)] = rotations[Number(key)] || []).push({ position: Number(r.position), name: String(r.name) });
    } else if (joined) {
      const rot = Number(joined[2]);
      (overflow[rot] = overflow[rot] || { A: [], B: [] })[joined[1]].push(String(r.name));
    } else if (sides[key]) {
      sides[key].push(String(r.name));
    }
  });
  return {
    date: date,
    rotations: Object.keys(rotations).map(Number).sort((a, b) => a - b).map(rot => {
      const slots = [];
      for (let p = 1; p <= POSITIONS_PER_ROTATION; p++) {
        const found = rotations[rot].find(s => s.position === p);
        slots.push({ position: p, stations: [p * 2 - 1, p * 2], name: found ? found.name : '' });
      }
      const extra = overflow[rot] || { A: [], B: [] };
      const member = (kind) => (n) => ({ name: n, kind: kind });
      return {
        rotation: rot,
        slots: slots,
        staffSides: { A: sides.A.concat(extra.A), B: sides.B.concat(extra.B) },
        // 入れ替えの画面用。staff=スタッフ（両ローテ共通） / extra=その回であふれて加わったキャスト
        sideMembers: {
          A: sides.A.map(member('staff')).concat(extra.A.map(member('extra'))),
          B: sides.B.map(member('staff')).concat(extra.B.map(member('extra')))
        }
      };
    }),
    staff: sides // キャストが誰も出勤しない日のための予備
  };
}

/* 配置の公開状態（抽選しただけの「仮」か、キャストに見せる「確定」か）はスクリプトのプロパティに保存 */

function isPublished_(eventId) {
  return PropertiesService.getScriptProperties().getProperty('placementPublished_' + eventId) === '1';
}

function setPublished_(eventId, published) {
  const props = PropertiesService.getScriptProperties();
  if (published) props.setProperty('placementPublished_' + eventId, '1');
  else props.deleteProperty('placementPublished_' + eventId);
}

// 配置そのものは、ログインページで見てもらう。文面には、日時とログインページのURLだけを入れる
function buildPlacementMessage_(e) {
  return [
    '【EXTA 配置のお知らせ】',
    dateJa_(e.date) + ' ' + e.startTime + '〜' + e.endTime,
    '当日の配置が確定しましたのでご確認ください。',
    '',
    STAFF_PAGE_URL,
    '',
    '変更希望等ございましたら、オーナーまでお問合せください。'
  ].join('\n');
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// names を P 個の場所にランダムに置く。prevPos[name] に書かれた場所(0始まり)は避ける。置けない場所は ''
function placeAvoiding_(names, prevPos) {
  const P = POSITIONS_PER_ROTATION;
  for (let attempt = 0; attempt < 200; attempt++) {
    const slots = [];
    for (let i = 0; i < P; i++) slots.push('');
    let ok = true;
    const free = shuffle_(Array.from({ length: P }, (_, i) => i));
    for (const name of shuffle_(names)) {
      const idx = free.findIndex(p => p !== prevPos[name]);
      if (idx < 0) { ok = false; break; }
      slots[free.splice(idx, 1)[0]] = name;
    }
    if (ok) return slots;
  }
  // まず起こらないが、見つからない場合は「前の場所の次」にずらして必ず条件を満たす
  const slots = [];
  for (let i = 0; i < P; i++) slots.push('');
  const rest = [];
  names.forEach(name => {
    if (prevPos[name] === undefined) rest.push(name);
    else slots[(prevPos[name] + 1) % P] = name;
  });
  rest.forEach(name => { slots[slots.indexOf('')] = name; });
  return slots;
}

// あふれたキャストを、スタッフの人数が少ないほうのグループに入れる（同数ならランダム）
function spreadOverflow_(names, counts) {
  const size = { A: counts.A, B: counts.B };
  const result = { A: [], B: [] };
  shuffle_(names).forEach(name => {
    const g = size.A < size.B ? 'A' : (size.B < size.A ? 'B' : (Math.random() < 0.5 ? 'A' : 'B'));
    result[g].push(name);
    size[g]++;
  });
  return result;
}

// キャストを第1・第2ローテーションに配置する。
//  - 同じキャストが両方に入ってよい（第2は第1であふれた人を優先）
//  - 第2では、第1と同じ場所には置かない
//  - ローテーションごとにあふれた人は、スタッフ側のどちらかのサイド（A/B）に回す
function planCasts_(castNames, staffCounts) {
  const P = POSITIONS_PER_ROTATION;
  const all = shuffle_(castNames);
  const first = all.slice(0, P);
  const secondMembers = all.slice(P).concat(shuffle_(first)).slice(0, P);
  const firstSlots = placeAvoiding_(first, {});
  const firstPos = {};
  firstSlots.forEach((name, i) => { if (name) firstPos[name] = i; });
  const secondSlots = placeAvoiding_(secondMembers, firstPos);
  return [
    { rotation: 1, slots: firstSlots, overflow: spreadOverflow_(all.filter(n => first.indexOf(n) < 0), staffCounts) },
    { rotation: 2, slots: secondSlots, overflow: spreadOverflow_(all.filter(n => secondMembers.indexOf(n) < 0), staffCounts) }
  ];
}

function assign_(user) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (phaseOf_(e) !== 'closed') fail_('回答の締め切り後に抽選できます');

  const responses = responsesOf_(e.id);
  const attending = role => activeMembers_().filter(c => String(c.role) === role &&
    effectiveOf_(responses.find(r => String(r.staffId) === String(c.id))) === 'ok')
    .map(r => String(r.name));
  const castNames = attending('cast');
  const staffNames = shuffle_(attending('staff'));
  if (!castNames.length && !staffNames.length) fail_('出勤する人がいません');

  const stamp = nowSecond_();
  const out = [];
  // スタッフは2つのサイドに半分ずつ分ける（奇数のときは、多いほうをランダムに決める）
  let sizeA = Math.ceil(staffNames.length / 2);
  if (staffNames.length % 2 === 1 && Math.random() < 0.5) sizeA = staffNames.length - sizeA;
  const sideA = staffNames.slice(0, sizeA);
  const sideB = staffNames.slice(sizeA);
  sideA.forEach((name, i) => out.push([e.date, 'A', i + 1, name, stamp]));
  sideB.forEach((name, i) => out.push([e.date, 'B', i + 1, name, stamp]));
  if (castNames.length) {
    planCasts_(castNames, { A: sideA.length, B: sideB.length }).forEach(rot => {
      rot.slots.forEach((name, i) => { if (name) out.push([e.date, rot.rotation, i + 1, name, stamp]); });
      ['A', 'B'].forEach(g => rot.overflow[g].forEach((name, i) => out.push([e.date, g + rot.rotation, i + 1, name, stamp])));
    });
  }

  clearPlacement_(e.date);
  const sh = sheet_('Placements');
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  setPublished_(e.id, false); // 抽選し直したら、確定前（仮）に戻す
  return state_(user);
}

/* ---------- Placement: manual swap (owner) ---------- */
// 入れ替えられる場所の指定:
//   {kind:'slot',  rotation, position}            キャストの①〜⑥（空きも可）
//   {kind:'extra', rotation, side, name}          その回であふれて、サイドに加わったキャスト
//   {kind:'staff', side, name}                    サイドのスタッフ（両ローテ共通）

function locateCell_(rows, ref) {
  if (!ref || typeof ref !== 'object') fail_('入れ替える場所が正しくありません');
  const kind = String(ref.kind);
  if (kind === 'slot') {
    const rotation = Number(ref.rotation);
    const position = Number(ref.position);
    if (!(rotation >= 1) || !(position >= 1 && position <= POSITIONS_PER_ROTATION)) fail_('入れ替える場所が正しくありません');
    const row = rows.find(r => String(r.rotation) === String(rotation) && Number(r.position) === position) || null;
    return { kind: kind, rotation: rotation, position: position, row: row };
  }
  const side = String(ref.side);
  const name = String(ref.name || '');
  if (side !== 'A' && side !== 'B') fail_('入れ替える場所が正しくありません');
  if (kind === 'extra') {
    const rotation = Number(ref.rotation);
    const row = rows.find(r => String(r.rotation) === side + rotation && String(r.name) === name);
    if (!row) fail_('最新の配置と合いません。画面を更新してください');
    return { kind: kind, rotation: rotation, side: side, row: row };
  }
  if (kind === 'staff') {
    const row = rows.find(r => String(r.rotation) === side && String(r.name) === name);
    if (!row) fail_('最新の配置と合いません。画面を更新してください');
    return { kind: kind, side: side, row: row };
  }
  return fail_('入れ替える場所が正しくありません');
}

function swapPlacement_(user, req) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  const rows = readRows_('Placements').filter(r => asDate_(r.date) === e.date);
  if (!rows.length) fail_('先に配置を抽選してください');
  const a = locateCell_(rows, req.a);
  const b = locateCell_(rows, req.b);
  if (JSON.stringify(req.a) === JSON.stringify(req.b)) fail_('同じ場所です');

  const sh = sheet_('Placements');
  // Placements の列: 1=date 2=rotation(またはA/B) 3=position 4=name
  const setKey = (cell, v) => sh.getRange(cell.row._row, 2).setValue(v);
  const setPos = (cell, v) => sh.getRange(cell.row._row, 3).setValue(v);
  const setName = (cell, v) => sh.getRange(cell.row._row, 4).setValue(v);

  if (a.kind === 'slot' && b.kind === 'slot') {
    if (a.rotation !== b.rotation) fail_('同じローテの中で入れ替えてください');
    if (a.row && b.row) {
      const n = String(a.row.name);
      setName(a, String(b.row.name));
      setName(b, n);
    } else if (a.row) {
      setPos(a, b.position); // 空いている場所へ移す
    } else if (b.row) {
      setPos(b, a.position);
    } else {
      fail_('入れ替える相手がいません');
    }
  } else if ((a.kind === 'slot' && b.kind === 'extra') || (a.kind === 'extra' && b.kind === 'slot')) {
    const s = a.kind === 'slot' ? a : b;
    const x = a.kind === 'extra' ? a : b;
    if (s.rotation !== x.rotation) fail_('同じローテの中で入れ替えてください');
    if (s.row) {
      const n = String(s.row.name);
      setName(s, String(x.row.name));
      setName(x, n);
    } else {
      setKey(x, String(s.rotation)); // 空いている場所へ、サイドから移る
      setPos(x, s.position);
    }
  } else if (a.kind === 'extra' && b.kind === 'extra') {
    if (a.rotation !== b.rotation) fail_('同じローテの中で入れ替えてください');
    if (a.side === b.side) fail_('同じサイドです。反対のサイドの人を選んでください');
    setKey(a, b.side + b.rotation);
    setKey(b, a.side + a.rotation);
  } else if (a.kind === 'staff' && b.kind === 'staff') {
    if (a.side === b.side) fail_('同じサイドです。反対のサイドの人を選んでください');
    setKey(a, b.side);
    setKey(b, a.side);
  } else {
    fail_('この組み合わせは入れ替えできません（キャスト同士・サイド同士で入れ替えてください）');
  }
  return state_(user);
}

function clearPlacement_(date) {
  const sh = sheet_('Placements');
  readRows_('Placements').filter(r => asDate_(r.date) === date)
    .map(r => r._row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
}

function publishPlacement_(user) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (!getPlacement_(e.date)) fail_('先に配置を抽選してください');
  setPublished_(e.id, true);
  return state_(user);
}

/* ---------- Setup (editor から実行) ---------- */

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomString_(length) {
  let out = '';
  while (out.length < length) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i + 1 < hex.length && out.length < length; i += 2) {
      out += ID_ALPHABET.charAt(parseInt(hex.substr(i, 2), 16) % ID_ALPHABET.length);
    }
  }
  return out;
}

function randomId_(used) {
  let id;
  do {
    id = String(1000 + (parseInt(Utilities.getUuid().replace(/-/g, '').substr(0, 8), 16) % 9000));
  } while (used[id]);
  used[id] = true;
  return id;
}

function ensureSheets_() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // 以前のバージョンで作ったシートに、あとから増えた列の見出しを足す
      const header = sh.getRange(1, 1, 1, SHEETS[name].length).getValues()[0];
      SHEETS[name].forEach((title, i) => {
        if (String(header[i]) !== title) sh.getRange(1, i + 1).setValue(title).setFontWeight('bold');
      });
    }
  });
}

function credentialSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('配布用');
  if (!sh) {
    sh = ss.insertSheet('配布用');
    sh.getRange(1, 1, 1, 4).setValues([['名前', 'ログインID', 'パスワード', 'メモ']]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
  }
  return sh;
}

function setup() {
  ensureSheets_();
  const staff = sheet_('Staff');
  if (staff.getLastRow() > 1) {
    notify_('シートを確認しました（スタッフはすでに登録済みです）。追加・再発行は issueCredentials を使ってください');
    return;
  }
  const used = {};
  const rows = [];
  const creds = [];
  STAFF_LIST.forEach(s => {
    const id = randomId_(used);
    const password = randomString_(10);
    const salt = randomString_(16);
    rows.push([id, s.name, s.role, salt, hash_(salt, password), 'TRUE', '']);
    creds.push([s.name, id, password, s.role === 'owner' ? 'オーナー' : '']);
  });
  staff.getRange(2, 1, rows.length, 7).setValues(rows);
  const cs = credentialSheet_();
  cs.getRange(cs.getLastRow() + 1, 1, creds.length, 4).setValues(creds);
  notify_('完了。「配布用」シートのID/パスワードを各自に伝え、伝え終わったらシートを削除してください');
}

// TARGETS の人を追加する。未登録なら新規追加、登録済みなら reissue: true のときだけパスワードを再発行する
function issueCredentials() {
  ensureSheets_();
  const staff = sheet_('Staff');
  const rows = readRows_('Staff');
  const used = {};
  rows.forEach(r => { used[String(r.id)] = true; });
  const cs = credentialSheet_();
  const issued = [];
  const skipped = [];

  TARGETS.forEach(t => {
    const name = String(t.name || '').trim();
    if (!name) return;
    if (['owner', 'cast', 'staff'].indexOf(t.role) < 0) fail_('「' + name + '」の role は cast / staff / owner のどれかにしてください');
    const existing = rows.find(r => String(r.name) === name);
    if (existing && !t.reissue) { skipped.push(name); return; }

    const password = randomString_(10);
    const salt = randomString_(16);
    let id;
    if (existing) {
      id = String(existing.id);
      staff.getRange(existing._row, 4, 1, 2).setValues([[salt, hash_(salt, password)]]);
    } else {
      id = randomId_(used);
      // joinedAt: 登録前の営業日は、出勤率の対象に入れない
      staff.appendRow([id, name, t.role, salt, hash_(salt, password), 'TRUE', Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')]);
    }
    cs.appendRow([name, id, password, existing ? '再発行' : '新規']);
    issued.push(name);
  });

  notify_('「配布用」シートに出力: ' + (issued.join('、') || 'なし') +
    (skipped.length ? ' ／ 登録済みのため何もしなかった人: ' + skipped.join('、') : ''));
}
