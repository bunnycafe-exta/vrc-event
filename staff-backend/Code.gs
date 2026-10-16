/**
 * EXTA スタッフ勤怠システム（Google Apps Script / スプレッドシート連携）
 *
 * セットアップ:
 *  1. 新しいGoogleスプレッドシートを作成 → 拡張機能 → Apps Script を開き、このコードを貼り付けて保存
 *  2. 関数「setup」を1回だけ実行（権限の承認が必要）。シートが作られ、「配布用」シートに各自のID/パスワードが出力される
 *  3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」→ 実行ユーザー「自分」/ アクセス「全員」→ デプロイ
 *  4. 表示されたウェブアプリURLを js/staff.js の API_URL に設定
 *  5. 「配布用」シートの内容を各スタッフへ個別に伝え、伝え終わったらシートを削除
 *
 * スタッフ追加・パスワード再発行: 下の TARGET_NAME / TARGET_ROLE を書き換えて「issueCredentials」を実行
 */

// スプレッドシートに紐づけず script.google.com で単独のプロジェクトとして作る場合のみ、
// スプレッドシートのURLの /d/ と /edit の間の文字列をここに入れる（紐づけて作る場合は空のまま）
const SPREADSHEET_ID = '';

const TZ = 'Asia/Tokyo';
const SESSION_SECONDS = 21600; // ログインの有効時間（6時間）
const MAX_FAILS = 5;           // ログイン失敗の許容回数
const LOCK_SECONDS = 600;      // 超えた場合のロック時間（10分）
const DAY_CHANGE_HOUR = 6;     // 午前6時までは前日の営業日として扱う（深夜の退勤対策）
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
  Attendance: ['timestamp', 'businessDate', 'staffId', 'name', 'type'],
  Shifts: ['date', 'staffId', 'name', 'status', 'updatedAt'],
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
    case 'punch': return withLock_(() => punch_(user, req));
    case 'history': return history_(user);
    case 'shifts': return shifts_(user);
    case 'saveShift': return withLock_(() => saveShift_(user, req));
    case 'deleteShift': return withLock_(() => deleteShift_(user, req));
    case 'placement': return { ok: true, placement: getPlacement_(checkDate_(req.date)) };
    case 'assign': requireOwner_(user); return withLock_(() => assign_(req));
    case 'overview': requireOwner_(user); return overview_(req);
    case 'month': requireOwner_(user); return month_(req);
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

function asStamp_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v);
}

function stampToMs_(s) {
  return new Date(s.replace(' ', 'T') + '+09:00').getTime();
}

function businessDate_(date) {
  return Utilities.formatDate(new Date(date.getTime() - DAY_CHANGE_HOUR * 3600 * 1000), TZ, 'yyyy-MM-dd');
}

function checkDate_(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail_('日付の形式が正しくありません');
  return s;
}

function checkMonth_(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}$/.test(s)) fail_('月の形式が正しくありません');
  return s;
}

function attendanceRows_() {
  return readRows_('Attendance').map(r => ({
    timestamp: asStamp_(r.timestamp),
    businessDate: asDate_(r.businessDate),
    staffId: String(r.staffId),
    name: String(r.name),
    type: String(r.type)
  })).sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
}

function timeOf_(stamp) {
  return stamp.slice(11, 16);
}

// 1日分の打刻から 出勤/退勤/勤務分数 をまとめる
function summarizeDay_(records) {
  const firstIn = records.find(r => r.type === 'in');
  if (!firstIn) return { inTime: '', outTime: '', minutes: 0 };
  const outs = records.filter(r => r.type === 'out' && r.timestamp > firstIn.timestamp);
  const lastOut = outs.length ? outs[outs.length - 1] : null;
  return {
    inTime: timeOf_(firstIn.timestamp),
    outTime: lastOut ? timeOf_(lastOut.timestamp) : '',
    minutes: lastOut ? Math.round((stampToMs_(lastOut.timestamp) - stampToMs_(firstIn.timestamp)) / 60000) : 0
  };
}

/* ---------- Actions: staff ---------- */

function state_(user) {
  const now = new Date();
  const today = businessDate_(now);
  const mine = attendanceRows_().filter(r => r.staffId === user.id && r.businessDate === today);
  const last = mine.length ? mine[mine.length - 1].type : '';
  return {
    ok: true,
    user: { name: user.name, role: user.role },
    businessDate: today,
    status: last === 'in' ? 'in' : (last === 'out' ? 'out' : 'none'),
    records: mine.map(r => ({ type: r.type, time: timeOf_(r.timestamp) })),
    placement: getPlacement_(today)
  };
}

function punch_(user, req) {
  const type = String(req.type);
  if (type !== 'in' && type !== 'out') fail_('操作が正しくありません');
  const now = new Date();
  const today = businessDate_(now);
  const mine = attendanceRows_().filter(r => r.staffId === user.id && r.businessDate === today);
  const last = mine.length ? mine[mine.length - 1].type : '';
  if (type === 'in' && last === 'in') fail_('すでに出勤済みです');
  if (type === 'out' && last !== 'in') fail_('出勤の打刻がないため退勤できません');

  sheet_('Attendance').appendRow([
    Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'), today, user.id, user.name, type
  ]);
  return state_(user);
}

function history_(user) {
  const byDate = {};
  attendanceRows_().filter(r => r.staffId === user.id).forEach(r => {
    (byDate[r.businessDate] = byDate[r.businessDate] || []).push(r);
  });
  const days = Object.keys(byDate).sort().reverse().slice(0, 90).map(date => {
    const s = summarizeDay_(byDate[date]);
    return { date: date, inTime: s.inTime, outTime: s.outTime, minutes: s.minutes };
  });
  return { ok: true, days: days };
}

function shifts_(user) {
  const today = businessDate_(new Date());
  const list = readRows_('Shifts')
    .filter(r => String(r.staffId) === user.id && asDate_(r.date) >= today)
    .map(r => ({ date: asDate_(r.date), status: String(r.status) }))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  return { ok: true, shifts: list };
}

function saveShift_(user, req) {
  const date = checkDate_(req.date);
  const status = String(req.status);
  if (status !== 'available' && status !== 'absent') fail_('状態が正しくありません');
  if (date < businessDate_(new Date())) fail_('過去の日付は登録できません');

  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const existing = readRows_('Shifts').find(r => String(r.staffId) === user.id && asDate_(r.date) === date);
  if (existing) {
    sheet_('Shifts').getRange(existing._row, 4, 1, 2).setValues([[status, stamp]]);
  } else {
    sheet_('Shifts').appendRow([date, user.id, user.name, status, stamp]);
  }
  return shifts_(user);
}

function deleteShift_(user, req) {
  const date = checkDate_(req.date);
  const existing = readRows_('Shifts').find(r => String(r.staffId) === user.id && asDate_(r.date) === date);
  if (existing) sheet_('Shifts').deleteRow(existing._row);
  return shifts_(user);
}

/* ---------- Actions: placement ---------- */

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

function assign_(req) {
  const date = checkDate_(req.date);
  const source = String(req.source) === 'shift' ? 'shift' : 'attendance';

  const casts = readRows_('Staff').filter(r => String(r.role) === 'cast' && String(r.active).toUpperCase() !== 'FALSE');
  let present;
  if (source === 'shift') {
    const ok = {};
    readRows_('Shifts').filter(r => asDate_(r.date) === date && String(r.status) === 'available')
      .forEach(r => { ok[String(r.staffId)] = true; });
    present = casts.filter(r => ok[String(r.id)]);
  } else {
    const ok = {};
    attendanceRows_().filter(r => r.businessDate === date && r.type === 'in')
      .forEach(r => { ok[r.staffId] = true; });
    present = casts.filter(r => ok[String(r.id)]);
  }
  if (!present.length) fail_(source === 'shift' ? 'この日に出勤予定のキャストがいません' : 'この日に出勤打刻したキャストがいません');

  const names = shuffle_(present.map(r => String(r.name)));
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const out = [];
  for (let i = 0; i < names.length; i++) {
    out.push([date, Math.floor(i / POSITIONS_PER_ROTATION) + 1, (i % POSITIONS_PER_ROTATION) + 1, names[i], stamp]);
  }

  const sh = sheet_('Placements');
  readRows_('Placements').filter(r => asDate_(r.date) === date)
    .map(r => r._row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  return { ok: true, placement: getPlacement_(date) };
}

/* ---------- Actions: owner ---------- */

function overview_(req) {
  const date = checkDate_(req.date);
  const att = attendanceRows_().filter(r => r.businessDate === date);
  const shiftBy = {};
  readRows_('Shifts').filter(r => asDate_(r.date) === date).forEach(r => { shiftBy[String(r.staffId)] = String(r.status); });

  const rows = readRows_('Staff').filter(r => String(r.active).toUpperCase() !== 'FALSE').map(r => {
    const s = summarizeDay_(att.filter(a => a.staffId === String(r.id)));
    return { name: String(r.name), role: String(r.role), shift: shiftBy[String(r.id)] || '', inTime: s.inTime, outTime: s.outTime, minutes: s.minutes };
  });
  return { ok: true, date: date, rows: rows };
}

function month_(req) {
  const month = checkMonth_(req.month);
  const att = attendanceRows_().filter(r => r.businessDate.slice(0, 7) === month);
  const rows = readRows_('Staff').filter(r => String(r.active).toUpperCase() !== 'FALSE').map(r => {
    const mine = att.filter(a => a.staffId === String(r.id));
    const byDate = {};
    mine.forEach(a => { (byDate[a.businessDate] = byDate[a.businessDate] || []).push(a); });
    let days = 0, minutes = 0;
    Object.keys(byDate).forEach(d => {
      const s = summarizeDay_(byDate[d]);
      if (s.inTime) days++;
      minutes += s.minutes;
    });
    return { name: String(r.name), role: String(r.role), days: days, minutes: minutes };
  });
  return { ok: true, month: month, rows: rows };
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
    notify_('すでにスタッフが登録されています。追加・再発行は issueCredentials を使ってください');
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
