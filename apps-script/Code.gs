/**
 * Үзэсгэлэнгийн лангуу захиалгын систем — сервер (Google Apps Script)
 *
 * Өгөгдөл: энэ скрипт холбогдсон Google Sheets файл.
 * Тохиргоо (Project Settings → Script properties):
 *   CLAUDE_API_KEY   — зураг таних (заавал биш, байхгүй бол гараар тэмдэглэнэ)
 *   CLAUDE_MODEL     — заавал биш, анхдагч: claude-sonnet-5-5
 *   TELEGRAM_TOKEN   — мэдэгдэл илгээх ботын токен (заавал биш)
 *   TELEGRAM_CHAT    — менежерүүдийн группын ID: захиалга, төлбөр, цуцлалт (заавал биш)
 *   TELEGRAM_DIRECTOR — захирлын хувийн чатын ID: дээрх бүгд + өглөөний санхүүгийн тайлан (заавал биш)
 *   TELEGRAM_ADMIN   — систем админы хувийн чатын ID: зөвхөн системийн алдаа (заавал биш)
 *   ADMIN_PIN        — систем админы анхны PIN (setup() ажиллуулахад ашиглана)
 *
 * Эрх (Ажилтан хуудасны role багана): system = систем админ, admin = захирал, staff = менежер.
 *
 * Анх суулгахдаа setup() функцийг нэг удаа ажиллуулна.
 */

const SH = { EXPO: 'Үзэсгэлэн', CAT: 'Салбар', BOOTH: 'Лангуу', STAFF: 'Ажилтан', LOG: 'Түүх', PROD: 'Бүтээгдэхүүн', PART: 'Оролцоо', ORG: 'Оролцогчид' };
const COLS = {
  'Үзэсгэлэн': ['id', 'name', 'start', 'end', 'imageId', 'imgW', 'imgH', 'status', 'holdHours', 'advancePct', 'createdAt', 'payInfo', 'slug', 'place', 'about', 'posterId', 'template'],
  'Салбар': ['expoId', 'catId', 'name', 'color', 'price'],
  'Лангуу': ['expoId', 'boothId', 'code', 'x', 'y', 'w', 'h', 'm2', 'catId', 'status', 'price', 'org', 'person', 'tel', 'mail', 'heldAt', 'updatedAt', 'updatedBy', 'products'],
  'Ажилтан': ['name', 'pin', 'role', 'active', 'tg'],
  'Түүх': ['time', 'expoId', 'code', 'action', 'by', 'detail'],
  // Үзэсгэлэнгийн загвар бүрийн бүтээгдэхүүний жагсаалт. Менежер/захирал Sheets дээр шууд засна.
  'Бүтээгдэхүүн': ['Үзэсгэлэн', 'Дүрс', 'Бүтээгдэхүүн', 'Салбар', 'Идэвхтэй'],
  // Захиалга бүр нэг мөр (цуцлагдсан ч түүх нь үлдэнэ). Систем автоматаар бичнэ.
  'Оролцоо': ['Үзэсгэлэн', 'Лангуу', 'Байгууллага', 'Хариуцах хүн', 'Утас', 'Имэйл', 'Бүтээгдэхүүн', 'Төлөв', 'Дүн', 'Захиалсан', 'Шинэчилсэн', 'Бүртгэсэн', 'expoId', 'boothId'],
  // Байгууллага бүр нэг мөр: бүх үзэсгэлэнгийн нэгдсэн сан. Систем автоматаар бичнэ.
  'Оролцогчид': ['Түлхүүр', 'Байгууллага', 'Хариуцах хүн', 'Утас', 'Имэйл', 'Бүтээгдэхүүн', 'Оролцсон үзэсгэлэн', 'Тоо', 'Анх бүртгэгдсэн', 'Сүүлд',
    'Салбар', 'Эх сурвалж', 'Нэмсэн', 'Нэмэлт утас', 'Хаяг', 'Вэбсайт', 'Facebook', 'Тайлбар']
};
/** Гараар засах хүснэгтүүд (хамгаалалт тавихгүй). */
const EDITABLE = { 'Бүтээгдэхүүн': 1 };
const BOOKED = { held: 1, adv: 1, paid: 1 };
const MAX_HOLDS_PER_PHONE = 3;
const PALETTE = ['#2F6FE0', '#57C8E6', '#F2B84B', '#C98BD6', '#6E7F92', '#5BBE8A', '#E8846B'];

/* ===================== Нэвтрэх цэг ===================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  return handle_(Object.assign({}, p));
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'Хүсэлт буруу байна.' }); }
  if (body && body.update_id !== undefined) {
    // Telegram-ын товч, команд
    try { tgUpdate_(body, (e && e.parameter) || {}); } catch (err) { reportError_('telegram', err); }
    // HtmlService нь шууд 200 буцаана (ContentService-ийн 302 redirect-ийг Telegram алдаа гэж үзээд хойшлуулдаг)
    return HtmlService.createHtmlOutput('ok');
  }
  return handle_(body);
}

const PUBLIC = { list: apiList_, expo: apiExpo_, image: apiImage_, book: apiBook_, relayPair: apiRelayPair_ };
const STAFF = {
  login: apiLogin_, expos: apiExpos_, createExpo: apiCreateExpo_, updateExpo: apiUpdateExpo_,
  staffExpo: apiStaffExpo_, uploadImage: apiUploadImage_, detect: apiDetect_,
  saveBooths: apiSaveBooths_, setStatus: apiSetStatus_, staffList: apiStaffList_, staffSave: apiStaffSave_, poster: apiPoster_, report: apiReport_
};

function handle_(req) {
  const a = String(req.a || '');
  try {
    if (PUBLIC[a]) return out_(Object.assign({ ok: true }, PUBLIC[a](req)));
    if (STAFF[a]) {
      const who = auth_(req.pin);
      return out_(Object.assign({ ok: true }, STAFF[a](req, who)));
    }
    return out_({ ok: false, error: 'Тодорхойгүй үйлдэл.' });
  } catch (err) {
    const msg = err && err.userMessage ? err.userMessage : 'Серверт алдаа гарлаа. Дахин оролдоно уу.';
    if (!(err && err.userMessage)) reportError_(a, err);
    return out_({ ok: false, error: msg });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg) { const e = new Error(msg); e.userMessage = msg; throw e; }

/* ===================== Хүснэгттэй ажиллах ===================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const s = ss_().getSheetByName(name);
  if (s) return s;
  const n = ss_().insertSheet(name);
  n.getRange(1, 1, 1, COLS[name].length).setValues([COLS[name]]).setFontWeight('bold');
  n.setFrozenRows(1);
  return n;
}

function readAll_(name) {
  const s = sheet_(name), cols = COLS[name];
  const last = s.getLastRow();
  if (last < 2) return [];
  const vals = s.getRange(2, 1, last - 1, cols.length).getValues();
  return vals.map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j]; });
    return o;
  }).filter(o => String(o[cols[0]]) !== '');
}

function rowOf_(name, o) { return COLS[name].map(c => (o[c] === undefined || o[c] === null) ? '' : o[c]); }

function writeRow_(name, o) {
  sheet_(name).getRange(o._row, 1, 1, COLS[name].length).setValues([rowOf_(name, o)]);
}

function appendRows_(name, list) {
  if (!list.length) return;
  const s = sheet_(name);
  s.getRange(s.getLastRow() + 1, 1, list.length, COLS[name].length).setValues(list.map(o => rowOf_(name, o)));
}

/** Нэг үзэсгэлэнгийн мөрүүдийг шинээр солино (бусад үзэсгэлэнд хүрэхгүй). */
function replaceExpoRows_(name, expoId, list) {
  const s = sheet_(name), cols = COLS[name];
  const keep = readAll_(name).filter(o => String(o.expoId) !== String(expoId));
  const all = keep.concat(list).map(o => rowOf_(name, o));
  const last = s.getLastRow();
  if (last > 1) s.getRange(2, 1, last - 1, cols.length).clearContent();
  if (all.length) s.getRange(2, 1, all.length, cols.length).setValues(all);
}

function log_(expoId, code, action, by, detail) {
  try { appendRows_(SH.LOG, [{ time: new Date(), expoId, code, action, by, detail: detail || '' }]); } catch (e) {}
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('Систем завгүй байна. Хэдэн секундийн дараа дахин оролдоно уу.');
  try { return fn(); } finally { lock.releaseLock(); }
}

let PROPS_ = null; // нэг хүсэлтийн дотор тохиргоог нэг л удаа уншина
function prop_(k) {
  if (!PROPS_) { try { PROPS_ = PropertiesService.getScriptProperties().getProperties() || {}; } catch (e) { PROPS_ = {}; } }
  return PROPS_[k] || '';
}
/** Тохиргоонд олон ID таслалаар бичиж болно: "-5355907630, 6317987258" */
function ids_(k) { return prop_(k).split(/[,\s]+/).map(x => x.trim()).filter(Boolean); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); if (PROPS_) PROPS_[k] = v; }
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function num_(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
function str_(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function iso_(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : str_(d, 20); }
function fmt_(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/* ===================== Үнэ, төлөв ===================== */

function findExpo_(id) {
  const key = String(id || '').trim().toLowerCase();
  const all = readAll_(SH.EXPO), e = all.find(x => String(x.id) === key) || all.find(x => String(x.slug || '').toLowerCase() === key);
  if (!e) fail_('Үзэсгэлэн олдсонгүй. Холбоосоо шалгана уу.');
  e.holdHours = num_(e.holdHours, 48) || 48;
  e.advancePct = num_(e.advancePct, 50) || 50;
  return e;
}

/** Холбоосын богино нэрийг шалгана: латин жижиг үсэг, тоо, зураас; давхардахгүй. Хоосон бол ''. */
function slug_(v, selfId) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(s)) fail_('Холбоосын нэр 3–40 тэмдэгт, латин жижиг үсэг, тоо, зураасаас бүрдэнэ. Жишээ: tsagaansar2027');
  if (readAll_(SH.EXPO).some(x => String(x.id) !== String(selfId) && (String(x.slug || '').toLowerCase() === s || String(x.id) === s))) fail_('"' + s + '" нэрийг өөр үзэсгэлэн ашиглаж байна. Өөр нэр сонгоно уу.');
  return s;
}

/** Нийтийн хуудасны хариуг 10 секунд кэшлэнэ: олон хүн зэрэг ороход серверийн ачааллыг бууруулна. */
function cached_(key, fn) {
  const c = CacheService.getScriptCache(), hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const v = fn(), str = JSON.stringify(v);
  if (str.length < 90000) { try { c.put(key, str, 10); } catch (e) {} }
  return v;
}
/** Өгөгдөл өөрчлөгдөхөд кэшийг цэвэрлэнэ. */
function bump_(e) {
  try {
    const keys = ['pub_list'];
    if (e) { keys.push('pub_e_' + String(e.id).toLowerCase()); if (e.slug) keys.push('pub_e_' + String(e.slug).toLowerCase()); }
    CacheService.getScriptCache().removeAll(keys);
  } catch (x) {}
}

/** Талбайн зураг (лангууны байршил, дугаар, м², салбар, үнэ)-ийн хувилбарын тэмдэг. Захиалгын төлөв орохгүй. */
function layoutVer_(cats, booths) {
  const parts = cats.map(c => [c.catId, c.name, c.color, num_(c.price)].join('|')).sort()
    .concat(booths.map(b => [b.boothId, b.code, num_(b.x).toFixed(2), num_(b.y).toFixed(2), num_(b.w).toFixed(2), num_(b.h).toFixed(2), num_(b.m2), b.catId].join('|')).sort());
  let h = 5381; const s = parts.join('#');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + booths.length;
}

function catsOf_(expoId) { return readAll_(SH.CAT).filter(c => String(c.expoId) === String(expoId)); }
function boothsOf_(expoId) { return readAll_(SH.BOOTH).filter(b => String(b.expoId) === String(expoId)); }

function listPrice_(b, cats) {
  const c = cats.find(x => String(x.catId) === String(b.catId));
  return Math.round(num_(b.m2) * num_(c && c.price) / 1000) * 1000;
}
function priceOf_(b, cats) { return BOOKED[b.status] && num_(b.price) ? num_(b.price) : listPrice_(b, cats); }

/** 48 цагт урьдчилгаа ороогүй түр захиалгыг суллана. Суллагдсан лангуунуудын жагсаалтыг буцаана. */
function expireHolds_(expoFilter) {
  const now = Date.now(), expos = {}, eobj = {}, freed = [];
  readAll_(SH.EXPO).forEach(e => { expos[e.id] = num_(e.holdHours, 48) || 48; eobj[e.id] = e; });
  readAll_(SH.BOOTH).forEach(b => {
    if (b.status !== 'held' || (expoFilter && String(b.expoId) !== String(expoFilter))) return;
    const t = b.heldAt instanceof Date ? b.heldAt.getTime() : Date.parse(b.heldAt);
    if (!t || now - t < (expos[b.expoId] || 48) * 3600e3) return;
    freed.push({ expoId: b.expoId, code: b.code, org: b.org });
    if (eobj[b.expoId]) partSave_(eobj[b.expoId], b, 'expired', 'систем');
    clearBooking_(b); b.updatedAt = new Date(); b.updatedBy = 'систем';
    writeRow_(SH.BOOTH, b);
    log_(b.expoId, b.code, 'хугацаа дууссан', 'систем', '');
    bump_({ id: b.expoId, slug: (readAll_(SH.EXPO).find(x => String(x.id) === String(b.expoId)) || {}).slug });
  });
  return freed;
}

function clearBooking_(b) {
  b.status = 'free'; b.price = ''; b.org = ''; b.person = ''; b.tel = ''; b.mail = ''; b.heldAt = ''; b.products = '';
}

/* ===================== Бүтээгдэхүүний загвар ===================== */

const NO_ = { 'үгүй': 1, 'false': 1, 'no': 1, '0': 1 };
/** Идэвхтэй бүтээгдэхүүнүүд, загвараар бүлэглэсэн: { 'Property Expo': [{i:'🏢', n:'Шинэ орон сууц'}] } */
function productMap_() {
  const m = {};
  readAll_(SH.PROD).forEach(p => {
    const t = str_(p['Үзэсгэлэн'], 120), n = str_(p['Бүтээгдэхүүн'], 80);
    if (!t || !n || NO_[String(p['Идэвхтэй']).trim().toLowerCase()]) return;
    (m[t] = m[t] || []).push({ i: str_(p['Дүрс'], 8), n });
  });
  return m;
}
function templates_() { return Object.keys(productMap_()); }
function productsOf_(e) { return (e && e.template && productMap_()[String(e.template)]) || []; }

/** Оролцогчийн сонгосон бүтээгдэхүүнийг шалгана: зөвхөн жагсаалтад байгаа нь, 3 хүртэл; "Бусад" чөлөөт текст. */
const MAX_PRODUCTS = 3;
function cleanProducts_(list, other, e) {
  const allowed = {}; productsOf_(e).forEach(p => { allowed[p.n] = 1; });
  const out = [];
  (Array.isArray(list) ? list : []).forEach(x => { const n = str_(x, 80); if (allowed[n] && out.indexOf(n) < 0 && out.length < MAX_PRODUCTS) out.push(n); });
  const o = str_(other, 60).replace(/\|/g, '/');
  if (o) out.push('Бусад: ' + o);
  return out.join(' | ');
}

/* ===================== Оролцогчдын сан (Оролцоо, Оролцогчид) ===================== */

const PST = { held: 'Түр барьсан', adv: 'Урьдчилгаа төлсөн', paid: 'Бүрэн төлсөн', free: 'Цуцлагдсан', expired: 'Хугацаа дууссан' };
const PST_ICON = { 'Түр барьсан': '🟨', 'Урьдчилгаа төлсөн': '🟧', 'Бүрэн төлсөн': '🟥', 'Цуцлагдсан': '⬜', 'Хугацаа дууссан': '⏰' };
const PACTIVE = { 'Түр барьсан': 1, 'Урьдчилгаа төлсөн': 1, 'Бүрэн төлсөн': 1 };

function orgKey_(tel, org) {
  tel = String(tel || '').replace(/\D/g, '');
  return tel ? tel : 'нэр:' + String(org || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Лангууны захиалгын өөрчлөлтийг "Оролцоо" болон "Оролцогчид" хуудсанд бичнэ.
 * st: held | adv | paid | free (цуцалсан) | expired. b нь цэвэрлэгдэхээс ӨМНӨХ мэдээлэлтэй байх ёстой.
 * Алдаа гарсан ч захиалга зогсохгүй (зөвхөн систем админд мэдэгдэнэ).
 */
function partSave_(e, b, st, by) {
  try {
    if (!b || !b.org) return;
    const now = new Date(), rows = readAll_(SH.PART);
    const cur = rows.filter(r => String(r.expoId) === String(e.id) && String(r.boothId) === String(b.boothId) && PACTIVE[r['Төлөв']]).pop();
    const ended = st === 'free' || st === 'expired';
    if (cur) {
      Object.assign(cur, { 'Төлөв': PST[st], 'Шинэчилсэн': now, 'Бүртгэсэн': by });
      if (!ended) Object.assign(cur, { 'Байгууллага': b.org, 'Хариуцах хүн': b.person || '', 'Утас': tel_(b.tel), 'Имэйл': b.mail || '', 'Дүн': num_(b.price) || cur['Дүн'], 'Бүтээгдэхүүн': b.products || cur['Бүтээгдэхүүн'] });
      writeRow_(SH.PART, cur);
    } else if (!ended) {
      appendRows_(SH.PART, [{ 'Үзэсгэлэн': String(e.name), 'Лангуу': String(b.code), 'Байгууллага': b.org, 'Хариуцах хүн': b.person || '', 'Утас': tel_(b.tel), 'Имэйл': b.mail || '',
        'Бүтээгдэхүүн': b.products || '', 'Төлөв': PST[st], 'Дүн': num_(b.price), 'Захиалсан': now, 'Шинэчилсэн': now, 'Бүртгэсэн': by, expoId: e.id, boothId: b.boothId }]);
    } else return;
    orgSync_(orgKey_(b.tel, b.org));
  } catch (err) { reportError_('оролцогчдын сан', err); }
}
/** Утсыг текстээр хадгална (эхний 0 болон урт тоо алдагдахгүй). */
function tel_(t) { t = String(t || ''); return t ? "'" + t : ''; }

/** Нэг байгууллагын нэгдсэн мөрийг Оролцоо хуудаснаас дахин тооцно. */
function orgSync_(key) {
  const mine = readAll_(SH.PART).filter(r => orgKey_(r['Утас'], r['Байгууллага']) === key);
  if (!mine.length) return;
  const last = mine[mine.length - 1], expos = [], prods = [];
  mine.forEach(r => {
    if (PACTIVE[r['Төлөв']] && expos.indexOf(String(r['Үзэсгэлэн'])) < 0) expos.push(String(r['Үзэсгэлэн']));
    String(r['Бүтээгдэхүүн'] || '').split(' | ').forEach(p => { p = p.trim(); if (p && prods.indexOf(p) < 0) prods.push(p); });
  });
  const pick = k => { for (let i = mine.length - 1; i >= 0; i--) if (String(mine[i][k] || '').trim()) return mine[i][k]; return ''; };
  const all = readAll_(SH.ORG), digits = key.replace(/\D/g, '');
  // Түлхүүрээр, эсвэл screenshot-оор нэмэгдсэн мөрийн нэмэлт утсаар олно
  const o = all.find(x => String(x['Түлхүүр']) === key) || (/^\d{8}$/.test(digits) && key === digits ? all.find(x => String(x['Нэмэлт утас'] || '').indexOf(digits) >= 0) : null);
  const row = Object.assign(o || { 'Түлхүүр': key, 'Анх бүртгэгдсэн': mine[0]['Захиалсан'] || new Date() }, {
    'Байгууллага': last['Байгууллага'], 'Хариуцах хүн': pick('Хариуцах хүн'), 'Имэйл': (o && String(o['Имэйл'] || '').trim()) || pick('Имэйл'),
    'Бүтээгдэхүүн': prods.join(' | '), 'Оролцсон үзэсгэлэн': expos.join(' | '), 'Тоо': expos.length, 'Сүүлд': new Date()
  });
  row['Түлхүүр'] = "'" + String(row['Түлхүүр']);
  if (!o || !String(o['Утас'] || '').trim()) row['Утас'] = tel_(pick('Утас')); else row['Утас'] = tel_(o['Утас']);
  if (!String(row['Эх сурвалж'] || '').trim()) row['Эх сурвалж'] = 'Захиалга';
  if (o) writeRow_(SH.ORG, row); else appendRows_(SH.ORG, [row]);
}

/** Одоо байгаа захиалгуудыг сан руу нэг удаа хуулна (setup()-аас дуудагдана, давхардуулахгүй). */
function backfillParts_() {
  if (readAll_(SH.PART).length) return 0;
  const expos = {}; readAll_(SH.EXPO).forEach(e => { expos[e.id] = e; });
  let n = 0;
  readAll_(SH.BOOTH).forEach(b => { if (BOOKED[b.status] && expos[b.expoId]) { partSave_(expos[b.expoId], b, b.status, String(b.updatedBy || 'систем')); n++; } });
  return n;
}

/* ===================== Нийтийн (оролцогчийн) API ===================== */

/** Нүүр хуудас: нээлттэй болон удахгүй нээгдэх үзэсгэлэнгүүд. Хаагдсан, дууссан нь харагдахгүй. */
function apiList_() {
  return cached_('pub_list', () => apiListRaw_());
}
function apiListRaw_() {
  const today = iso_(new Date()), booths = readAll_(SH.BOOTH);
  const items = readAll_(SH.EXPO).filter(e => (e.status === 'open' || !e.status || e.status === 'draft') && !(iso_(e.end) && iso_(e.end) < today)).map(e => {
    const open = e.status === 'open', bs = open ? booths.filter(b => String(b.expoId) === String(e.id)) : [];
    return { key: String(e.slug || e.id), name: String(e.name), start: iso_(e.start), end: iso_(e.end), place: String(e.place || ''), about: String(e.about || ''), poster: String(e.posterId || ''), open,
      total: bs.length, free: bs.filter(b => !BOOKED[b.status]).length };
  });
  items.sort((a, b) => (b.open - a.open) || String(a.start || '9').localeCompare(String(b.start || '9')));
  return { expos: items };
}

function apiExpo_(req) {
  const key = 'pub_e_' + String(req.e || '').trim().toLowerCase();
  return cached_(key, () => apiExpoRaw_(req));
}
function apiExpoRaw_(req) {
  const e = findExpo_(req.e);
  if (e.status !== 'open') fail_(e.status === 'closed' ? 'Энэ үзэсгэлэнгийн захиалга хаагдсан байна.' : 'Захиалга хараахан нээгдээгүй байна.');
  if (boothsOf_(e.id).some(b => b.status === 'held')) withLock_(() => expireHolds_(e.id));
  const cats = catsOf_(e.id);
  return {
    expo: { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), imageId: e.imageId, imgW: e.imgW, imgH: e.imgH, holdHours: e.holdHours, advancePct: e.advancePct, payInfo: String(e.payInfo || ''), place: String(e.place || ''), about: String(e.about || '') },
    products: productsOf_(e), maxProducts: MAX_PRODUCTS,
    cats: cats.map(c => ({ id: c.catId, name: c.name, color: c.color, price: num_(c.price) })),
    booths: boothsOf_(e.id).map(b => ({
      id: b.boothId, code: String(b.code), x: num_(b.x), y: num_(b.y), w: num_(b.w), h: num_(b.h), m2: num_(b.m2), cat: b.catId,
      status: b.status === 'held' ? 'held' : BOOKED[b.status] ? 'sold' : 'free', price: priceOf_(b, cats)
    })),
    now: Date.now()
  };
}

function apiImage_(req) {
  const id = str_(req.id, 100);
  if (!id || !readAll_(SH.EXPO).some(e => String(e.imageId) === id || String(e.posterId) === id)) fail_('Зураг олдсонгүй.');
  const blob = DriveApp.getFileById(id).getBlob();
  return { data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function apiBook_(req) {
  const org = str_(req.org, 120), person = str_(req.person, 80), tel = str_(req.tel, 20).replace(/[\s-]/g, ''), mail = str_(req.mail, 120);
  if (!org) fail_('Байгууллагын нэрээ оруулна уу.');
  if (!/^\d{8}$/.test(tel)) fail_('8 оронтой утасны дугаар оруулна уу.');
  if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) fail_('Имэйл хаяг буруу байна.');
  const res = withLock_(() => {
    const e = findExpo_(req.e);
    if (e.status !== 'open') fail_('Энэ үзэсгэлэнгийн захиалга нээлттэй биш байна.');
    expireHolds_(e.id);
    const booths = boothsOf_(e.id), cats = catsOf_(e.id);
    const b = booths.find(x => String(x.boothId) === String(req.boothId));
    if (!b) fail_('Лангуу олдсонгүй. Хуудсаа шинэчилнэ үү.');
    if (b.status !== 'free') fail_('Уучлаарай, ' + b.code + ' лангууг сая өөр байгууллага захиаллаа. Өөр лангуу сонгоно уу.');
    if (booths.filter(x => x.status === 'held' && String(x.tel) === tel).length >= MAX_HOLDS_PER_PHONE)
      fail_('Нэг утасны дугаараар төлбөр төлөөгүй ' + MAX_HOLDS_PER_PHONE + '-аас олон лангуу барих боломжгүй. Менежертэй холбогдоно уу.');
    const price = listPrice_(b, cats), products = cleanProducts_(req.products, req.other, e);
    if (productsOf_(e).length && !products) fail_('Юу худалдахаа сонгоно уу.');
    Object.assign(b, { status: 'held', price, org, person, tel, mail, products, heldAt: new Date(), updatedAt: new Date(), updatedBy: 'оролцогч' });
    writeRow_(SH.BOOTH, b);
    partSave_(e, b, 'held', 'оролцогч');
    log_(e.id, b.code, 'захиалсан', 'оролцогч', org + ' ' + tel);
    bump_(e);
    return { e, b, price };
  });
  const adv = Math.round(res.price * res.e.advancePct / 100);
  notify_('ops', '🟨 Шинэ захиалга — ' + res.e.name + '\nЛангуу: ' + res.b.code + ' (' + res.b.m2 + ' м²)\n' + org + (person ? ', ' + person : '') + '\n📞 ' + tel + (mail ? '\n✉️ ' + mail : '') +
    '\nДүн: ' + fmt_(res.price) + '₮, урьдчилгаа ' + fmt_(adv) + '₮\n' + res.e.holdHours + ' цагийн дотор урьдчилгаа орохгүй бол автоматаар суллагдана.', { buttons: tgButtons_(res.e, res.b) });
  return { booking: { code: String(res.b.code), price: res.price, advance: adv, holdHours: res.e.holdHours, org, payInfo: String(res.e.payInfo || '') } };
}

/* ===================== Ажилтны API ===================== */

const PIN_MAX_FAILS = 10, PIN_LOCK_SEC = 900;
function auth_(pin) {
  pin = str_(pin, 20);
  if (!pin) fail_('PIN кодоо оруулна уу.');
  const cache = CacheService.getScriptCache();
  if (cache.get('pin_lock')) fail_('PIN олон удаа буруу оруулсан тул нэвтрэлтийг 15 минут түр хаасан. Дараа дахин оролдоно уу.');
  const same = x => String(x.pin).trim() === pin || (/^\d+$/.test(pin) && /^\d+$/.test(String(x.pin).trim()) && Number(x.pin) === Number(pin));
  const s = readAll_(SH.STAFF).find(x => same(x) && String(x.active).toLowerCase() !== 'false' && String(x.active) !== 'үгүй');
  if (!s) {
    Utilities.sleep(800);
    const n = num_(cache.get('pin_fails')) + 1;
    if (n >= PIN_MAX_FAILS) {
      cache.put('pin_lock', '1', PIN_LOCK_SEC); cache.remove('pin_fails');
      notify_('tech', '🔐 PIN ' + PIN_MAX_FAILS + ' удаа буруу оруулсан тул ажилтны нэвтрэлтийг 15 минут хаалаа. Хэн нэгэн таах оролдлого хийж байж магадгүй.');
    } else cache.put('pin_fails', String(n), PIN_LOCK_SEC);
    fail_('PIN код буруу байна.');
  }
  return { name: String(s.name), role: role_(s.role) };
}

/** Ажилтан хуудасны role утгыг system / admin / staff болгоно. */
function role_(r) {
  r = String(r || '').trim().toLowerCase();
  if (['system', 'систем', 'систем админ', 'dev'].indexOf(r) >= 0) return 'system';
  if (['admin', 'захирал', 'director'].indexOf(r) >= 0) return 'admin';
  return 'staff';
}
const isBoss_ = who => who.role === 'system' || who.role === 'admin';
function needBoss_(who) { if (!isBoss_(who)) fail_('Энэ үйлдлийг зөвхөн захирал хийх эрхтэй.'); }
const ROLE_NAME = { system: 'Систем админ', admin: 'Захирал', staff: 'Менежер' };

function apiLogin_(req, who) { return { user: who }; }

function apiExpos_() {
  const booths = readAll_(SH.BOOTH);
  return {
    templates: templates_(),
    expos: readAll_(SH.EXPO).map(e => {
      const bs = booths.filter(b => String(b.expoId) === String(e.id));
      return { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), status: e.status || 'draft', slug: String(e.slug || ''), booths: bs.length, booked: bs.filter(b => BOOKED[b.status]).length, hasImage: !!e.imageId };
    }).reverse()
  };
}

function apiCreateExpo_(req, who) {
  const name = str_(req.name, 120);
  if (!name) fail_('Үзэсгэлэнгийн нэрийг оруулна уу.');
  const id = uid_(), template = tpl_(req.template);
  withLock_(() => { const slug = slug_(req.slug, id); appendRows_(SH.EXPO, [{ id, name, slug, template, place: str_(req.place, 120), start: str_(req.start, 20), end: str_(req.end, 20), status: 'draft', holdHours: 48, advancePct: 50, createdAt: new Date() }]); });
  log_(id, '', 'үзэсгэлэн үүсгэсэн', who.name, name);
  bump_(null);
  return { id };
}

/** Загварын нэрийг шалгана. Хоосон бол '' (бүтээгдэхүүн асуухгүй). */
function tpl_(v) {
  const t = str_(v, 120);
  if (t && templates_().indexOf(t) < 0) fail_('"' + t + '" загвар олдсонгүй. Бүтээгдэхүүн хуудсыг шалгана уу.');
  return t;
}

function apiUpdateExpo_(req, who) {
  needBoss_(who);
  return withLock_(() => {
    const e = findExpo_(req.id);
    if (req.name !== undefined) e.name = str_(req.name, 120) || e.name;
    if (req.start !== undefined) e.start = str_(req.start, 20);
    if (req.end !== undefined) e.end = str_(req.end, 20);
    if (req.holdHours !== undefined) e.holdHours = Math.max(1, Math.min(240, num_(req.holdHours, 48)));
    if (req.slug !== undefined) e.slug = slug_(req.slug, e.id);
    if (req.place !== undefined) e.place = str_(req.place, 120);
    if (req.about !== undefined) e.about = str_(req.about, 600);
    if (req.payInfo !== undefined) e.payInfo = str_(req.payInfo, 200);
    if (req.template !== undefined) e.template = tpl_(req.template);
    if (req.advancePct !== undefined) e.advancePct = Math.max(0, Math.min(100, num_(req.advancePct, 50)));
    if (req.status !== undefined) {
      if (!{ draft: 1, open: 1, closed: 1 }[req.status]) fail_('Төлөв буруу.');
      if (req.status === 'open') {
        const bs = boothsOf_(e.id);
        if (!e.imageId || !bs.length) fail_('Эхлээд талбайн зураг оруулж, лангуунуудыг хадгална уу.');
        const cats = catsOf_(e.id);
        const noPrice = bs.filter(b => !listPrice_(b, cats)).map(b => b.code);
        if (noPrice.length) fail_('Үнэгүй лангуу байна: ' + noPrice.slice(0, 8).join(', ') + (noPrice.length > 8 ? '…' : '') + '. м² болон салбарын үнийг шалгана уу.');
      }
      e.status = req.status;
      log_(e.id, '', 'төлөв: ' + req.status, who.name, '');
    }
    writeRow_(SH.EXPO, e);
    bump_(e);
    return { expo: { id: e.id, status: e.status } };
  });
}

function apiStaffExpo_(req) {
  const e = findExpo_(req.id);
  if (boothsOf_(e.id).some(b => b.status === 'held')) withLock_(() => expireHolds_(e.id));
  const cats = catsOf_(e.id);
  return {
    expo: { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), imageId: e.imageId, imgW: e.imgW, imgH: e.imgH, status: e.status || 'draft', slug: String(e.slug || ''), place: String(e.place || ''), about: String(e.about || ''), holdHours: e.holdHours, advancePct: e.advancePct, payInfo: String(e.payInfo || ''), posterId: String(e.posterId || ''), template: String(e.template || '') },
    products: productsOf_(e), templates: templates_(), maxProducts: MAX_PRODUCTS,
    cats: cats.map(c => ({ id: c.catId, name: c.name, color: c.color, price: num_(c.price) })),
    booths: boothsOf_(e.id).map(b => ({
      id: b.boothId, code: String(b.code), x: num_(b.x), y: num_(b.y), w: num_(b.w), h: num_(b.h), m2: num_(b.m2), cat: b.catId, status: b.status || 'free',
      price: priceOf_(b, cats), org: b.org, person: b.person, tel: String(b.tel || ''), mail: b.mail, products: String(b.products || ''),
      heldAt: b.heldAt instanceof Date ? b.heldAt.getTime() : (Date.parse(b.heldAt) || null), updatedBy: b.updatedBy
    })),
    now: Date.now(), layoutVer: layoutVer_(cats, boothsOf_(e.id))
  };
}

function folder_() {
  const id = prop_('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Үзэсгэлэнгийн талбайн зургууд');
  setProp_('FOLDER_ID', f.getId());
  return f;
}

function apiUploadImage_(req, who) {
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(req.data || ''));
  if (!m) fail_('Зураг буруу байна. JPG эсвэл PNG зураг оруулна уу.');
  const bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > 6 * 1024 * 1024) fail_('Зураг хэт том байна.');
  return withLock_(() => {
    const e = findExpo_(req.id);
    if (boothsOf_(e.id).some(b => BOOKED[b.status])) fail_('Захиалгатай лангуу байгаа тул зургийг солих боломжгүй.');
    const file = folder_().createFile(Utilities.newBlob(bytes, m[1], 'talbai-' + e.id + '-' + Date.now() + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2])));
    const old = e.imageId;
    e.imageId = file.getId(); e.imgW = num_(req.w); e.imgH = num_(req.h);
    writeRow_(SH.EXPO, e);
    replaceExpoRows_(SH.BOOTH, e.id, []);
    if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (x) {} }
    log_(e.id, '', 'зураг оруулсан', who.name, '');
    return { imageId: e.imageId };
  });
}

/** Үзэсгэлэнгийн постер (нүүр хуудсанд харагдана). data хоосон бол устгана. Зөвхөн захирал. */
function apiPoster_(req, who) {
  needBoss_(who);
  let bytes = null, m = null;
  if (req.data) {
    m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(req.data));
    if (!m) fail_('Зураг буруу байна. JPG эсвэл PNG зураг оруулна уу.');
    bytes = Utilities.base64Decode(m[3]);
    if (bytes.length > 1.5 * 1024 * 1024) fail_('Зураг хэт том байна.');
  }
  return withLock_(() => {
    const e = findExpo_(req.id), old = String(e.posterId || '');
    e.posterId = bytes ? folder_().createFile(Utilities.newBlob(bytes, m[1], 'poster-' + e.id + '-' + Date.now() + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]))).getId() : '';
    sheet_(SH.EXPO).getRange(1, 1, 1, COLS[SH.EXPO].length).setValues([COLS[SH.EXPO]]); // шинэ баганын гарчиг
    writeRow_(SH.EXPO, e);
    if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (x) {} }
    log_(e.id, '', bytes ? 'постер оруулсан' : 'постер устгасан', who.name, '');
    bump_(e);
    return { posterId: e.posterId };
  });
}

const DETECT_PROMPT =
  'Энэ бол үзэсгэлэнгийн талбайн (floor plan) зураг. Түрээслэх БҮХ лангууг ол: дугаар бичигдсэн тэгш өнцөгт хэсэг бүр нэг лангуу. ' +
  'Тайз, суудал, шат, хаалга, гарц, багана, тусгай тохижилт, лого, гарчиг, тайлбар (legend) зэргийг бүү оруул. Нэг ч лангууг бүү алгас, давхардуулж бүү бич. ' +
  'Хуваагдсан лангууг (жишээ нь B6-1, B6-2) тус тусад нь бич.\n' +
  'Зөвхөн дараах JSON-ыг, өөр үггүйгээр буцаа:\n' +
  '{"categories":[["Брэнд талбай","#2F6FE0"]],"booths":[["A1",9,0,48.2,19.1,3.4,6.2]]}\n' +
  'categories: зураг дээрх өнгөний тайлбарын [нэр, hex өнгө] жагсаалт. Тайлбар байхгүй бол хоосон.\n' +
  'booths: [дугаар, м², ангиллын индекс, x, y, w, h]. м² нь лангуун дээр бичигдсэн тоо, байхгүй бол null. ' +
  'Ангиллын индекс нь categories дотрох байрлал (0-ээс), лангууны өнгө эсвэл тайлбар дээрх дугаарын мужаар (жишээ нь C1–C33) тодорхойлно; мэдэхгүй бол null. ' +
  'x, y = лангууны зүүн дээд булан; w, h = өргөн, өндөр. x, w нь зургийн өргөний, y, h нь зургийн өндрийн ХУВЬ (0–100), аравтын нэг оронтой.';

function apiDetect_(req, who) {
  const key = prop_('CLAUDE_API_KEY');
  if (!key) fail_('Зураг таних тохиргоо хийгдээгүй байна. Лангуунуудыг "+ Лангуу нэмэх"-ээр гараар тэмдэглэнэ үү.');
  const e = findExpo_(req.id);
  if (!e.imageId) fail_('Эхлээд талбайн зураг оруулна уу.');
  if (boothsOf_(e.id).some(b => BOOKED[b.status])) fail_('Захиалгатай лангуу байгаа тул дахин танихгүй. Гараар засна уу.');
  const blob = DriveApp.getFileById(e.imageId).getBlob();
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: prop_('CLAUDE_MODEL') || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } },
        { type: 'text', text: DETECT_PROMPT }
      ] }]
    })
  });
  const code = resp.getResponseCode();
  if (code !== 200) {
    reportError_('detect', new Error('Claude API ' + code + ': ' + resp.getContentText().slice(0, 300)));
    if (/credit balance/i.test(resp.getContentText())) { notify_('tech', '💳 Claude API кредит дууссан байна. console.anthropic.com → Billing хэсгээс цэнэглэнэ үү.'); fail_('Зураг таних үйлчилгээний төлбөр дууссан байна. Системийн админд мэдэгдлээ. Түр хугацаанд гараар тэмдэглэнэ үү.'); }
    fail_(code === 401 ? 'Зураг таних түлхүүр буруу байна. Системийн админд хандана уу.' : code === 429 || code === 529 ? 'Зураг таних үйлчилгээ завгүй байна. Хэдэн минутын дараа дахин оролдоно уу.' : 'Зургийг таньж чадсангүй. Дахин оролдох эсвэл гараар тэмдэглэнэ үү.');
  }
  const text = (JSON.parse(resp.getContentText()).content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = parseDetect_(text);
  if (!parsed.booths.length) fail_('Зураг дээрээс лангуу олдсонгүй. Илүү тод зураг оруулах эсвэл гараар тэмдэглэнэ үү.');
  withLock_(() => {
    if (boothsOf_(e.id).some(b => BOOKED[b.status])) fail_('Энэ хооронд захиалга орсон тул хадгалсангүй.');
    replaceExpoRows_(SH.CAT, e.id, parsed.cats.map(c => ({ expoId: e.id, catId: c.id, name: c.name, color: c.color, price: c.price })));
    replaceExpoRows_(SH.BOOTH, e.id, parsed.booths.map(b => Object.assign({ expoId: e.id, boothId: b.id, status: 'free', updatedAt: new Date(), updatedBy: 'автомат таних' }, b)));
  });
  log_(e.id, '', 'автоматаар таньсан', who.name, parsed.booths.length + ' лангуу');
  return { found: parsed.booths.length };
}

function parseDetect_(text) {
  let j = null;
  const tryParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  j = tryParse(text);
  if (!j) { const f = /```(?:json)?\s*([\s\S]*?)```/.exec(text); if (f) j = tryParse(f[1]); }
  if (!j) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) j = tryParse(text.slice(a, b + 1)); }
  if (!j || !Array.isArray(j.booths)) return { cats: [], booths: [] };
  const cats = (Array.isArray(j.categories) ? j.categories : []).map((c, i) => {
    const name = str_(Array.isArray(c) ? c[0] : c && c.name, 60), color = str_(Array.isArray(c) ? c[1] : c && c.color, 9);
    return { id: 'c' + i, name: name || ('Салбар ' + (i + 1)), color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : PALETTE[i % PALETTE.length], price: 0 };
  });
  if (!cats.length) cats.push({ id: 'c0', name: 'Ерөнхий', color: PALETTE[0], price: 0 });
  const seen = {}, clamp = v => Math.max(0, Math.min(100, Math.round(num_(v) * 100) / 100)), booths = [];
  j.booths.forEach(r => {
    const a = Array.isArray(r) ? r : [r.code, r.m2, r.category, r.x, r.y, r.w, r.h];
    let code = str_(a[0], 12).toUpperCase();
    if (!code) return;
    if (seen[code]) { let k = 2; while (seen[code + '-' + k]) k++; code = code + '-' + k; }
    seen[code] = 1;
    const w = clamp(a[5]), h = clamp(a[6]);
    if (w < 0.3 || h < 0.3) return;
    const ci = Number.isInteger(Number(a[2])) && cats[Number(a[2])] ? Number(a[2]) : 0;
    booths.push({ id: uid_(), code, m2: num_(a[1]) > 0 ? num_(a[1]) : '', catId: cats[ci].id, x: clamp(a[3]), y: clamp(a[4]), w, h });
  });
  return { cats, booths };
}

function apiSaveBooths_(req, who) {
  const inB = Array.isArray(req.booths) ? req.booths : [], inC = Array.isArray(req.cats) ? req.cats : [];
  if (inB.length > 2000) fail_('Лангуу хэт олон байна.');
  return withLock_(() => {
    const e = findExpo_(req.id), cur = boothsOf_(e.id), byId = {};
    cur.forEach(b => { byId[b.boothId] = b; });
    const curCats = catsOf_(e.id).map(c => { const o = Object.assign({}, c); delete o._row; return o; });
    // Менежер салбар, үнийг өөрчлөх эрхгүй: серверт байгааг нь хэвээр үлдээнэ
    if (req.baseVer && String(req.baseVer) !== layoutVer_(curCats, cur)) {
      const last = readAll_(SH.LOG).filter(l => String(l.expoId) === String(e.id) && /талбай хадгалсан|автоматаар таньсан|зураг оруулсан/.test(l.action)).pop();
      const who2 = last ? last.by + (last.time instanceof Date ? ' (' + Utilities.formatDate(last.time, Session.getScriptTimeZone(), 'HH:mm') + ')' : '') : 'Өөр хүн';
      fail_('CONFLICT: Энэ хооронд ' + who2 + ' талбайн зургийг хадгалсан байна. Таны өөрчлөлт хадгалагдсангүй.');
    }
    const cats = !isBoss_(who) && curCats.length ? curCats
      : inC.map((c, i) => ({ expoId: e.id, catId: str_(c.id, 20) || ('c' + i), name: str_(c.name, 60) || ('Салбар ' + (i + 1)), color: str_(c.color, 9) || PALETTE[i % PALETTE.length], price: isBoss_(who) ? Math.max(0, num_(c.price)) : 0 }));
    if (!cats.length) fail_('Дор хаяж нэг салбар байх ёстой.');
    const catIds = {}; cats.forEach(c => { catIds[c.catId] = 1; });
    const codes = {}, out = [];
    inB.forEach(x => {
      const old = byId[x.id], code = str_(x.code, 12).toUpperCase();
      if (!code) fail_('Дугааргүй лангуу байна.');
      if (codes[code]) fail_(code + ' дугаар давхардсан байна.');
      codes[code] = 1;
      if (old && BOOKED[old.status]) {
        // Захиалгатай лангууны байршил, хэмжээ, үнэ, захиалагчийн мэдээлэл өөрчлөгдөхгүй
        out.push(Object.assign({}, old, { code: old.code }));
        if (String(old.code) !== code) fail_(old.code + ' захиалгатай тул дугаарыг нь өөрчлөх боломжгүй.');
        return;
      }
      out.push({
        expoId: e.id, boothId: old ? old.boothId : (str_(x.id, 20) || uid_()), code,
        x: num_(x.x), y: num_(x.y), w: num_(x.w), h: num_(x.h), m2: num_(x.m2) > 0 ? num_(x.m2) : '',
        catId: catIds[x.cat] ? x.cat : cats[0].catId, status: 'free', updatedAt: new Date(), updatedBy: who.name
      });
    });
    const missing = cur.filter(b => BOOKED[b.status] && !out.some(o => String(o.boothId) === String(b.boothId)));
    if (missing.length) fail_(missing.map(b => b.code).join(', ') + ' захиалгатай тул устгах боломжгүй.');
    replaceExpoRows_(SH.CAT, e.id, cats);
    replaceExpoRows_(SH.BOOTH, e.id, out.map(o => { const c = Object.assign({}, o); delete c._row; return c; }));
    log_(e.id, '', 'талбай хадгалсан', who.name, out.length + ' лангуу');
    bump_(e);
    return { saved: out.length };
  });
}

function apiSetStatus_(req, who) {
  const r = changeStatus_(req, who);
  statusNotify_(r, who);
  return { status: r.st };
}

/** Лангууны төлөвийг өөрчилнө (ажилтны хуудас болон Telegram товч хоёулаа үүнийг ашиглана). */
function changeStatus_(req, who) {
  const st = String(req.status || '');
  if (!{ free: 1, held: 1, adv: 1, paid: 1 }[st]) fail_('Төлөв буруу.');
  const r = withLock_(() => {
    const e = findExpo_(req.id), cats = catsOf_(e.id);
    const b = boothsOf_(e.id).find(x => String(x.boothId) === String(req.boothId));
    if (!b) fail_('Лангуу олдсонгүй.');
    const prev = b.status || 'free';
    if (req.expect && String(req.expect) !== prev) fail_(b.code + ' лангууны төлөвийг сая өөр хүн өөрчилсөн байна (одоо: ' + ({ free: 'Сул', held: 'Түр барьсан', adv: 'Урьдчилгаа төлсөн', paid: 'Бүрэн төлсөн' }[prev]) + '). Мэдээлэл шинэчлэгдлээ, дахин шалгана уу.');
    if (st === 'free') {
      if (prev === 'free') return { e, b, prev, same: true };
      const org = b.org; partSave_(e, b, 'free', who.name); clearBooking_(b); b.updatedAt = new Date(); b.updatedBy = who.name; writeRow_(SH.BOOTH, b);
      log_(e.id, b.code, 'цуцалсан', who.name, org); return { e, b, prev, org };
    }
    if (prev === 'free') {
      const org = str_(req.org, 120), tel = str_(req.tel, 20).replace(/[\s-]/g, '');
      if (!org) fail_('Байгууллагын нэрийг оруулна уу.');
      if (tel && !/^\d{8}$/.test(tel)) fail_('Утасны дугаар 8 оронтой байх ёстой.');
      Object.assign(b, { org, person: str_(req.person, 80), tel, mail: str_(req.mail, 120), price: listPrice_(b, cats), products: cleanProducts_(req.products, req.other, e) });
      if (st === 'held') b.heldAt = new Date();
    }
    b.status = st; if (st !== 'held') b.heldAt = b.heldAt || '';
    b.updatedAt = new Date(); b.updatedBy = who.name; writeRow_(SH.BOOTH, b);
    partSave_(e, b, st, who.name);
    log_(e.id, b.code, { held: 'түр барьсан', adv: 'урьдчилгаа орсон', paid: 'бүрэн төлсөн' }[st], who.name, b.org);
    return { e, b, prev };
  });
  bump_(r.e);
  r.st = st;
  return r;
}

function statusNotify_(r, who, skipChat) {
  if (r.same) return;
  const t = { free: '⬜ Цуцлагдсан', held: '🟨 Утсаар захиалга', adv: '🟧 Урьдчилгаа орсон', paid: '🟥 Бүрэн төлсөн' }[r.st];
  notify_('ops', t + ' — ' + r.e.name + '\nЛангуу: ' + r.b.code + '\n' + (r.org || r.b.org || '') + (r.b.tel ? '\n📞 ' + r.b.tel : '') + '\nБүртгэсэн: ' + who.name + ' (' + ROLE_NAME[who.role] + ')',
    { buttons: tgButtons_(r.e, r.b), skip: skipChat });
}

/* ===================== Тайлан (захирал) ===================== */

/** Бүх үзэсгэлэнгийн лангуу, захиалга, мөнгөн дүн — тайлангийн хуудсанд нэг хүсэлтээр. */
function apiReport_(req, who) {
  needBoss_(who);
  const now = Date.now(), cats = readAll_(SH.CAT), booths = readAll_(SH.BOOTH);
  const expos = readAll_(SH.EXPO).map(e => ({ id: String(e.id), name: String(e.name), start: iso_(e.start), end: iso_(e.end), status: e.status || 'draft', hold: num_(e.holdHours, 48) || 48, adv: num_(e.advancePct, 50) || 50 }));
  const byId = {}; expos.forEach(e => { byId[e.id] = e; });
  const out = [];
  booths.forEach(b => {
    const e = byId[String(b.expoId)]; if (!e) return;
    const cs = cats.filter(c => String(c.expoId) === e.id);
    let st = b.status || 'free', dl = 0;
    if (st === 'held') { const t = heldMs_(b); dl = t ? t + e.hold * 3600e3 : 0; if (dl && dl <= now) st = 'free'; }
    const p = st === 'free' ? listPrice_(b, cs) : priceOf_(b, cs);
    const got = st === 'paid' ? p : st === 'adv' ? Math.round(p * e.adv / 100) : 0;
    const r = { e: e.id, id: String(b.boothId), code: String(b.code), m2: num_(b.m2), cat: String(b.catId), st, price: p, got };
    if (st !== 'free') Object.assign(r, { org: String(b.org || ''), person: String(b.person || ''), tel: String(b.tel || ''), mail: String(b.mail || ''), dl: st === 'held' ? dl : 0,
      by: String(b.updatedBy || ''), at: b.updatedAt instanceof Date ? b.updatedAt.getTime() : (Date.parse(b.updatedAt) || 0) });
    out.push(r);
  });
  return { expos, cats: cats.map(c => ({ e: String(c.expoId), id: String(c.catId), name: String(c.name), color: String(c.color) })), booths: out, now };
}

/* ===================== Ажилтан удирдах ===================== */

function apiStaffList_(req, who) {
  needBoss_(who);
  return { staff: readAll_(SH.STAFF).map(s => {
    const r = role_(s.role), hide = r === 'system' && who.role !== 'system';
    return { row: s._row, name: String(s.name), role: r, pin: hide ? '' : String(s.pin), active: String(s.active).toLowerCase() !== 'false' && String(s.active) !== 'үгүй', locked: hide };
  }) };
}

function apiStaffSave_(req, who) {
  needBoss_(who);
  const name = str_(req.name, 60), pin = str_(req.staffPin, 20), role = role_(req.role), active = req.active !== false;
  if (!name) fail_('Нэрийг оруулна уу.');
  if (!/^\d{4,8}$/.test(pin)) fail_('PIN нь 4–8 оронтой тоо байна.');
  if (role === 'system' && who.role !== 'system') fail_('Систем админ эрхийг зөвхөн систем админ олгоно.');
  return withLock_(() => {
    const all = readAll_(SH.STAFF), row = num_(req.row), cur = row ? all.find(s => s._row === row) : null;
    if (row && !cur) fail_('Ажилтан олдсонгүй. Хуудсаа шинэчилнэ үү.');
    if (cur && role_(cur.role) === 'system' && who.role !== 'system') fail_('Систем админы мэдээллийг өөрчлөх эрхгүй.');
    if (all.some(s => s !== cur && Number(s.pin) === Number(pin))) fail_('Энэ PIN өөр ажилтанд олгогдсон байна. Өөр PIN сонгоно уу.');
    if (cur && cur.name === who.name && (!active || role !== role_(cur.role))) fail_('Өөрийнхөө эрхийг өөрчлөх, идэвхгүй болгох боломжгүй.');
    const o = { name, pin: "'" + pin, role, active: active ? 'тийм' : 'үгүй' };
    if (cur) { Object.assign(cur, o); if (cur.tg) cur.tg = "'" + String(cur.tg); writeRow_(SH.STAFF, cur); } else appendRows_(SH.STAFF, [o]);
    staffCacheClear_();
    log_('', '', cur ? 'ажилтан засварласан' : 'ажилтан нэмсэн', who.name, name + ' (' + ROLE_NAME[role] + (active ? '' : ', идэвхгүй') + ')');
    return { saved: true };
  });
}

/* ===================== Мэдэгдэл, тайлан ===================== */

/**
 * Telegram мэдэгдэл. Хэнд очих нь:
 *   ops    — менежерийн групп + захирал (захиалга, төлбөр, цуцлалт, суллагдсан)
 *   report — захирал (санхүүгийн тайлан); захирлын чат тохируулаагүй бол систем админ
 *   tech   — систем админ (алдаа); тохируулаагүй бол захирал
 */
function notify_(kind, text, opt) {
  if (!prop_('TELEGRAM_TOKEN')) return;
  opt = opt || {};
  const g = ids_('TELEGRAM_CHAT'), d = ids_('TELEGRAM_DIRECTOR'), a = ids_('TELEGRAM_ADMIN');
  const to = kind === 'ops' ? g.concat(d) : kind === 'report' ? (d.length ? d : a) : kind === 'tech' ? (a.length ? a : d) : g.concat(d, a);
  to.filter((c, i) => c && to.indexOf(c) === i && String(c) !== String(opt.skip || '')).forEach(chat => {
    tgSend_(chat, text, opt.buttons && opt.buttons.length ? { inline_keyboard: opt.buttons } : null);
  });
}

function reportError_(where, err) {
  try {
    console.error(where, err && err.stack || err);
    const c = CacheService.getScriptCache(), k = 'err_' + where;
    if (c.get(k)) return;
    c.put(k, '1', 600);
    notify_('tech', '⚠️ Системийн алдаа (' + where + '): ' + String(err && err.message || err).slice(0, 300));
  } catch (e) {}
}

/** Цаг тутам: хугацаа дууссан түр захиалгыг суллана. */
function hourlyJob() {
  try { hourlyJobRaw_(); } catch (e) { reportError_('цаг тутмын шалгалт', e); }
}
function hourlyJobRaw_() {
  const freed = withLock_(() => expireHolds_());
  if (!freed.length) return;
  const names = {}; readAll_(SH.EXPO).forEach(e => { names[e.id] = e.name; });
  notify_('ops', '⏰ Урьдчилгаа ороогүй тул суллагдсан:\n' + freed.map(f => '• ' + f.code + ' — ' + (f.org || '') + ' (' + (names[f.expoId] || '') + ')').join('\n'));
}

/** Өдөр бүр: нээлттэй үзэсгэлэн бүрийн товч тайлан. */
function dailyReport() {
  try { dailyReportRaw_(); } catch (e) { reportError_('өглөөний тайлан', e); }
}
function dailyReportRaw_() {
  const expos = readAll_(SH.EXPO).filter(e => e.status === 'open');
  if (!expos.length) return;
  const now = Date.now(), lines = [];
  expos.forEach(e => {
    const cats = catsOf_(e.id), bs = boothsOf_(e.id), hold = (num_(e.holdHours, 48) || 48) * 3600e3, adv = (num_(e.advancePct, 50) || 50) / 100;
    let total = 0, got = 0, booked = 0;
    const soon = [];
    bs.forEach(b => {
      const p = priceOf_(b, cats); total += p;
      if (BOOKED[b.status]) booked++;
      if (b.status === 'adv') got += p * adv;
      if (b.status === 'paid') got += p;
      if (b.status === 'held') { const t = b.heldAt instanceof Date ? b.heldAt.getTime() : Date.parse(b.heldAt); if (t && t + hold - now < 24 * 3600e3) soon.push(b.code + ' (' + (b.org || '') + ')'); }
    });
    const due = bs.filter(b => BOOKED[b.status]).reduce((s, b) => s + priceOf_(b, cats), 0) - got;
    lines.push('📊 ' + e.name + '\nЗахиалагдсан: ' + booked + '/' + bs.length + ' (' + (bs.length ? Math.round(booked / bs.length * 100) : 0) + '%)\n' +
      'Орсон төлбөр: ' + fmt_(got) + '₮\nАвлага: ' + fmt_(due) + '₮\nБоломжит орлого: ' + fmt_(total) + '₮' +
      (soon.length ? '\n⏳ 24 цагт барьцаа дуусах: ' + soon.join(', ') : ''));
  });
  notify_('report', 'Өглөөний тайлан\n\n' + lines.join('\n\n'));
}

/* ===================== Долоо хоног бүрийн нөөц ===================== */

const BACKUP_KEEP = 8; // хэдэн долоо хоногийн хуулбар хадгалах
const BACKUP_SHEETS = [SH.ORG, SH.PART];

/** Нөөцийн файл (байхгүй эсвэл устсан бол шинээр үүсгэнэ, үндсэн файлтай нэг хавтсанд). */
function backupFile_() {
  const id = prop_('BACKUP_ID');
  if (id) { try { const f = SpreadsheetApp.openById(id); if (!DriveApp.getFileById(id).isTrashed()) return f; } catch (e) {} }
  const f = SpreadsheetApp.create('Оролцогчдын сан — нөөц');
  try {
    const parents = DriveApp.getFileById(ss_().getId()).getParents();
    if (parents.hasNext()) DriveApp.getFileById(f.getId()).moveTo(parents.next());
  } catch (e) {}
  setProp_('BACKUP_ID', f.getId());
  return f;
}

/**
 * Ням гараг бүр: Оролцогчид, Оролцоо хуудсыг "Оролцогчдын сан — нөөц" файл руу огноотой нэрээр хуулна.
 * Сүүлийн BACKUP_KEEP долоо хоногийнх үлдэж, хуучин нь устна. Гараар ч ажиллуулж болно.
 */
function weeklyBackup() {
  try { weeklyBackupRaw_(); } catch (e) { reportError_('долоо хоногийн нөөц', e); }
}
function weeklyBackupRaw_() {
  const dst = backupFile_(), day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), counts = [];
  BACKUP_SHEETS.forEach(name => {
    const src = ss_().getSheetByName(name);
    if (!src) return;
    const title = name + ' ' + day, old = dst.getSheetByName(title), copy = src.copyTo(dst);
    if (old) dst.deleteSheet(old); // нэг өдөр дахин ажиллуулбал солино
    copy.setName(title);
    counts.push(name + ' ' + Math.max(0, src.getLastRow() - 1));
    // Хуучин хуулбаруудыг цэвэрлэнэ (огноогоор эрэмбэлж, сүүлийн BACKUP_KEEP-ийг үлдээнэ)
    const mine = dst.getSheets().filter(sh => sh.getName().indexOf(name + ' ') === 0).map(sh => sh.getName()).sort();
    mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP)).forEach(n => dst.deleteSheet(dst.getSheetByName(n)));
  });
  // Анх үүсэхэд гарсан хоосон хуудсыг устгана
  dst.getSheets().forEach(sh => { if (dst.getSheets().length > 1 && BACKUP_SHEETS.every(n => sh.getName().indexOf(n + ' ') !== 0) && sh.getLastRow() === 0) dst.deleteSheet(sh); });
  if (!counts.length) return;
  console.log('Нөөц хадгалагдлаа: ' + counts.join(', ') + ' мөр → ' + dst.getUrl());
  notify_('tech', '💾 Оролцогчдын сангийн долоо хоногийн нөөц хадгалагдлаа (' + day + ')\n' + counts.join(' · ') + ' мөр\n' + dst.getUrl());
}

/* ===================== Анхны тохиргоо ===================== */

/** Анхны бүтээгдэхүүний жагсаалт (Бүтээгдэхүүн хуудас хоосон үед setup() нэг удаа бичнэ). */
const SEED_SECTORS = {"food": "Хүнс, бэлэг, үндэсний бүтээгдэхүүн", "build": "Барилга, үл хөдлөх, интерьер", "fashion": "Үнэт эдлэл, гоо сайхан, хувцас загвар", "travel": "Аялал, спорт, гадаа амралт", "health": "Эрүүл мэнд, эм, тоног төхөөрөмж", "auto": "Авто, сэлбэг, засвар үйлчилгээ", "fin": "Банк, даатгал, санхүү", "tech": "Технологи, харилцаа холбоо", "other": "Бусад үйлчилгээ"};
const SEED_PRODUCTS = [
  ["11.11 BAZAAR EXPO", [["👗", "Хувцас, гутал", "fashion"], ["🐐", "Ноос, ноолуур, арьс шир", "fashion"], ["💄", "Гоо сайхан, арьс арчилгаа", "fashion"], ["💍", "Үнэт эдлэл, цаг, гоёл чимэглэл", "fashion"], ["🥫", "Хүнс, ундаа", "food"], ["🏠", "Гэр ахуй, сав суулга", "build"], ["🛋️", "Тавилга, интерьер", "build"], ["📱", "Цахилгаан бараа, гар утас", "tech"], ["🧸", "Хүүхдийн бараа, тоглоом", "other"], ["⚽", "Спорт, аялал", "travel"], ["🎁", "Бэлэг, гар урлал", "food"], ["💊", "Эрүүл мэнд, нэмэлт тэжээл", "health"]]],
  ["Монгол өв соёл — Цагаан сар", [["🧥", "Дээл, үндэсний хувцас", "fashion"], ["🐐", "Ноос, ноолуур, арьс шир", "fashion"], ["🥟", "Мах, бууз банш, махан бүтээгдэхүүн", "food"], ["🍰", "Ул боов, чихэр, амттан", "food"], ["🥛", "Сүү, цагаан идээ", "food"], ["🍶", "Ундаа, архи, дарс", "food"], ["🎁", "Бэлэг, бэлгийн багц", "food"], ["💍", "Үнэт эдлэл, мөнгөн аяга, хөөрөг", "fashion"], ["🎨", "Гар урлал, урлагийн бүтээл", "food"], ["💄", "Гоо сайхан, арьс арчилгаа", "fashion"], ["🏠", "Гэр ахуй, сав суулга", "build"], ["📅", "Хуанли, ном, зурхай", "other"]]],
  ["Property Expo", [["🏢", "Шинэ орон сууц", "build"], ["🏡", "Хаус, зуслан", "build"], ["🏦", "Ипотек, банкны зээл", "fin"], ["🤝", "Үл хөдлөхийн агент", "build"], ["🛋️", "Интерьер, тавилга", "build"], ["🧱", "Барилгын материал", "build"], ["🚪", "Цонх, хаалга", "build"], ["🔥", "Халаалт, сантехник, цахилгаан", "build"], ["📹", "Ухаалаг гэр, хамгаалалтын камер", "tech"], ["🛡️", "Даатгал", "fin"]]],
  ["Mongolia Jewellery Expo", [["🥇", "Алтан эдлэл", "fashion"], ["🥈", "Мөнгөн эдлэл", "fashion"], ["💎", "Үнэт чулуу", "fashion"], ["💍", "Сүйн, хуримын бөгж", "fashion"], ["✋", "Гар хийцийн чимэглэл", "fashion"], ["🏺", "Үндэсний чимэглэл, хөөрөг", "fashion"], ["⌚", "Цаг", "fashion"], ["🔍", "Сорьцын баталгаа, үнэлгээ", "other"], ["🔧", "Засвар, арчилгаа", "other"]]],
  ["Summer & Travel Expo", [["⛺", "Майхан, кемпинг", "travel"], ["👟", "Спорт хувцас, гутал", "travel"], ["🚲", "Дугуй, скүүтер", "travel"], ["🎣", "Загас агнуур, ан", "travel"], ["🏄", "Усан спорт", "travel"], ["✈️", "Аялал жуулчлалын компани", "travel"], ["🏕️", "Амралтын газар", "travel"], ["🛡️", "Аяллын даатгал", "fin"], ["☀️", "Нарнаас хамгаалах, гоо сайхан", "fashion"]]],
  ["National Naadam Expo", [["🧥", "Үндэсний хувцас", "fashion"], ["🐐", "Ноос, ноолуур", "fashion"], ["🎁", "Бэлэг дурсгал, гар урлал", "food"], ["🥟", "Хуушуур, хоол хүнс", "food"], ["🥛", "Айраг, ундаа", "food"], ["💍", "Үнэт эдлэл", "fashion"], ["🐎", "Морины хэрэгсэл", "other"], ["🤼", "Үндэсний спорт", "travel"], ["✈️", "Аялал жуулчлал", "travel"]]],
  ["Mongolia Health Technology Expo", [["🏥", "Эмнэлэг", "health"], ["💊", "Эм, эмийн сан", "health"], ["🩺", "Эмнэлгийн тоног төхөөрөмж", "health"], ["🦷", "Шүдний эмнэлэг", "health"], ["👓", "Нүдний эмнэлэг, шил", "health"], ["🧪", "Лаборатори", "health"], ["🌿", "Уламжлалт анагаах ухаан", "health"], ["💪", "Нэмэлт тэжээл", "health"], ["✨", "Гоо сайхны эмнэлэг", "health"], ["🤖", "Цахим эрүүл мэнд, AI", "tech"], ["🛡️", "Эрүүл мэндийн даатгал", "fin"]]],
  ["Mongolia Auto Aftermarket", [["⚙️", "Сэлбэг", "auto"], ["🛞", "Дугуй", "auto"], ["🛢️", "Тос, шингэн", "auto"], ["🔋", "Аккумлятор", "auto"], ["🔧", "Засварын төв", "auto"], ["🧽", "Угаалга, химчлэл", "auto"], ["📡", "Камер, GPS, электроник", "tech"], ["🏁", "Дагалдах хэрэгсэл, тюнинг", "auto"], ["❄️", "Өвлийн бэлтгэл (халаагуур, гинж)", "auto"], ["🛡️", "Даатгал", "fin"], ["🏦", "Лизинг, зээл", "fin"]]]
];

function seedProducts_() {
  if (readAll_(SH.PROD).length) return 0;
  const rows = [];
  SEED_PRODUCTS.forEach(t => t[1].forEach(p => rows.push({ 'Үзэсгэлэн': t[0], 'Дүрс': p[0], 'Бүтээгдэхүүн': p[1], 'Салбар': SEED_SECTORS[p[2]] || '', 'Идэвхтэй': 'Тийм' })));
  appendRows_(SH.PROD, rows);
  const sh = sheet_(SH.PROD);
  try {
    sh.getRange('E2:E1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Тийм', 'Үгүй'], true).setAllowInvalid(false).build());
    sh.getRange('D2:D1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(SEED_SECTORS).map(k => SEED_SECTORS[k]), true).build());
    sh.setColumnWidth(1, 240); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 260);
  } catch (e) {}
  return rows.length;
}

function setup() {
  Object.keys(COLS).forEach(name => {
    const sh = sheet_(name);
    // Багана нэмэгдсэн бол гарчгийн мөрийг шинэчилнэ (шинэ багана үргэлж төгсгөлд нэмэгддэг)
    sh.getRange(1, 1, 1, COLS[name].length).setValues([COLS[name]]).setFontWeight('bold');
    // Хүснэгтийг гараар засахаас хамгаална: зөвхөн эзэмшигч засна, систем хэвийн бичнэ
    if (EDITABLE[name]) { sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove()); return; }
    try {
      const old = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      const p = old.length ? old[0] : sh.protect();
      p.setDescription('Систем ашигладаг хүснэгт — ажилтны хуудаснаас өөрчилнө үү');
      p.removeEditors(p.getEditors());
      if (p.canDomainEdit()) p.setDomainEdit(false);
    } catch (e) { console.log(name + ' хамгаалалт тохируулж чадсангүй: ' + e.message); }
  });
  const def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('Хуудас1');
  if (def && ss_().getSheets().length > 1 && def.getLastRow() === 0) ss_().deleteSheet(def);
  folder_();
  const np = seedProducts_(); if (np) console.log('Бүтээгдэхүүн хуудсанд ' + np + ' мөр бичлээ (8 үзэсгэлэнгийн загвар).');
  const nb = backfillParts_(); if (nb) console.log('Одоо байгаа ' + nb + ' захиалгыг Оролцоо, Оролцогчид хуудсанд хуулав.');
  const staff = readAll_(SH.STAFF);
  if (!staff.length) {
    const pin = prop_('ADMIN_PIN') || String(Math.floor(100000 + Math.random() * 900000));
    appendRows_(SH.STAFF, [{ name: 'Систем админ', pin: "'" + pin, role: 'system', active: 'тийм' }]);
    console.log('Систем админы PIN: ' + pin + ' — "Ажилтан" хуудаснаас харж, өөрчилж болно.');
  } else if (!staff.some(s => role_(s.role) === 'system')) {
    const f = staff[0]; f.role = 'system'; if (f.name === 'Захирал') f.name = 'Систем админ';
    f.pin = "'" + String(f.pin); writeRow_(SH.STAFF, f);
    console.log('"' + f.name + '" систем админ эрхтэй боллоо. Захирлыг ажилтны хуудасны "Ажилтан" цэсээс нэмнэ үү.');
  }
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['hourlyJob', 'dailyReport', 'weeklyBackup'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(22).create();
  console.log('Тохиргоо дууслаа. Одоо Deploy → New deployment → Web app хийнэ үү.');
}

/** Telegram тохиргоог шалгах: ажиллуулахад туршилтын мессеж очно. */
function testTelegram() {
  const set = { 'Менежерийн групп (TELEGRAM_CHAT)': prop_('TELEGRAM_CHAT'), 'Захирал (TELEGRAM_DIRECTOR)': prop_('TELEGRAM_DIRECTOR'), 'Систем админ (TELEGRAM_ADMIN)': prop_('TELEGRAM_ADMIN') };
  Object.keys(set).forEach(k => {
    if (!set[k]) { console.log(k + ': тохируулаагүй'); return; }
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_TOKEN') + '/sendMessage', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify({ chat_id: set[k], text: '✅ Лангуу захиалгын систем холбогдлоо — ' + k }) });
    console.log(k + ': ' + (r.getResponseCode() === 200 ? 'амжилттай' : 'АЛДАА ' + r.getContentText().slice(0, 150)));
  });
}

/** Ботод сүүлд мессеж бичсэн чат, группуудын ID-г харуулна. Эхлээд ботод эсвэл группт /start гэж бичнэ. */
function telegramChats() {
  const token = prop_('TELEGRAM_TOKEN');
  if (!token) { console.log('Эхлээд TELEGRAM_TOKEN тохиргоог нэмнэ үү.'); return; }
  const r = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true }).getContentText());
  if (r.error_code === 409) {
    // Товчнууд (webhook) идэвхтэй үед getUpdates ажиллахгүй: сүүлд бичсэн, эрхгүй чатуудыг харуулна
    const seen = JSON.parse(CacheService.getScriptCache().get('tg_seen') || '[]');
    if (!seen.length) console.log('Шинэ чат олдсонгүй. Нэмэх хүн ботод /start гэж бичээд дахин ажиллуулна уу.');
    seen.forEach(x => console.log(x));
    return;
  }
  if (!r.ok) { console.log('Токен буруу эсвэл бот идэвхгүй: ' + JSON.stringify(r).slice(0, 200)); return; }
  const seen = {};
  (r.result || []).forEach(u => {
    const m = u.message || u.my_chat_member || u.channel_post || u.edited_message; const c = m && m.chat; if (!c || seen[c.id]) return;
    seen[c.id] = 1;
    console.log((c.type === 'private' ? '👤 ' + [c.first_name, c.last_name].filter(Boolean).join(' ') : '👥 ' + c.title) + '  →  ' + c.id);
  });
  if (!Object.keys(seen).length) console.log('Чат олдсонгүй. Ботод эсвэл бот нэмсэн группт /start гэж бичээд дахин ажиллуулна уу.');
}

/* ===================== Telegram товчнууд ===================== */
/*
 * Захирлын групп, систем админ (мөн менежерийн групп тохируулсан бол) Telegram-аас шууд:
 *   • мэдэгдлийн доорх товчоор урьдчилгаа / бүрэн төлбөр бүртгэх, 24 цаг сунгах, цуцлах
 *   • цэс: өнөөдрийн байдал, авлага, хугацаа дуусах, хайх
 * Идэвхжүүлэх: кодыг шинэ хувилбараар deploy хийсний дараа tgConnect()-ийг нэг удаа ажиллуулна.
 */
const WEB_URL = 'https://script.google.com/macros/s/AKfycbyIG0JUpqjVomlhgLR0aTFaDAyPsaseZGvfSR2GGjVZZtlDsAazwHS74kNfuEQPjfuE/exec';
const ST_NAME = { free: 'Сул', held: 'Түр барьсан', adv: 'Урьдчилгаа төлсөн', paid: 'Бүрэн төлсөн' };
const ST_ICON = { free: '⬜', held: '🟨', adv: '🟧', paid: '🟥' };
const TG_MENU = [['📊 Өнөөдрийн байдал', 'status'], ['💰 Авлага', 'due'], ['⏰ Хугацаа дуусах', 'soon'], ['🔎 Хайх', 'find'], ['🗂 Оролцогчид', 'orgs']];

function tg_(method, payload) {
  const token = prop_('TELEGRAM_TOKEN');
  if (!token) return {};
  try {
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload || {})
    });
    return JSON.parse(r.getContentText() || '{}');
  } catch (e) { return {}; }
}
function tgSend_(chat, text, markup, extra) {
  return tg_('sendMessage', Object.assign({ chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }, markup ? { reply_markup: markup } : {}, extra || {}));
}
function tgEdit_(msg, text, kb) {
  tg_('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: String(text).slice(0, 4000), disable_web_page_preview: true, reply_markup: { inline_keyboard: kb || [] } });
}
const PAGES_URL = 'https://bagaaganaa1111-bit.github.io/expo-booking/';
function tgMenuKb_() {
  const web = prop_('PAGES_URL') || PAGES_URL;
  const b = m => ({ text: m[0], callback_data: 'm|' + m[1] }), sheet = sheetUrl_(SH.ORG);
  return [TG_MENU.slice(0, 2).map(b), TG_MENU.slice(2, 4).map(b), [b(TG_MENU[4])].concat(sheet ? [{ text: '📑 Бүртгэл (Sheets)', url: sheet }] : []), [{ text: '📈 Дэлгэрэнгүй тайлан (вэб)', url: web.replace(/\/?$/, '/') + 'tailan.html' }]];
}
/** Sheets файлын тухайн хуудсыг шууд нээх холбоос (файлд эрхтэй хүнд нээгдэнэ). */
function sheetUrl_(name) {
  try { const sh = ss_().getSheetByName(name); return sh ? ss_().getUrl() + '#gid=' + sh.getSheetId() : ''; } catch (e) { return ''; }
}
function hhmm_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), 'HH:mm'); }

/** Зөвхөн тохируулсан чатуудаас ирсэн командыг хүлээн авна. */
function tgWho_(chatId, from) {
  const id = String(chatId || '');
  if (!id) return null;
  // Ботод /login PIN-ээр холбогдсон ажилтан (хувийн чат)
  const st = staffByTg_(id);
  if (st) return { name: st.name + ' (Telegram)', short: st.name, role: st.role === 'staff' ? 'staff' : 'admin', chat: id, staff: true };
  // TELEGRAM_USERS: мэдэгдэл авахгүй ч ботод хувиараа бичиж цэс, товч ашиглах захирлууд
  const boss = ids_('TELEGRAM_DIRECTOR').concat(ids_('TELEGRAM_ADMIN'), ids_('TELEGRAM_USERS')).indexOf(id) >= 0;
  const staff = !boss && ids_('TELEGRAM_CHAT').indexOf(id) >= 0;
  if (!boss && !staff) return null;
  const name = [from && from.first_name, from && from.last_name].filter(Boolean).join(' ') || 'Telegram';
  return { name: name + ' (Telegram)', short: name, role: boss ? 'admin' : 'staff', chat: id };
}

/** Лангууны төлөвөөс хамаарах товчнууд. callback_data: үйлдэл|үзэсгэлэн|лангуу|одоогийн төлөв */
function tgButtons_(e, b) {
  const k = (t, a) => ({ text: t, callback_data: [a, e.id, b.boothId, b.status].join('|') });
  if (b.status === 'held') return [[k('✅ Урьдчилгаа орсон', 'adv'), k('💵 Бүтэн төлсөн', 'paid')], [k('⏳ 24 цаг сунгах', 'ext'), k('❌ Цуцлах', 'ask')]];
  if (b.status === 'adv') return [[k('💵 Үлдэгдэл орсон', 'paid')], [k('❌ Цуцлах', 'ask')]];
  return [];
}

function heldMs_(b) { return b.heldAt instanceof Date ? b.heldAt.getTime() : (Date.parse(b.heldAt) || 0); }
function deadline_(e, b) { const t = heldMs_(b); return t ? t + (num_(e.holdHours, 48) || 48) * 3600e3 : 0; }
function left_(t) {
  const h = (t - Date.now()) / 3600e3;
  return h <= 0 ? 'хугацаа дууссан' : h < 1 ? Math.max(1, Math.round(h * 60)) + ' минут үлдсэн' : Math.floor(h) + ' цаг үлдсэн';
}
function money_(e, b, cats) {
  const p = priceOf_(b, cats), adv = (num_(e.advancePct, 50) || 50) / 100;
  const got = b.status === 'paid' ? p : b.status === 'adv' ? Math.round(p * adv) : 0;
  return { price: p, got, owe: BOOKED[b.status] ? p - got : 0 };
}
function tgCard_(e, b, cats) {
  const m = money_(e, b, cats);
  return ST_ICON[b.status || 'free'] + ' ' + b.code + ' · ' + e.name + '\n' + (b.org || '') + (b.person ? ', ' + b.person : '') + (b.tel ? '\n📞 ' + b.tel : '') +
    '\n' + ST_NAME[b.status || 'free'] + ' · Дүн ' + fmt_(m.price) + '₮' + (m.owe ? ', үлдэгдэл ' + fmt_(m.owe) + '₮' : '') +
    (b.status === 'held' ? '\n⏳ ' + left_(deadline_(e, b)) : '');
}

/** Нээлттэй үзэсгэлэнгүүд, тус бүрийн салбар, лангуу. Хугацаа нь дууссан түр захиалгыг сул гэж тооцно. */
function tgData_(all) {
  const cats = readAll_(SH.CAT), booths = readAll_(SH.BOOTH), now = Date.now();
  return readAll_(SH.EXPO).filter(e => all || e.status === 'open').map(e => {
    e.holdHours = num_(e.holdHours, 48) || 48; e.advancePct = num_(e.advancePct, 50) || 50;
    const bs = booths.filter(b => String(b.expoId) === String(e.id));
    bs.forEach(b => { if (b.status === 'held' && deadline_(e, b) && deadline_(e, b) <= now) b.status = 'free'; });
    return { e, cats: cats.filter(c => String(c.expoId) === String(e.id)), booths: bs };
  });
}

function tgUpdate_(u, p) {
  const sec = prop_('TG_SECRET');
  if (!sec || String(p.k || '') !== sec) return;
  const cache = CacheService.getScriptCache(), uk = 'tgu_' + u.update_id;
  if (cache.get(uk)) return; // Telegram давтан илгээвэл нэг л удаа гүйцэтгэнэ
  cache.put(uk, '1', 21600);
  if (u.callback_query) return tgCallback_(u.callback_query);
  const m = u.message;
  if (!m || !m.chat) return;
  const text = String(m.text || '').trim(), cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/login') return tgLogin_(m);
  const who = tgWho_(m.chat.id, m.from);
  if (!who) { tgRemember_(m.chat); if (m.chat.type === 'private') tgStranger_(m.chat.id); return; }
  if (cmd === '/logout') return tgLogout_(who.chat);
  // 📸 Байгууллагын зураг → оролцогчдын сан
  if (m.photo || (m.document && /^image\//.test(String(m.document.mime_type || '')))) {
    try { return tgLeadPhoto_(who, m); } catch (err) { if (!(err && err.userMessage)) reportError_('зураг', err); return tgSend_(who.chat, '⚠️ ' + (err && err.userMessage || 'Алдаа гарлаа. Зургаа дахин явуулна уу.')); }
  }
  if (!text) return;
  const lid = m.reply_to_message ? cache.get('leadmsg_' + who.chat + '_' + m.reply_to_message.message_id) : '';
  if (lid) return tgLeadFix_(who, lid, text);
  const fk = 'tgf_' + who.chat + '_' + (m.from && m.from.id);
  if (cmd === '/start' || cmd === '/menu') return tgSend_(who.chat, 'Сая Мөнх · Лангуу захиалга\nДоорх товчийг дарна уу.' + (m.chat.type === 'private' ? '\n\n📸 Байгууллагын Facebook "Танилцуулга" хэсэг, нэрийн хуудасны зургийг энд явуулбал оролцогчдын санд бүртгэнэ.' : ''), { inline_keyboard: tgMenuKb_() });
  const hit = TG_MENU.find(x => text === x[0] || cmd === '/' + x[1]);
  if (hit) return tgMenuDo_(hit[1], who, m.from, m.message_id);
  const toBot = m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.is_bot;
  if (cache.get(fk) || toBot || /^\d{8}$/.test(text.replace(/[\s-]/g, ''))) { cache.remove(fk); return tgFind_(who, text); }
}

/** Эрхгүй хүн ботод хувиараа бичвэл нэвтрэх заавар өгнө (цагт нэг удаа). */
function tgStranger_(chat) {
  const c = CacheService.getScriptCache(), k = 'tgs_' + chat;
  if (c.get(k)) return; c.put(k, '1', 3600);
  tgSend_(chat, 'Энэ бот Сая Мөнхийн ажилтнуудад зориулагдсан.\nАжилтан бол админ хуудасны PIN-ээрээ холбогдоно:  /login 1234');
}

/** Эрхгүй чатыг telegramChats()-д харуулахаар түр хадгална. */
function tgRemember_(c) {
  try {
    const cache = CacheService.getScriptCache(), seen = JSON.parse(cache.get('tg_seen') || '[]');
    const line = (c.type === 'private' ? '👤 ' + [c.first_name, c.last_name].filter(Boolean).join(' ') : '👥 ' + c.title) + '  →  ' + c.id;
    if (seen.indexOf(line) < 0) { seen.push(line); cache.put('tg_seen', JSON.stringify(seen.slice(-20)), 21600); }
  } catch (e) {}
}

function tgMenuDo_(what, who, from, replyTo) {
  if (what === 'status') return tgStatus_(who);
  if (what === 'due') return tgDue_(who);
  if (what === 'soon') return tgSoon_(who);
  if (what === 'orgs') return tgOrgs_(who, null, ['o', '0']);
  if (what === 'find') {
    CacheService.getScriptCache().put('tgf_' + who.chat + '_' + (from && from.id), '1', 600);
    return tgSend_(who.chat, '🔎 Утасны дугаар эсвэл байгууллагын нэрийг бичээд илгээнэ үү.', { force_reply: true, selective: true, input_field_placeholder: '99112233 эсвэл Номин' },
      replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : null);
  }
}

function tgStatus_(who) {
  const data = tgData_();
  if (!data.length) return tgSend_(who.chat, 'Одоогоор захиалга нээлттэй үзэсгэлэн алга.', { inline_keyboard: tgMenuKb_() });
  const boss = who.role === 'admin';
  const parts = data.map(d => {
    const n = { free: 0, held: 0, adv: 0, paid: 0 }; let got = 0, owe = 0;
    d.booths.forEach(b => { n[BOOKED[b.status] ? b.status : 'free']++; const m = money_(d.e, b, d.cats); got += m.got; owe += m.owe; });
    const sold = n.adv + n.paid, tot = d.booths.length;
    return '🏢 ' + d.e.name + (d.e.start ? ' (' + iso_(d.e.start) + ')' : '') +
      '\nЗарагдсан: ' + sold + '/' + tot + ' (' + (tot ? Math.round(sold / tot * 100) : 0) + '%)' +
      '\n🟥 Бүрэн ' + n.paid + ' · 🟧 Урьдчилгаа ' + n.adv + ' · 🟨 Түр ' + n.held + ' · ⬜ Сул ' + n.free +
      (boss ? '\n💵 Орсон ' + fmt_(got) + '₮ · Авлага ' + fmt_(owe) + '₮' : '');
  });
  tgSend_(who.chat, '📊 Өнөөдрийн байдал · ' + hhmm_() + '\n\n' + parts.join('\n\n'), { inline_keyboard: tgMenuKb_() });
}

function tgDue_(who) {
  const data = tgData_(), lines = [];
  let total = 0, count = 0;
  data.forEach(d => {
    const list = d.booths.filter(b => BOOKED[b.status] && b.status !== 'paid')
      .sort((a, b) => (a.status === 'held' ? deadline_(d.e, a) : 9e15) - (b.status === 'held' ? deadline_(d.e, b) : 9e15));
    if (!list.length) return;
    lines.push('\n🏢 ' + d.e.name);
    list.forEach(b => {
      const m = money_(d.e, b, d.cats); total += m.owe; count++;
      lines.push(ST_ICON[b.status] + ' ' + b.code + ' ' + (b.org || '') + (b.tel ? ' · ' + b.tel : '') + ' — ' + fmt_(m.owe) + '₮' + (b.status === 'held' ? ' · ' + left_(deadline_(d.e, b)) : ''));
    });
  });
  if (!count) return tgSend_(who.chat, '💰 Авлага алга. Бүх захиалга бүрэн төлөгдсөн ✅', { inline_keyboard: tgMenuKb_() });
  let text = '💰 Авлага — ' + count + ' лангуу' + (who.role === 'admin' ? ', нийт ' + fmt_(total) + '₮' : '') + '\n🟨 түр барьсан · 🟧 урьдчилгаа төлсөн\n' + lines.join('\n');
  if (text.length > 3800) text = text.slice(0, 3700) + '\n…\nБүтэн жагсаалтыг ажилтны хуудаснаас харна уу.';
  tgSend_(who.chat, text + '\n\nЛангууг товчоор шинэчлэх бол 🔎 Хайх ашиглана уу.', { inline_keyboard: tgMenuKb_() });
}

function tgSoon_(who) {
  const now = Date.now(), list = [];
  tgData_().forEach(d => d.booths.forEach(b => {
    if (b.status === 'held' && deadline_(d.e, b) - now < 24 * 3600e3) list.push({ d, b, t: deadline_(d.e, b) });
  }));
  if (!list.length) return tgSend_(who.chat, '⏰ 24 цагийн дотор суллагдах лангуу алга ✅', { inline_keyboard: tgMenuKb_() });
  list.sort((a, b) => a.t - b.t);
  tgSend_(who.chat, '⏰ 24 цагийн дотор суллагдах: ' + list.length + ' лангуу' + (list.length > 10 ? ' (эхний 10)' : ''));
  list.slice(0, 10).forEach(x => tgSend_(who.chat, tgCard_(x.d.e, x.b, x.d.cats), { inline_keyboard: tgButtons_(x.d.e, x.b) }));
}

function tgFind_(who, q) {
  q = String(q || '').trim();
  const digits = q.replace(/\D/g, ''), low = q.toLowerCase(), found = [];
  if (digits.length < 4 && low.length < 2) return tgSend_(who.chat, 'Дор хаяж 4 оронтой утас эсвэл 2 үсэгтэй нэр бичнэ үү.', { inline_keyboard: tgMenuKb_() });
  tgData_(true).forEach(d => d.booths.forEach(b => {
    if (!BOOKED[b.status]) return;
    const byTel = digits.length >= 4 && digits.length === q.replace(/[\s-]/g, '').length && String(b.tel || '').indexOf(digits) >= 0;
    const byOrg = !byTel && String(b.org || '').toLowerCase().indexOf(low) >= 0;
    if (byTel || byOrg) found.push({ d, b });
  }));
  if (!found.length) return tgSend_(who.chat, '🔎 "' + q + '" — захиалга олдсонгүй.', { inline_keyboard: tgMenuKb_() });
  tgSend_(who.chat, '🔎 "' + q + '" — ' + found.length + ' захиалга' + (found.length > 10 ? ' (эхний 10)' : ''));
  found.slice(0, 10).forEach(x => tgSend_(who.chat, tgCard_(x.d.e, x.b, x.d.cats), { inline_keyboard: x.d.e.status === 'open' ? tgButtons_(x.d.e, x.b) : [] }));
}

/* ===================== 📸 Screenshot-оор оролцогч бүртгэх ===================== */
/*
 * Ажилтан ботын хувийн чатад /login PIN гэж нэг удаа холбогдоно (PIN = админ хуудасны PIN).
 * Дараа нь байгууллагын Facebook "Танилцуулга", нэрийн хуудас, вэбсайтын зургийг явуулахад:
 *   1) бот "⏳ Уншиж байна…" гэж шууд хариулна
 *   2) AI нэр, утас, имэйл, хаяг, салбарыг уншина (олон зургийг нэг картад нэгтгэнэ)
 *   3) карт: [✅ Хадгалах] [🏷 Салбар] [❌ Болих]; алдаатай бол карт руу reply бичиж засна
 *   4) хадгалахад "Оролцогчид" хуудсанд нэмэгдэнэ (утас/нэрээр давхардлыг шалгана)
 * Ноорог CacheService-д 6 цаг хадгалагдана.
 */

const LEAD_TTL = 21600; // 6 цаг
const LEAD_SOURCE = 'Facebook / зураг';

function sectors_() { return Object.keys(SEED_SECTORS).map(k => SEED_SECTORS[k]); }

/* ---------- Ажилтны Telegram холболт ---------- */

/** Telegram чат → ажилтан (Ажилтан хуудасны tg багана). 5 минут кэшлэнэ. */
function staffByTg_(chatId) {
  const c = CacheService.getScriptCache();
  let map = null;
  try { map = JSON.parse(c.get('tgstaff') || 'null'); } catch (e) {}
  if (!map) {
    map = {};
    readAll_(SH.STAFF).forEach(s => {
      const id = String(s.tg || '').trim();
      if (id && String(s.active).toLowerCase() !== 'false' && String(s.active) !== 'үгүй') map[id] = { name: String(s.name), role: role_(s.role) };
    });
    try { c.put('tgstaff', JSON.stringify(map), 300); } catch (e) {}
  }
  return map[String(chatId)] || null;
}
function staffCacheClear_() { try { CacheService.getScriptCache().remove('tgstaff'); } catch (e) {} }

/** /login 1234 — ажилтны хувийн чатыг PIN-ээр холбоно. PIN-тэй мессежийг устгана. */
function tgLogin_(m) {
  const chat = String(m.chat.id), cache = CacheService.getScriptCache(), fk = 'tglf_' + chat;
  tg_('deleteMessage', { chat_id: chat, message_id: m.message_id });
  if (m.chat.type !== 'private') return tgSend_(chat, '🔐 Нэвтрэхдээ ботын хувийн чат руу бичнэ үү (групп дотор PIN бүү бичээрэй).');
  if (num_(cache.get(fk)) >= 5) return tgSend_(chat, '🔐 Олон удаа буруу оруулсан тул 15 минутын дараа дахин оролдоно уу.');
  const pin = String(m.text || '').trim().split(/\s+/)[1] || '';
  if (!/^\d{4,8}$/.test(pin)) return tgSend_(chat, 'PIN кодоо хамт бичнэ үү. Жишээ нь:  /login 1234');
  const r = withLock_(() => {
    const all = readAll_(SH.STAFF);
    const s = all.find(x => Number(String(x.pin).trim()) === Number(pin) && String(x.active).toLowerCase() !== 'false' && String(x.active) !== 'үгүй');
    if (!s) return null;
    all.forEach(x => { if (x !== s && String(x.tg || '') === chat) { x.tg = ''; x.pin = "'" + String(x.pin); writeRow_(SH.STAFF, x); } });
    s.tg = "'" + chat; s.pin = "'" + String(s.pin); writeRow_(SH.STAFF, s);
    return s;
  });
  if (!r) {
    cache.put(fk, String(num_(cache.get(fk)) + 1), 900);
    Utilities.sleep(800);
    return tgSend_(chat, '❌ PIN буруу байна. Админ хуудсанд нэвтэрдэг PIN-ээ бичнэ үү.');
  }
  cache.remove(fk); staffCacheClear_();
  log_('', '', 'Telegram холбосон', String(r.name), chat);
  tgSend_(chat, '✅ Сайн байна уу, ' + r.name + '! Холбогдлоо.\n\n📸 Байгууллагын Facebook пэйжийн "Танилцуулга / About" хэсэг, нэрийн хуудас эсвэл вэбсайтын зургийг энд явуулахад оролцогчдын санд бүртгэнэ. Нэг байгууллагын хэд хэдэн зургийг нэг дор явуулж болно.', { inline_keyboard: tgMenuKb_() });
}

function tgLogout_(chat) {
  withLock_(() => readAll_(SH.STAFF).forEach(x => { if (String(x.tg || '') === String(chat)) { x.tg = ''; x.pin = "'" + String(x.pin); writeRow_(SH.STAFF, x); } }));
  staffCacheClear_();
  tgSend_(chat, '👋 Гарлаа. Дахин холбогдох бол /login PIN гэж бичнэ үү.');
}

/* ---------- Claude ---------- */

/** Claude-д хүсэлт илгээж текст хариуг буцаана. Алдааг ажилтанд ойлгомжтой болгоно. */
function claude_(content, maxTokens) {
  const key = prop_('CLAUDE_API_KEY');
  if (!key) fail_('AI тохиргоо хийгдээгүй байна (CLAUDE_API_KEY). Систем админд хандана уу.');
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: prop_('CLAUDE_MODEL') || 'claude-sonnet-5-5', max_tokens: maxTokens || 1500, messages: [{ role: 'user', content }] })
  });
  const code = resp.getResponseCode(), body = resp.getContentText();
  if (code !== 200) {
    reportError_('AI', new Error('Claude API ' + code + ': ' + body.slice(0, 300)));
    if (/credit balance/i.test(body)) { notify_('tech', '💳 Claude API кредит дууссан байна. console.anthropic.com → Billing хэсгээс цэнэглэнэ үү.'); fail_('AI үйлчилгээний төлбөр дууссан байна. Систем админд мэдэгдлээ.'); }
    fail_(code === 429 || code === 529 ? 'AI завгүй байна. 1 минутын дараа зургаа дахин явуулна уу.' : 'AI уншиж чадсангүй. Зургаа дахин явуулна уу.');
  }
  return (JSON.parse(body).content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}
function json_(text) {
  const t = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  let j = t(text);
  if (!j) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) j = t(text.slice(a, b + 1)); }
  return j && typeof j === 'object' ? j : null;
}

function leadPrompt_() {
  return 'Энэ бол Монгол байгууллагын Facebook пэйж, нэрийн хуудас эсвэл вэбсайтын зураг. Байгууллагын мэдээллийг гарга. ' +
    'Зөвхөн зураг дээр бичигдсэн зүйлийг бич, бүү таамагла. Утасны дугаарыг зөвхөн цифрээр бич.\n' +
    'Зөвхөн дараах JSON-ыг, өөр үггүйгээр буцаа:\n' +
    '{"org":"","phones":[],"email":"","address":"","website":"","facebook":"","about":"","sectors":[]}\n' +
    'org: байгууллагын нэр. about: юу хийдгийг 1 өгүүлбэрээр (зураг дээрх мэдээллээр). ' +
    'sectors: доорх жагсаалтаас үйл ажиллагаанд нь хамгийн тохирох 1–3 дугаар (хамгийн тохирохыг эхэнд), тодорхойгүй бол хоосон:\n' +
    sectors_().map((s, i) => i + '. ' + s).join('\n');
}

/* ---------- Ноорог ---------- */

function phones_(list) {
  const out = [];
  (Array.isArray(list) ? list : [list]).forEach(p => {
    let d = String(p == null ? '' : p).replace(/\D/g, '');
    if (d.length === 11 && d.indexOf('976') === 0) d = d.slice(3);
    if (d.length === 8 && out.indexOf(d) < 0) out.push(d);
  });
  return out;
}
function leadGet_(id) { try { return JSON.parse(CacheService.getScriptCache().get('lead_' + id) || 'null'); } catch (e) { return null; } }
function leadPut_(d) { CacheService.getScriptCache().put('lead_' + d.id, JSON.stringify(d), LEAD_TTL); }
function leadDrop_(d) {
  const c = CacheService.getScriptCache();
  c.remove('lead_' + d.id); c.remove('leadmsg_' + d.chat + '_' + d.msg);
  if (d.group) c.remove('leadgrp_' + d.chat + '_' + d.group);
}

/** AI-ийн хариуг ноорогт нэгтгэнэ: хоосон талбарыг нөхөж, утас/салбарыг нэмнэ. replace=true бол бүрэн солино (reply-ээр зассан үед). */
function leadMerge_(d, j, replace) {
  const S = sectors_(), s = v => str_(v, 200);
  ['org', 'email', 'address', 'website', 'facebook', 'about'].forEach(k => { const v = s(j[k]); if (replace ? j[k] !== undefined : (v && !d[k])) d[k] = v; });
  const ph = phones_(j.phones);
  d.phones = replace && Array.isArray(j.phones) ? ph : phones_((d.phones || []).concat(ph));
  const sec = (Array.isArray(j.sectors) ? j.sectors : []).map(x => typeof x === 'number' || /^\d+$/.test(String(x)) ? S[Number(x)] : S.find(n => n === String(x))).filter(Boolean);
  d.sectors = replace && Array.isArray(j.sectors) ? sec.slice(0, 3) : (d.sectors || []).concat(sec.filter(x => (d.sectors || []).indexOf(x) < 0)).slice(0, 3);
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) d.email = '';
  return d;
}

/** Санд аль хэдийн байгаа эсэх: утас (үндсэн ба нэмэлт) эсвэл нэрээр. */
const normName_ = n => String(n || '').toLowerCase().replace(/["'«»“”]/g, '').replace(/\b(ххк|хк|ххх|llc|ltd)\b/g, '').replace(/\s+/g, ' ').trim();
function leadDup_(d, orgs) {
  orgs = orgs || readAll_(SH.ORG);
  const ph = d.phones || [], nm = normName_(d.org);
  return orgs.find(o => {
    const mine = phones_([o['Утас']].concat(String(o['Нэмэлт утас'] || '').split(/[,\s]+/)));
    return ph.some(p => mine.indexOf(p) >= 0);
  }) || (nm.length >= 3 ? orgs.find(o => normName_(o['Байгууллага']) === nm) : null) || null;
}

/** Салбарт тохирох үзэсгэлэнгийн загварууд (Бүтээгдэхүүн хуудасны Салбар баганаар). */
function tplsForSectors_(secs) {
  if (!secs || !secs.length) return [];
  // Загвар бүрт тухайн салбарын хэдэн бүтээгдэхүүн байгаагаар эрэмбэлнэ (үндсэн салбарт 2 оноо)
  const score = {};
  readAll_(SH.PROD).forEach(p => {
    const i = secs.indexOf(String(p['Салбар'])), t = String(p['Үзэсгэлэн']);
    if (i < 0 || NO_[String(p['Идэвхтэй']).trim().toLowerCase()]) return;
    score[t] = (score[t] || 0) + (i === 0 ? 2 : 1);
  });
  const list = Object.keys(score).sort((a, b) => score[b] - score[a]), strong = list.filter(t => score[t] >= 3);
  return (strong.length ? strong : list).slice(0, 3);
}

function leadCard_(d) {
  const dup = leadDup_(d), noContact = !(d.phones || []).length && !d.email, tpl = tplsForSectors_(d.sectors);
  let t = (d.reading ? '⏳ ' + d.reading + '\n\n' : '') +
    '🏢 ' + (d.org || '(нэр олдсонгүй)') +
    '\n🏷 ' + ((d.sectors || []).join(' · ') || 'Салбар тодорхойгүй — 🏷 товчоор сонгоно уу') +
    (tpl.length ? '\n🎪 Тохирох: ' + tpl.slice(0, 4).join(', ') : '') +
    ((d.phones || []).length ? '\n📞 ' + d.phones.join(', ') : '') + (d.email ? '\n✉️ ' + d.email : '') +
    (d.address ? '\n📍 ' + d.address : '') + (d.website ? '\n🌐 ' + d.website : '') + (d.facebook ? '\n📘 ' + d.facebook : '') +
    (d.about ? '\nℹ️ ' + d.about : '') + '\n📷 ' + (d.photos || 0) + ' зураг';
  if (noContact) t += '\n\n❗ Утас, имэйл олдсонгүй. "Танилцуулга / About" хэсгийн зургийг нэмж явуулна уу.';
  if (dup) t += '\n\n⚠️ Санд бүртгэлтэй: ' + dup['Байгууллага'] + (dup['Утас'] ? ' · ' + dup['Утас'] : '') + ' (' + (dup['Эх сурвалж'] || 'захиалга') + (dup['Нэмсэн'] ? ', ' + dup['Нэмсэн'] : '') + ')';
  t += '\n\n✏️ Алдаатай бол энэ мессежид reply хийгээд бичнэ үү. Жишээ: "утас 99112233", "нэр Номин ХХК"';
  const k = (txt, a) => ({ text: txt, callback_data: 'L|' + a + '|' + d.id });
  const row1 = noContact ? [] : [k(dup ? '🔄 Мэдээллийг нэмэх' : '✅ Хадгалах', 's')];
  return { text: t, kb: [row1.concat([k('🏷 Салбар', 't')]), [k('❌ Болих', 'c')]] };
}
function leadShow_(d) { const c = leadCard_(d); tgEdit_({ chat: { id: d.chat }, message_id: d.msg }, c.text, c.kb); }

/* ---------- Зураг хүлээн авах ---------- */

/** Зурагтай мессеж: ноорог үүсгэх (эсвэл цомгийн нооргод нэмэх) → AI уншина → карт шинэчилнэ. */
function tgLeadPhoto_(who, m) {
  const chat = String(m.chat.id), group = m.media_group_id ? String(m.media_group_id) : '', c = CacheService.getScriptCache();
  const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
  // 1) Ноорог: цомгийн зургууд зэрэг ирж болох тул түгжээн дотор нэг л ноорог үүсгэнэ
  const d0 = withLock_(() => {
    const gid = group ? c.get('leadgrp_' + chat + '_' + group) : '';
    let d = gid ? leadGet_(gid) : null;
    if (!d) {
      d = { id: uid_(), chat, by: who.short, photos: 0, phones: [], sectors: [], group, reading: 'Уншиж байна…' };
      const s = tgSend_(chat, '⏳ Зургийг уншиж байна…', null, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
      d.msg = s && s.result ? s.result.message_id : 0;
      if (!d.msg) fail_('Telegram руу хариу илгээж чадсангүй.');
      if (group) c.put('leadgrp_' + chat + '_' + group, d.id, LEAD_TTL);
      c.put('leadmsg_' + chat + '_' + d.msg, d.id, LEAD_TTL);
      leadPut_(d);
    }
    d.pending = (d.pending || 0) + 1; leadPut_(d);
    return d;
  });
  // 2) AI (түгжээгүй, удаан ажил)
  let j = null, err = '';
  try {
    const f = tg_('getFile', { file_id: fileId }).result || {};
    if (!f.file_path) fail_('Зургийг Telegram-аас татаж чадсангүй. Дахин явуулна уу.');
    if (num_(f.file_size) > 5 * 1024 * 1024) fail_('Зураг хэт том байна (5MB-аас бага).');
    const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.file_path).getBlob();
    const mime = /\.png$/i.test(f.file_path) ? 'image/png' : /\.webp$/i.test(f.file_path) ? 'image/webp' : 'image/jpeg';
    j = json_(claude_([{ type: 'image', source: { type: 'base64', media_type: mime, data: Utilities.base64Encode(blob.getBytes()) } }, { type: 'text', text: leadPrompt_() }], 1200));
    if (!j) err = 'Зураг дээрээс мэдээлэл олдсонгүй.';
  } catch (e) { err = e && e.userMessage ? e.userMessage : 'Зургийг уншиж чадсангүй. Дахин явуулна уу.'; if (!(e && e.userMessage)) reportError_('зураг унших', e); }
  // 3) Нэгтгэж картыг шинэчилнэ (түгжээн дотор — зэрэг ирсэн зургууд бие биенээ дарахгүй)
  withLock_(() => {
    const d = leadGet_(d0.id) || d0;
    d.pending = Math.max(0, (d.pending || 1) - 1);
    if (j) { leadMerge_(d, j); d.photos = (d.photos || 0) + 1; }
    d.reading = d.pending ? 'Дараагийн зургийг уншиж байна…' : '';
    leadPut_(d);
    if (!d.photos && !d.pending) { tgEdit_({ chat: { id: chat }, message_id: d.msg }, '⚠️ ' + (err || 'Мэдээлэл олдсонгүй.') + '\nFacebook пэйжийн "Танилцуулга / About" хэсгийн зургийг явуулна уу.', []); leadDrop_(d); return; }
    leadShow_(d);
    if (err && d.photos) tgSend_(chat, '⚠️ Нэг зургийг уншиж чадсангүй: ' + err);
  });
}

/** Карт руу reply бичиж засах: AI одоогийн ноорог + бичсэн тайлбараар шинэчилнэ. */
function tgLeadFix_(who, id, text) {
  const d = leadGet_(id);
  if (!d) return tgSend_(who.chat, '⌛ Энэ ноорог хугацаа дууссан эсвэл хадгалагдсан байна. Зургаа дахин явуулна уу.');
  const cur = { org: d.org || '', phones: d.phones || [], email: d.email || '', address: d.address || '', website: d.website || '', facebook: d.facebook || '', about: d.about || '', sectors: (d.sectors || []).map(s => sectors_().indexOf(s)) };
  let j = null;
  try {
    j = json_(claude_([{ type: 'text', text: 'Байгууллагын бүртгэлийн ноорог:\n' + JSON.stringify(cur) + '\n\nАжилтны засвар: "' + str_(text, 500) + '"\n\n' +
      'Засварын дагуу JSON-ыг шинэчил (засаагүй талбарыг хэвээр үлдээ; "нэмэх" гэвэл утсыг нэмнэ, "солих/зөв нь" гэвэл солино). Зөвхөн бүтэн JSON буцаа. sectors: дугаараар:\n' +
      sectors_().map((s, i) => i + '. ' + s).join('\n') }], 800));
  } catch (e) { return tgSend_(who.chat, '⚠️ ' + (e.userMessage || 'Засаж чадсангүй. Дахин бичнэ үү.')); }
  if (!j) return tgSend_(who.chat, '⚠️ Засварыг ойлгосонгүй. Жишээ нь: "утас 99112233" гэж бичнэ үү.');
  withLock_(() => { const x = leadGet_(id); if (!x) return; leadMerge_(x, j, true); leadPut_(x); leadShow_(x); });
}

/* ---------- Товчнууд ---------- */

function tgLeadBtn_(who, q, a) {
  const act = a[1], id = a[2], d = leadGet_(id), ans = (t, alert) => tg_('answerCallbackQuery', { callback_query_id: q.id, text: t || '', show_alert: !!alert });
  if (!d) { ans(); return tgEdit_(q.message, (q.message.text || '') + '\n\n⌛ Ноорог хугацаа дууссан. Зургаа дахин явуулна уу.', []); }
  if (act === 'c') { ans('Болиулсан'); leadDrop_(d); return tgEdit_(q.message, '❌ Болиулсан' + (d.org ? ': ' + d.org : ''), []); }
  if (act === 't' || act === 'x') {
    if (act === 'x') {
      const s = sectors_()[Number(a[3])];
      withLock_(() => { const x = leadGet_(id) || d, i = (x.sectors || []).indexOf(s); if (i >= 0) x.sectors.splice(i, 1); else if ((x.sectors || []).length < 3) (x.sectors = x.sectors || []).push(s); else ans('Хамгийн ихдээ 3 салбар', true); leadPut_(x); Object.assign(d, x); });
    }
    ans();
    const kb = sectors_().map((s, i) => [{ text: ((d.sectors || []).indexOf(s) >= 0 ? '✅ ' : '') + s, callback_data: 'L|x|' + id + '|' + i }]);
    kb.push([{ text: '✔️ Болсон', callback_data: 'L|b|' + id }]);
    return tgEdit_(q.message, '🏷 ' + (d.org || '') + '\nСалбараа сонгоно уу (3 хүртэл):', kb);
  }
  if (act === 'b') { ans(); return leadShow_(d); }
  if (act === 's') {
    ans('Хадгалж байна…');
    const r = withLock_(() => leadSave_(leadGet_(id) || d, who));
    leadDrop_(d);
    return tgEdit_(q.message, (r.merged ? '🔄 Нэмэлт мэдээлэл хадгаллаа: ' : '✅ Хадгаллаа: ') + r.org + (r.sectors ? '\n🏷 ' + r.sectors : '') +
      '\n\n📊 Санд нийт ' + r.total + ' байгууллага · Өнөөдөр та ' + r.today + ' нэмлээ', sheetUrl_(SH.ORG) ? [[{ text: '📑 Бүртгэл (Sheets)', url: sheetUrl_(SH.ORG) }]] : []);
  }
}

/** Оролцогчид хуудсанд шинээр нэмэх эсвэл байгаа мөрийг нөхөнө. withLock_ дотор дуудна. */
function leadSave_(d, who) {
  const orgs = readAll_(SH.ORG), dup = leadDup_(d, orgs), now = new Date(), ph = d.phones || [];
  const join = (a, b) => { const out = []; String(a || '').split(' | ').concat(b || []).forEach(x => { x = String(x).trim(); if (x && out.indexOf(x) < 0) out.push(x); }); return out.join(' | '); };
  let row, merged = false;
  if (dup) {
    merged = true; row = dup;
    const main = phones_([row['Утас']]), extra = phones_(String(row['Нэмэлт утас'] || '').split(/[,\s]+/).concat(ph)).filter(p => main.indexOf(p) < 0);
    if (!main.length && extra.length) row['Утас'] = tel_(extra.shift()); else if (main.length) row['Утас'] = tel_(main[0]);
    row['Нэмэлт утас'] = extra.join(', ');
    [['Имэйл', 'email'], ['Хаяг', 'address'], ['Вэбсайт', 'website'], ['Facebook', 'facebook'], ['Тайлбар', 'about']].forEach(f => { if (!String(row[f[0]] || '').trim() && d[f[1]]) row[f[0]] = d[f[1]]; });
    row['Салбар'] = join(row['Салбар'], d.sectors);
    if (String(row['Эх сурвалж'] || '').indexOf(LEAD_SOURCE) < 0) row['Эх сурвалж'] = join(row['Эх сурвалж'] || 'Захиалга', [LEAD_SOURCE]);
    row['Түлхүүр'] = "'" + String(row['Түлхүүр']); row['Сүүлд'] = now;
    writeRow_(SH.ORG, row);
  } else {
    row = { 'Түлхүүр': "'" + orgKey_(ph[0], d.org), 'Байгууллага': d.org || '(нэргүй)', 'Утас': tel_(ph[0] || ''), 'Нэмэлт утас': ph.slice(1).join(', '), 'Имэйл': d.email || '',
      'Хаяг': d.address || '', 'Вэбсайт': d.website || '', 'Facebook': d.facebook || '', 'Тайлбар': d.about || '', 'Салбар': (d.sectors || []).join(' | '),
      'Эх сурвалж': LEAD_SOURCE, 'Нэмсэн': who.short, 'Тоо': 0, 'Анх бүртгэгдсэн': now, 'Сүүлд': now };
    appendRows_(SH.ORG, [row]);
  }
  log_('', '', merged ? 'оролцогч нөхсөн' : 'оролцогч нэмсэн', who.name, (d.org || '') + ' ' + (ph[0] || ''));
  const today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const all = merged ? orgs : orgs.concat([row]);
  const mineToday = all.filter(o => String(o['Нэмсэн']) === who.short && o['Анх бүртгэгдсэн'] && Utilities.formatDate(new Date(o['Анх бүртгэгдсэн']), Session.getScriptTimeZone(), 'yyyy-MM-dd') === today).length;
  return { merged, org: String(row['Байгууллага']), sectors: String(row['Салбар'] || ''), total: all.length, today: mineToday };
}

/* ---------- 🏷 Сангаас салбараар харах ---------- */

function tgSectors_(who, msg, a) {
  const S = sectors_(), orgs = readAll_(SH.ORG), show = (text, kb) => msg ? tgEdit_(msg, text, kb) : tgSend_(who.chat, text, { inline_keyboard: kb });
  const has = (o, s) => String(o['Салбар'] || '').split(' | ').indexOf(s) >= 0;
  if (a[1] === 'g') {
    const kb = S.map((s, i) => [{ text: s + ' (' + orgs.filter(o => has(o, s)).length + ')', callback_data: 'o|G|' + i }]);
    kb.push([{ text: '❔ Салбаргүй (' + orgs.filter(o => !String(o['Салбар'] || '').trim()).length + ')', callback_data: 'o|G|-' }, { text: '🏠 Эхнээс', callback_data: 'o|0' }]);
    return show('🏷 Оролцогчдын сан — нийт ' + orgs.length + ' байгууллага\nСалбараа сонгоно уу:', kb);
  }
  const s = a[2] === '-' ? '' : S[Number(a[2])], list = orgs.filter(o => s ? has(o, s) : !String(o['Салбар'] || '').trim());
  list.sort((p, q) => num_(q['Тоо']) - num_(p['Тоо']) || String(p['Байгууллага']).localeCompare(String(q['Байгууллага'])));
  let text = '🏷 ' + (s || 'Салбаргүй') + ' — ' + list.length + ' байгууллага\n🎪 = оролцсон үзэсгэлэнгийн тоо\n';
  for (let i = 0; i < list.length; i++) {
    const o = list[i], line = '\n• ' + o['Байгууллага'] + (o['Утас'] ? ' · ' + o['Утас'] : '') + (num_(o['Тоо']) ? ' · 🎪' + num_(o['Тоо']) : ' · шинэ');
    if (text.length + line.length > 3700) { text += '\n\n…үлдсэн ' + (list.length - i) + '. Бүтэн жагсаалт: Sheets → Оролцогчид.'; break; }
    text += line;
  }
  const kb = [[{ text: '↩️ Салбарууд', callback_data: 'o|g' }, { text: '🏠 Эхнээс', callback_data: 'o|0' }]], u = sheetUrl_(SH.ORG);
  if (u) kb.push([{ text: '📑 Бүртгэл (Sheets)', url: u }]);
  return show(text, kb);
}

/* ---------- 🗂 Оролцогчид: үзэсгэлэн → бүтээгдэхүүн → төлөв → жагсаалт ---------- */
/*
 * callback_data: o|0                — эхлэл (үзэсгэлэн сонгох)
 *                o|e|<expoId|*>      — бүтээгдэхүүн сонгох
 *                o|p|<expo>|<i|*>    — төлөв сонгох
 *                o|r|<expo>|<i|*>|<төлөв> — үр дүн
 */
const OF = { act: ['📋 Идэвхтэй бүгд', PACTIVE], pay: ['✅ Төлбөртэй', { 'Урьдчилгаа төлсөн': 1, 'Бүрэн төлсөн': 1 }], due: ['⏳ Төлбөр дутуу', { 'Түр барьсан': 1, 'Урьдчилгаа төлсөн': 1 }], off: ['❌ Цуцлагдсан, дууссан', { 'Цуцлагдсан': 1, 'Хугацаа дууссан': 1 }] };

/** Шүүлтийн бүтээгдэхүүний жагсаалт: загварын дарааллаар, дараа нь захиалгад байгаа бусад нь. */
function orgProdList_(expoId, rows, expos) {
  const e = expos.find(x => String(x.id) === String(expoId)), list = e ? productsOf_(e).map(p => p.n) : [];
  const extra = {};
  rows.filter(r => expoId === '*' || String(r.expoId) === String(expoId)).forEach(r => String(r['Бүтээгдэхүүн'] || '').split(' | ').forEach(p => {
    p = p.trim(); if (p && !/^Бусад:/.test(p) && list.indexOf(p) < 0) extra[p] = (extra[p] || 0) + 1;
  }));
  return list.concat(Object.keys(extra).sort((a, b) => extra[b] - extra[a] || a.localeCompare(b))).slice(0, 16);
}

function tgOrgs_(who, msg, a) {
  const step = a[1] || '0', X = a[2] || '*', P = a[3] || '*', S = a[4] || 'act';
  const rows = readAll_(SH.PART), expos = readAll_(SH.EXPO).reverse();
  const show = (text, kb) => msg ? tgEdit_(msg, text, kb) : tgSend_(who.chat, text, { inline_keyboard: kb });
  const ename = id => id === '*' ? 'Бүх үзэсгэлэн' : String((expos.find(e => String(e.id) === String(id)) || {}).name || '—');
  const pairs = btns => btns.reduce((acc, b, i) => { if (i % 2) acc[acc.length - 1].push(b); else acc.push([b]); return acc; }, []);
  const cut = (t, n) => (t = String(t)).length > n ? t.slice(0, n - 1) + '…' : t;
  const home = { text: '🏠 Эхнээс', callback_data: 'o|0' };

  if (step === 'g' || step === 'G') return tgSectors_(who, msg, a);
  if (step === '0') {
    const has = {}; rows.forEach(r => { has[r.expoId] = 1; });
    const list = expos.filter(e => has[e.id]).slice(0, 12), sec = [{ text: '🏷 Бүх сан — салбараар', callback_data: 'o|g' }];
    if (!list.length) return show('🗂 Оролцогчид\nЗахиалгатай үзэсгэлэн алга. Сангаа салбараар харах:', [sec]);
    return show('🗂 Оролцогчид\nҮзэсгэлэнгээ сонгоно уу:', pairs(list.map(e => ({ text: cut(e.name, 30), callback_data: 'o|e|' + e.id }))).concat([[{ text: '🌐 Бүх үзэсгэлэн', callback_data: 'o|e|*' }], sec]));
  }
  const prods = orgProdList_(X, rows, expos);
  const pname = P === '*' ? 'Бүх бүтээгдэхүүн' : (prods[Number(P)] || '—');
  if (step === 'e') {
    const kb = pairs(prods.map((p, i) => ({ text: cut(p, 28), callback_data: 'o|p|' + X + '|' + i })));
    kb.unshift([{ text: '📦 Бүх бүтээгдэхүүн', callback_data: 'o|p|' + X + '|*' }]);
    kb.push([{ text: '↩️ Буцах', callback_data: 'o|0' }]);
    return show('🗂 ' + ename(X) + '\nБүтээгдэхүүнээр шүүх:', kb);
  }
  if (step === 'p') {
    const kb = pairs(Object.keys(OF).map(k => ({ text: OF[k][0], callback_data: ['o', 'r', X, P, k].join('|') })));
    kb.push([{ text: '↩️ Буцах', callback_data: 'o|e|' + X }, home]);
    return show('🗂 ' + ename(X) + ' · ' + pname + '\nТөлөвөөр шүүх:', kb);
  }
  // step 'r' — үр дүн
  const okSt = (OF[S] || OF.act)[1];
  const found = rows.filter(r => (X === '*' || String(r.expoId) === String(X)) && okSt[r['Төлөв']] &&
    (P === '*' || String(r['Бүтээгдэхүүн'] || '').split(' | ').map(x => x.trim()).indexOf(pname) >= 0));
  found.sort((p, q) => String(p['Үзэсгэлэн']).localeCompare(String(q['Үзэсгэлэн'])) || String(p['Лангуу']).localeCompare(String(q['Лангуу']), undefined, { numeric: true }));
  const orgs = {}; found.forEach(r => { orgs[orgKey_(r['Утас'], r['Байгууллага'])] = 1; });
  // Мөнгөн дүн зөвхөн захиралд: "Төлбөр дутуу" бол үлдэгдэл, бусад үед нийт дүн; цуцлагдсанд харуулахгүй
  const adv = {}; expos.forEach(e => { adv[e.id] = (num_(e.advancePct, 50) || 50) / 100; });
  const owe = r => r['Төлөв'] === 'Түр барьсан' ? num_(r['Дүн']) : r['Төлөв'] === 'Урьдчилгаа төлсөн' ? Math.round(num_(r['Дүн']) * (1 - (adv[r.expoId] || 0.5))) : 0;
  const boss = who.role === 'admin', sum = found.reduce((t, r) => t + (S === 'due' ? owe(r) : num_(r['Дүн'])), 0);
  const money = boss && found.length && S !== 'off' ? ' · ' + (S === 'due' ? 'үлдэгдэл ' : '') + fmt_(sum) + '₮' : '';
  const head = '🗂 ' + ename(X) + ' · ' + pname + ' · ' + (OF[S] || OF.act)[0] + '\n' + found.length + ' лангуу, ' + Object.keys(orgs).length + ' байгууллага' + money;
  const kb = [[{ text: '🔁 Шүүлт солих', callback_data: 'o|p|' + X + '|' + P }, home]], part = sheetUrl_(SH.PART);
  if (part) kb.push([{ text: '📑 Бүтэн жагсаалт (Sheets)', url: part }]);
  if (!found.length) return show(head + '\n\nИйм оролцогч олдсонгүй.', kb);
  let text = head, group = '';
  for (let i = 0; i < found.length; i++) {
    const r = found[i];
    let line = '';
    if (X === '*' && r['Үзэсгэлэн'] !== group) { group = r['Үзэсгэлэн']; line += '\n🏢 ' + group; }
    line += '\n' + (PST_ICON[r['Төлөв']] || '•') + ' ' + r['Лангуу'] + ' ' + r['Байгууллага'] + (r['Утас'] ? ' · ' + r['Утас'] : '') + (P === '*' && r['Бүтээгдэхүүн'] ? '\n      ' + cut(r['Бүтээгдэхүүн'], 60) : '');
    if (text.length + line.length > 3700) { text += '\n\n…үлдсэн ' + (found.length - i) + ' мөр. Бүтэн жагсаалт: Google Sheets → "Оролцоо" хуудас.'; break; }
    text += (i === 0 ? '\n' : '') + line;
  }
  return show(text, kb);
}

function tgCallback_(q) {
  const msg = q.message || {}, who = tgWho_(msg.chat && msg.chat.id, q.from);
  const ans = (text, alert) => tg_('answerCallbackQuery', { callback_query_id: q.id, text: text || '', show_alert: !!alert });
  if (!who) return ans('Энэ чатаас үйлдэл хийх эрхгүй.', true);
  if (String(q.data || '').indexOf('L|') === 0) {
    try { return tgLeadBtn_(who, q, String(q.data).split('|')); }
    catch (err) { if (!(err && err.userMessage)) reportError_('бүртгэлийн товч', err); return ans('⚠️ ' + (err && err.userMessage || 'Алдаа гарлаа. Дахин дарна уу.'), true); }
  }
  const [act, expoId, boothId, expect] = String(q.data || '').split('|');
  const mark = { adv: '✅ Урьдчилгаа орсон', paid: '💵 Бүрэн төлсөн', free: '❌ Цуцалсан', ext: '⏳ 24 цаг сунгасан' }[act];
  // Товчны эргэлдэх тэмдгийг шууд зогсооно: хүн хүлээхгүй, ажил ард нь хийгдэнэ
  ans(mark ? mark + '…' : '');
  if (act === 'm') return tgMenuDo_(expoId, who, q.from, null);
  if (act === 'o') return tgOrgs_(who, msg, String(q.data || '').split('|'));
  const kb = (rows) => tg_('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } });
  const k = (t, a) => ({ text: t, callback_data: [a, expoId, boothId, expect].join('|') });
  if (act === 'ask') return kb([[k('❗ Тийм, цуцлах', 'free'), k('↩️ Үгүй', 'no')]]);
  if (act === 'no') return kb(tgButtonsFrom_(expoId, boothId, expect));
  if (!mark) return;
  kb([[{ text: '⏳ Хадгалж байна…', callback_data: 'x' }]]);
  try {
    if (act === 'ext') {
      const r = extendHold_(expoId, boothId, who);
      return tgEdit_(msg, msg.text + '\n\n⏳ ' + who.short + ' 24 цаг сунгасан · ' + hhmm_() + ' (' + left_(deadline_(r.e, r.b)) + ')', tgButtons_(r.e, r.b));
    }
    const r = changeStatus_({ id: expoId, boothId, status: act, expect }, who);
    tgEdit_(msg, msg.text + '\n\n' + mark + ' · ' + who.short + ' · ' + hhmm_(), tgButtons_(r.e, r.b));
    statusNotify_(r, who, who.chat);
  } catch (err) {
    const known = err && err.userMessage;
    if (!known) reportError_('telegram товч', err);
    // Алдааг мессеж дээр харуулж, одоогийн байдлаар шинэчилнэ
    try {
      const e = findExpo_(expoId), b = boothsOf_(e.id).find(x => String(x.boothId) === String(boothId));
      if (b) return tgEdit_(msg, tgCard_(e, b, catsOf_(e.id)) + '\n\n⚠️ ' + (known || 'Алдаа гарлаа. Дахин оролдоно уу.') + '\n(' + hhmm_() + '-ийн байдлаар шинэчлэгдсэн)', tgButtons_(e, b));
    } catch (x) {}
    tgSend_(who.chat, '⚠️ ' + (known || 'Алдаа гарлаа. Дахин оролдоно уу.'));
  }
}

/** "Үгүй" дарахад анхны товчнуудыг сэргээнэ (хүснэгт уншихгүй). */
function tgButtonsFrom_(expoId, boothId, st) { return tgButtons_({ id: expoId }, { boothId, status: st }); }

/** Түр захиалгын хугацааг 24 цагаар сунгана. */
function extendHold_(expoId, boothId, who) {
  const r = withLock_(() => {
    const e = findExpo_(expoId), b = boothsOf_(e.id).find(x => String(x.boothId) === String(boothId));
    if (!b) fail_('Лангуу олдсонгүй.');
    if (b.status !== 'held') fail_(b.code + ' лангуу одоо "' + ST_NAME[b.status || 'free'] + '" төлөвтэй тул сунгах боломжгүй.');
    const hold = e.holdHours * 3600e3, from = Math.max(heldMs_(b), Date.now() - hold); // дууссан бол одооноос
    b.heldAt = new Date(from + 24 * 3600e3);
    b.updatedAt = new Date(); b.updatedBy = who.name;
    writeRow_(SH.BOOTH, b);
    log_(e.id, b.code, 'хугацаа сунгасан', who.name, '24 цаг');
    return { e, b };
  });
  bump_(r.e);
  return r;
}

/**
 * Telegram товчнуудыг идэвхжүүлнэ. Кодыг шинэ хувилбараар deploy хийсний дараа нэг удаа ажиллуулна.
 * Дахин ажиллуулахад аюулгүй.
 */
function tgConnect() {
  if (!prop_('TELEGRAM_TOKEN')) { console.log('Эхлээд TELEGRAM_TOKEN тохиргоог нэмнэ үү.'); return; }
  let sec = prop_('TG_SECRET');
  if (!sec) { sec = Utilities.getUuid().replace(/-/g, ''); setProp_('TG_SECRET', sec); }
  const url = (prop_('WEB_APP_URL') || WEB_URL) + '?k=' + sec;
  const r = tg_('setWebhook', { url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  console.log(r.ok ? '✅ Товчнууд идэвхжлээ.' : 'АЛДАА: ' + JSON.stringify(r).slice(0, 200));
  tg_('setMyCommands', { commands: [
    { command: 'menu', description: 'Үндсэн цэс' },
    { command: 'status', description: 'Өнөөдрийн байдал' },
    { command: 'due', description: 'Авлага' },
    { command: 'soon', description: '24 цагт суллагдах лангуу' },
    { command: 'find', description: 'Утас, нэрээр хайх' },
    { command: 'orgs', description: 'Оролцогчид — шүүж харах' },
    { command: 'login', description: 'Ажилтан холбогдох: /login PIN' }
  ] });
  ids_('TELEGRAM_DIRECTOR').concat(ids_('TELEGRAM_ADMIN'), ids_('TELEGRAM_CHAT'), ids_('TELEGRAM_USERS')).filter((c, i, a) => a.indexOf(c) === i).forEach(chat => {
    const s = tgSend_(chat, '✅ Лангуу захиалгын товчнууд идэвхжлээ.\nШинэ захиалгын мэдэгдлийн доор төлбөр бүртгэх товч гарна. Цэсийг доороос эсвэл "Menu" товчоор нээнэ.', { inline_keyboard: tgMenuKb_() });
    console.log(chat + ': ' + (s.ok ? 'цэс илгээлээ' : 'АЛДАА ' + JSON.stringify(s).slice(0, 150)));
  });
  Utilities.sleep(1500);
  const info = tg_('getWebhookInfo', {}).result || {};
  if (info.last_error_message) console.log('Сүүлийн алдаа: ' + info.last_error_message);
}

/** Telegram товчны холболтыг шалгана: хүлээгдэж буй мессеж, сүүлийн алдаа. */
function tgCheck() {
  const t0 = Date.now(), r = tg_('getWebhookInfo', {}), i = r.result || {};
  if (!r.ok) { console.log('Telegram-д холбогдож чадсангүй: ' + JSON.stringify(r).slice(0, 200)); return; }
  console.log('Холбоос: ' + (i.url ? 'тохируулсан' : 'ТОХИРУУЛААГҮЙ — tgConnect ажиллуулна уу'));
  console.log('Хүлээгдэж буй: ' + (i.pending_update_count || 0));
  console.log('Сүүлийн алдаа: ' + (i.last_error_message ? i.last_error_message + ' (' + new Date(i.last_error_date * 1000) + ')' : 'алга ✅'));
  const t1 = Date.now(); readAll_(SH.BOOTH); console.log('Хүснэгт унших хугацаа: ' + (Date.now() - t1) + ' мс, Telegram хариу: ' + (t1 - t0) + ' мс');
}

/* ===================== VPS зуучлагчийг холбох ===================== */

/** VPS зуучлагчийг холбох 6 оронтой түр код (10 минут, нэг удаа). Токеныг хуулж буулгах шаардлагагүй болгоно. */
function relayCode() {
  if (!prop_('TELEGRAM_TOKEN')) { console.log('Эхлээд TELEGRAM_TOKEN тохиргоог нэмнэ үү.'); return; }
  if (!prop_('TG_SECRET')) setProp_('TG_SECRET', Utilities.getUuid().replace(/-/g, ''));
  const code = String(Math.floor(100000 + Math.random() * 900000)), c = CacheService.getScriptCache();
  c.put('relay_code', code, 600); c.remove('relay_fails');
  console.log('Код: ' + code + '  (10 минут хүчинтэй)');
  console.log('VPS дээр:  cd /opt/expo-relay && docker compose run --rm relay node relay.mjs pair ' + code);
}

function apiRelayPair_(req) {
  const c = CacheService.getScriptCache(), code = c.get('relay_code');
  if (!code) fail_('Код хүчингүй. Apps Script дээр relayCode-ийг дахин ажиллуулна уу.');
  if (str_(req.code, 10) !== code) {
    const n = num_(c.get('relay_fails')) + 1;
    if (n >= 5) { c.remove('relay_code'); c.remove('relay_fails'); notify_('tech', '🔐 Зуучлагч холбох код 5 удаа буруу оруулсан тул хүчингүй болголоо.'); }
    else c.put('relay_fails', String(n), 600);
    Utilities.sleep(1000);
    fail_('Код буруу байна.');
  }
  c.remove('relay_code'); c.remove('relay_fails');
  notify_('tech', '🔗 VPS зуучлагч холбогдлоо.');
  return { token: prop_('TELEGRAM_TOKEN'), key: prop_('TG_SECRET') };
}

/** Цэсийг бүх зөвшөөрөгдсөн чат руу илгээнэ (webhook-д хүрэхгүй, зуучлагчтай үед ашиглана). */
function tgSendMenu() {
  ids_('TELEGRAM_DIRECTOR').concat(ids_('TELEGRAM_ADMIN'), ids_('TELEGRAM_CHAT'), ids_('TELEGRAM_USERS')).filter((c, i, a) => a.indexOf(c) === i).forEach(chat => {
    const s = tgSend_(chat, 'Сая Мөнх · Лангуу захиалга\nДоорх товчийг дарна уу. Цэсийг дахин нээх бол /menu гэж бичнэ.', { inline_keyboard: tgMenuKb_() });
    console.log(chat + ': ' + (s.ok ? 'цэс илгээлээ' : 'АЛДАА ' + JSON.stringify(s).slice(0, 150)));
  });
}
