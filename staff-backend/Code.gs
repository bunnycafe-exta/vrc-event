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
 * スタッフ追加・パスワード再発行: 下の TARGET_NAME / TARGET_ROLE を書き換えて「issueCredentials」を実行
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

const TARGET_NAME = '';
const TARGET_ROLE = 'cast';

const SHEETS = {
  Staff: ['id', 'name', 'role', 'salt', 'hash', 'active'],
  Events: ['eventId', 'date', 'startTime', 'endTime', 'deadline', 'note', 'status', 'createdAt'],
  Responses: ['eventId', 'staffId', 'name', 'answer', 'final', 'updatedAt'],
  Placements: ['date', 'rotation', 'position', 'name', 'createdAt']
};

class AppError extends Error {}

/* ---------- Web app entry ---------- */

function doGet() {
  return json_({ ok: true, service: 'EXTA staff API' });
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
    case 'setFinal': requireOwner_(user); return withLock_(() => setFinal_(user, req));
    case 'assign': requireOwner_(user); return withLock_(() => assign_(user));
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
  readRows_('Events').filter(r => String(r.status) === 'active')
    .forEach(r => sh.getRange(r._row, 7).setValue('cancelled'));
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

function activeCasts_() {
  return readRows_('Staff').filter(r => String(r.role) === 'cast' && String(r.active).toUpperCase() !== 'FALSE');
}

function effectiveOf_(resp) {
  if (resp && String(resp.final)) return String(resp.final);
  return resp && String(resp.answer) === 'yes' ? 'ok' : 'ng';
}

function detail_(e, responses) {
  const rows = activeCasts_().map(c => {
    const resp = responses.find(r => String(r.staffId) === String(c.id));
    return {
      name: String(c.name),
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
  if (user.role === 'cast') {
    const mine = responses.find(r => String(r.staffId) === user.id);
    out.myAnswer = mine ? String(mine.answer) : '';
  } else {
    out.detail = detail_(e, responses);
  }
  out.placement = getPlacement_(e.date);
  return out;
}

function answer_(user, req) {
  if (user.role !== 'cast') fail_('回答できるのはキャストのみです');
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
  const cast = activeCasts_().find(c => String(c.name) === String(req.name));
  if (!cast) fail_('対象のキャストが見つかりません');

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

/* ---------- Placement ---------- */

function getPlacement_(date) {
  const rows = readRows_('Placements').filter(r => asDate_(r.date) === date);
  if (!rows.length) return null;
  const rotations = {};
  rows.forEach(r => {
    const rot = Number(r.rotation);
    const pos = Number(r.position);
    (rotations[rot] = rotations[rot] || []).push({
      position: pos,
      stations: [pos * 2 - 1, pos * 2],
      name: String(r.name)
    });
  });
  return {
    date: date,
    rotations: Object.keys(rotations).map(Number).sort((a, b) => a - b).map(rot => ({
      rotation: rot,
      slots: rotations[rot].sort((a, b) => a.position - b.position)
    }))
  };
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function assign_(user) {
  const e = currentEvent_();
  if (!e) fail_('現在、出勤の確認はありません');
  if (phaseOf_(e) !== 'closed') fail_('回答の締め切り後に抽選できます');

  const responses = responsesOf_(e.id);
  const present = activeCasts_().filter(c =>
    effectiveOf_(responses.find(r => String(r.staffId) === String(c.id))) === 'ok');
  if (!present.length) fail_('出勤するキャストがいません');

  const names = shuffle_(present.map(r => String(r.name)));
  const stamp = nowSecond_();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    out.push([e.date, Math.floor(i / POSITIONS_PER_ROTATION) + 1, (i % POSITIONS_PER_ROTATION) + 1, names[i], stamp]);
  }

  const sh = sheet_('Placements');
  readRows_('Placements').filter(r => asDate_(r.date) === e.date)
    .map(r => r._row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
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
    rows.push([id, s.name, s.role, salt, hash_(salt, password), 'TRUE']);
    creds.push([s.name, id, password, s.role === 'owner' ? 'オーナー' : '']);
  });
  staff.getRange(2, 1, rows.length, 6).setValues(rows);
  const cs = credentialSheet_();
  cs.getRange(cs.getLastRow() + 1, 1, creds.length, 4).setValues(creds);
  notify_('完了。「配布用」シートのID/パスワードを各自に伝え、伝え終わったらシートを削除してください');
}

// TARGET_NAME が登録済みならパスワード再発行、未登録なら新規追加
function issueCredentials() {
  if (!TARGET_NAME) fail_('TARGET_NAME に名前を設定してください');
  ensureSheets_();
  const staff = sheet_('Staff');
  const rows = readRows_('Staff');
  const used = {};
  rows.forEach(r => { used[String(r.id)] = true; });

  const password = randomString_(10);
  const salt = randomString_(16);
  const existing = rows.find(r => String(r.name) === TARGET_NAME);
  let id;
  if (existing) {
    id = String(existing.id);
    staff.getRange(existing._row, 4, 1, 2).setValues([[salt, hash_(salt, password)]]);
  } else {
    id = randomId_(used);
    staff.appendRow([id, TARGET_NAME, TARGET_ROLE, salt, hash_(salt, password), 'TRUE']);
  }
  const cs = credentialSheet_();
  cs.appendRow([TARGET_NAME, id, password, existing ? '再発行' : '新規']);
  notify_('「配布用」シートに出力しました');
}
