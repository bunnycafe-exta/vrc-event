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

// 来店予約フォームの回答が入っているスプレッドシート（URLの /d/ と /edit の間）と、そのシートの gid（URL末尾の gid=）。
// オーナーの画面の「予約」タブで読むだけで、書き込みはしない。
// このスクリプトを実行するアカウントが、そのスプレッドシートを開ける（持ち主か、共有されている）必要がある
const RESERVATION_SPREADSHEET_ID = '1Opkrsg6lUWFmfHDzkcaPcn2aMWuC2S4ADFusO_wI5B4';
const RESERVATION_SHEET_GID = 499524623;
const RESERVATION_MAX_ROWS = 300; // 画面に出す件数（新しいものから）

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

// ブラウザでURLを開いたときの応答。公開サイトの「次回営業日」の表示にも使う（日付と時間だけで、個人の情報は含まない）
function doGet() {
  let next = null;
  try {
    next = publicNextOpen_();
  } catch (err) {
    console.error(err);
  }
  let reservationOpen = true;
  try {
    reservationOpen = publicReservationOpen_();
  } catch (err) {
    console.error(err);
  }
  return json_({ ok: true, service: 'EXTA staff API', version: 17, next: next, reservationOpen: reservationOpen });
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
    case 'reservations': requireOwner_(user); return reservations_();
    case 'setReservationCap': requireOwner_(user); return withLock_(() => setReservationCap_(req));
    case 'resetReservationCount': requireOwner_(user); return withLock_(() => resetReservationCount_());
    case 'reservationHistory': requireOwner_(user); return reservationHistory_();
    case 'cancelReservation': requireOwner_(user); return withLock_(() => cancelReservation_(req));
    case 'reopenReservation': requireOwner_(user); return withLock_(() => reopenReservation_());
    case 'getNextOpen': requireOwner_(user); return { ok: true, next: storedNextOpen_() };
    case 'setNextOpen': requireOwner_(user); return withLock_(() => setNextOpen_(req));
    case 'clearNextOpen': requireOwner_(user); return withLock_(() => clearNextOpen_());
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
/* ---------- 公開サイトに表示する「次回営業日」 ---------- */

const NEXT_OPEN_KEY = 'nextOpen';

function storedNextOpen_() {
  const raw = PropertiesService.getScriptProperties().getProperty(NEXT_OPEN_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return { date: String(v.date), startTime: String(v.startTime), endTime: String(v.endTime) };
  } catch (err) {
    return null;
  }
}

// 公開サイトに出すのは、今日以降の分だけ（営業日の当日が終わるまで表示し、翌日に消える）
function publicNextOpen_() {
  const v = storedNextOpen_();
  return v && v.date >= nowMinute_().slice(0, 10) ? v : null;
}

function setNextOpen_(req) {
  const date = checkDate_(req.date);
  const startTime = checkTime_(req.startTime);
  const endTime = checkTime_(req.endTime);
  if (date < nowMinute_().slice(0, 10)) fail_('過去の日付は設定できません');
  const next = { date: date, startTime: startTime, endTime: endTime };
  const before = storedNextOpen_();
  PropertiesService.getScriptProperties().setProperty(NEXT_OPEN_KEY, JSON.stringify(next));
  // 営業日が変わったときは、新しい営業日の予約が始まったものとして、人数を数え直し、受付を再開する
  if (!before || before.date !== date) {
    try {
      resetReservationCount_(date);
    } catch (err) {
      console.error(err);
    }
  }
  return { ok: true, next: next };
}

function clearNextOpen_() {
  PropertiesService.getScriptProperties().deleteProperty(NEXT_OPEN_KEY);
  return { ok: true, next: null };
}

/* ---------- 来店予約（フォームの回答の一覧と、人数の上限） ---------- */

const RES_CAP_KEY = 'reservationCap';     // 上限の人数（0 = 上限なし）
const RES_SINCE_KEY = 'reservationSince'; // この時刻より後の予約だけを数える（ミリ秒）。新しい営業日の受付を始めるたびに更新する
const RES_OPEN_KEY = 'reservationOpen';   // '1' = 受付中 / '0' = 受付終了（公開サイトの表示用）
const RES_CANCEL_KEY = 'reservationCancelled'; // キャンセルにした予約の目印（回答の日時と名前）。シートには書き込まない
const RES_DEFAULT_CAP = 6;
const RES_CLOSED_MESSAGE = '定員に達したため、来店予約の受付を終了しました。次回の受付開始まで、お待ちください。';

function reservationCap_() {
  const v = PropertiesService.getScriptProperties().getProperty(RES_CAP_KEY);
  return v === null ? RES_DEFAULT_CAP : Math.max(0, Number(v) || 0);
}

function reservationSince_() {
  return Number(PropertiesService.getScriptProperties().getProperty(RES_SINCE_KEY)) || 0;
}

function publicReservationOpen_() {
  return PropertiesService.getScriptProperties().getProperty(RES_OPEN_KEY) !== '0';
}

// 予約フォームの回答シートを読む。項目名はシートの1行目をそのまま使うので、フォームの質問を変えても動く
function cancelledKeys_() {
  try {
    const v = JSON.parse(PropertiesService.getScriptProperties().getProperty(RES_CANCEL_KEY) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch (err) {
    return [];
  }
}

function readReservations_() {
  let ss;
  try {
    ss = SpreadsheetApp.openById(RESERVATION_SPREADSHEET_ID);
  } catch (err) {
    console.error(err);
    fail_('予約のスプレッドシートを開けませんでした。このスクリプトを動かしているアカウントに、共有されているか確認してください');
  }
  const sheets = ss.getSheets();
  const sheet = sheets.find(s => s.getSheetId() === RESERVATION_SHEET_GID) || sheets[0];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: sheet, headers: [], rows: [], guestIdx: -1, nameIdx: -1, urlIdx: -1 };

  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const display = range.getDisplayValues();
  const raw = range.getValues();
  // フォームの質問は、1行目に説明が続いて入っていることが多いので、最初の行だけを項目名にする
  const headers = display[0].map(h => (String(h).split(/\r?\n/).map(s => s.trim()).find(s => s) || ''));
  const guestIdx = headers.findIndex(h => /何名|人数/.test(h));
  const nameIdx = headers.findIndex(h => /お名前|名前/.test(h));
  const urlIdx = headers.findIndex(h => /VRC/i.test(h) && /URL/i.test(h));
  const cancelled = cancelledKeys_();
  const rows = [];
  for (let i = 1; i < display.length; i++) {
    const values = display[i].map(c => String(c));
    if (!values.some(c => c.trim() !== '')) continue;
    const t = raw[i][0];
    const time = t instanceof Date ? t.getTime() : (Date.parse(String(t).replace(/-/g, '/')) || 0);
    const key = time + '|' + (nameIdx >= 0 ? values[nameIdx].trim() : '');
    rows.push({ row: i + 1, values: values, time: time, key: key, cancelled: cancelled.indexOf(key) >= 0 });
  }
  return { sheet: sheet, headers: headers, rows: rows, guestIdx: guestIdx, nameIdx: nameIdx, urlIdx: urlIdx };
}

// 1件の予約の人数（空欄は1名、「2名」「２」のような書き方も数える）
function guestsOf_(r, guestIdx) {
  if (guestIdx < 0) return 1;
  const n = parseInt(r.values[guestIdx].replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)), 10);
  return n > 0 ? n : 1;
}

function sumGuests_(rows, guestIdx, since) {
  return rows.filter(r => !r.cancelled && r.time >= since).reduce((sum, r) => sum + guestsOf_(r, guestIdx), 0);
}

// 人数が上限に達していれば、フォームの受付を止める。allowOpen=true のときは、上限に達していなければ、受付を再開する
// （再開は、オーナーが操作したときだけ。営業日と営業日の間に、オーナーが手で止めたフォームを、勝手に開けないため）
function applyReservationLimit_(data, allowOpen) {
  const cap = reservationCap_();
  const used = sumGuests_(data.rows, data.guestIdx, reservationSince_());
  const full = cap > 0 && used >= cap;
  let formError = '';
  try {
    const url = data.sheet.getFormUrl();
    if (!url) {
      formError = 'この回答シートに、フォームがつながっていません。';
    } else {
      const form = FormApp.openByUrl(url);
      if (full) {
        form.setCustomClosedFormMessage(RES_CLOSED_MESSAGE);
        if (form.isAcceptingResponses()) form.setAcceptingResponses(false);
      } else if (allowOpen && !form.isAcceptingResponses()) {
        form.setAcceptingResponses(true);
      }
    }
  } catch (err) {
    console.error(err);
    formError = 'フォームの受付を切り替えられませんでした。Apps Script で「setupReservation」を実行して、許可を出してください。';
  }
  if (!formError) PropertiesService.getScriptProperties().setProperty(RES_OPEN_KEY, full ? '0' : '1');
  return { cap: cap, used: used, full: full, formError: formError };
}

function reservationStatus_(data, applied) {
  let accepting = null;
  try {
    const url = data.sheet.getFormUrl();
    if (url) accepting = FormApp.openByUrl(url).isAcceptingResponses();
  } catch (err) {
    console.error(err);
  }
  return { cap: applied.cap, used: applied.used, full: applied.full, accepting: accepting, error: applied.formError };
}

// 来店予約の回答を、新しい順に返す（オーナー専用）
function reservations_() {
  const data = readReservations_();
  const applied = applyReservationLimit_(data, false);
  const active = data.rows.filter(r => !r.cancelled);
  const guests = active.reduce((sum, r) => sum + guestsOf_(r, data.guestIdx), 0);
  const since = reservationSince_();
  const info = annotateReservations_(data);
  const rows = data.rows.slice().reverse().slice(0, RESERVATION_MAX_ROWS)
    .map(r => ({
      row: r.row, key: r.key, values: r.values, cancelled: r.cancelled, counted: !r.cancelled && r.time >= since,
      date: info[r.key + '#' + r.row].date, ordinal: r.cancelled ? 0 : info[r.key + '#' + r.row].ordinal
    }));
  return {
    ok: true, headers: data.headers, rows: rows, total: active.length, cancelledCount: data.rows.length - active.length,
    guests: guests, shown: rows.length,
    limit: reservationStatus_(data, applied),
    next: storedNextOpen_()
  };
}

// 上限の人数を変える（0 = 上限なし）。上限を上げて、まだ空きがあるときは、受付を再開する
function setReservationCap_(req) {
  const cap = Math.floor(Number(req.cap));
  if (!(cap >= 0 && cap <= 100)) fail_('上限は、0〜100の数字で入力してください（0は上限なし）');
  PropertiesService.getScriptProperties().setProperty(RES_CAP_KEY, String(cap));
  const data = readReservations_();
  return { ok: true, limit: reservationStatus_(data, applyReservationLimit_(data, true)) };
}

/* ---------- 来店予約の履歴と統計（営業日ごと・お客様ごと） ---------- */

const RES_PERIODS_KEY = 'reservationPeriods'; // 営業日ごとの予約の区切り [{ since: ミリ秒, date: 'yyyy-MM-dd' }]

// 予約を、どの営業日のものかに分けるための区切り。「新しい営業日の予約を始める」（または営業日の設定）のたびに増える
function reservationPeriods_() {
  let list = [];
  try {
    list = JSON.parse(PropertiesService.getScriptProperties().getProperty(RES_PERIODS_KEY) || '[]');
  } catch (err) {
    list = [];
  }
  list = (Array.isArray(list) ? list : []).filter(p => p && Number(p.since) >= 0).map(p => ({ since: Number(p.since), date: String(p.date || '') }));
  if (!list.length) {
    // この機能より前に始めた受付は、いまの次回営業日の予約として扱う
    const since = reservationSince_();
    const next = storedNextOpen_();
    if (since > 0) list = [{ since: since, date: next ? next.date : '' }];
  }
  return list.sort((a, b) => a.since - b.since);
}

function addReservationPeriod_(date) {
  const list = reservationPeriods_();
  list.push({ since: Date.now(), date: String(date || '') });
  PropertiesService.getScriptProperties().setProperty(RES_PERIODS_KEY, JSON.stringify(list.slice(-200)));
}

function periodDateOf_(periods, time) {
  let date = '';
  for (let i = 0; i < periods.length; i++) {
    if (periods[i].since <= time) date = periods[i].date; else break;
  }
  return date;
}

// お客様の見分け方: VRChatのアカウントURL（usr_…）があればそれ、なければお名前
function customerKeyOf_(data, r) {
  const url = data.urlIdx >= 0 ? r.values[data.urlIdx] : '';
  const m = /usr_[0-9a-f-]{8,}/i.exec(url || '');
  if (m) return m[0].toLowerCase();
  return 'name:' + (data.nameIdx >= 0 ? r.values[data.nameIdx] : '').replace(/\s+/g, '').toLowerCase();
}

// 全部の予約に、営業日と「何回目の予約か」を付ける（キャンセルは数えない。同じ営業日に複数あっても、1回として数える）
function annotateReservations_(data) {
  const periods = reservationPeriods_();
  const info = {};
  data.rows.forEach(r => {
    info[r.key + '#' + r.row] = { date: periodDateOf_(periods, r.time), customer: customerKeyOf_(data, r), ordinal: 0 };
  });
  const order = data.rows.filter(r => !r.cancelled).slice()
    .sort((a, b) => {
      const da = info[a.key + '#' + a.row].date || '9999';
      const db = info[b.key + '#' + b.row].date || '9999';
      return da !== db ? (da < db ? -1 : 1) : a.time - b.time;
    });
  const seen = {};
  order.forEach(r => {
    const i = info[r.key + '#' + r.row];
    const dates = seen[i.customer] = seen[i.customer] || [];
    if (dates.indexOf(i.date) < 0) dates.push(i.date);
    i.ordinal = dates.indexOf(i.date) + 1;
  });
  return info;
}

// 営業日ごとの予約と、お客様ごとの予約回数（オーナー専用）
function reservationHistory_() {
  const data = readReservations_();
  const info = annotateReservations_(data);
  const days = {};
  const customers = {};
  data.rows.forEach(r => {
    const i = info[r.key + '#' + r.row];
    const name = (data.nameIdx >= 0 ? r.values[data.nameIdx].trim() : '') || '（お名前なし）';
    const guests = guestsOf_(r, data.guestIdx);
    const day = days[i.date] = days[i.date] || { date: i.date, reservations: [], guests: 0, cancelledCount: 0 };
    day.reservations.push({ name: name, guests: guests, cancelled: r.cancelled, ordinal: r.cancelled ? 0 : i.ordinal, time: r.time });
    if (r.cancelled) { day.cancelledCount++; return; }
    day.guests += guests;
    const c = customers[i.customer] = customers[i.customer] || { name: name, dates: [], guests: 0, reservations: 0 };
    c.name = name; // 最後に使った名前
    c.guests += guests;
    c.reservations++;
    if (c.dates.indexOf(i.date) < 0) c.dates.push(i.date);
  });
  const dayList = Object.keys(days).map(k => days[k]).sort((a, b) => (a.date || '0000') < (b.date || '0000') ? 1 : -1);
  dayList.forEach(d => d.reservations.sort((a, b) => a.time - b.time));
  const customerList = Object.keys(customers).map(k => {
    const c = customers[k];
    const dated = c.dates.filter(d => d).sort();
    return { name: c.name, visits: c.dates.length, reservations: c.reservations, guests: c.guests, firstDate: dated[0] || '', lastDate: dated[dated.length - 1] || '' };
  }).sort((a, b) => b.visits - a.visits || (a.lastDate < b.lastDate ? 1 : -1));
  const repeaters = customerList.filter(c => c.visits >= 2).length;
  return {
    ok: true, days: dayList, customers: customerList,
    stats: { customers: customerList.length, repeaters: repeaters, businessDays: dayList.filter(d => d.date).length }
  };
}

// 新しい営業日の予約を始める。この時点までの予約は、人数に数えず（一覧には残る）、受付を再開する
function resetReservationCount_(date) {
  if (date === undefined) {
    const next = publicNextOpen_();
    date = next ? next.date : '';
  }
  PropertiesService.getScriptProperties().setProperty(RES_SINCE_KEY, String(Date.now()));
  addReservationPeriod_(date);
  const data = readReservations_();
  return { ok: true, limit: reservationStatus_(data, applyReservationLimit_(data, true)) };
}

// 予約を「キャンセル」にする／取り消す。キャンセルの人数は、数えなくなる（受付を自動で再開はしない。再募集は、オーナーが「受付を再開」を押す）
function cancelReservation_(req) {
  const key = String(req.key || '');
  const data = readReservations_();
  if (!data.rows.some(r => r.key === key)) fail_('対象の予約が見つかりません。画面を更新してください');
  const list = cancelledKeys_().filter(k => k !== key);
  if (req.cancelled) list.push(key);
  PropertiesService.getScriptProperties().setProperty(RES_CANCEL_KEY, JSON.stringify(list.slice(-500)));
  const fresh = readReservations_();
  return { ok: true, limit: reservationStatus_(fresh, applyReservationLimit_(fresh, false)) };
}

// キャンセルで空きが出たときの再募集。フォームの受付を再開する（満席のときは、再開できない）
function reopenReservation_() {
  const data = readReservations_();
  const applied = applyReservationLimit_(data, true);
  if (applied.full) fail_('まだ満席です。上限の人数を増やすか、キャンセルにしてから、再開してください');
  return { ok: true, limit: reservationStatus_(data, applied) };
}

// フォームに回答が届くたびに、自動で動く（setupReservation で登録する）
function onReservationSubmit() {
  withLock_(() => {
    applyReservationLimit_(readReservations_(), false);
  });
}

// 1回だけ、Apps Script のエディタで実行する（許可の画面が出る）。
// 回答が届くたびに、人数を数えて、上限に達したらフォームの受付を止める仕組みを登録する
function setupReservation() {
  const data = readReservations_();
  const url = data.sheet.getFormUrl();
  if (!url) throw new Error('この回答シートに、フォームがつながっていません');
  const form = FormApp.openByUrl(url);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onReservationSubmit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onReservationSubmit').forForm(form).onFormSubmit().create();
  console.log('登録しました。現在の人数: ' + applyReservationLimit_(data, false).used + '名');
}

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
