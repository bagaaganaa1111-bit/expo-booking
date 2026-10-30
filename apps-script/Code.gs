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

const SH = { EXPO: 'Үзэсгэлэн', CAT: 'Салбар', BOOTH: 'Лангуу', STAFF: 'Ажилтан', LOG: 'Түүх' };
const COLS = {
  'Үзэсгэлэн': ['id', 'name', 'start', 'end', 'imageId', 'imgW', 'imgH', 'status', 'holdHours', 'advancePct', 'createdAt', 'payInfo', 'slug', 'place', 'about'],
  'Салбар': ['expoId', 'catId', 'name', 'color', 'price'],
  'Лангуу': ['expoId', 'boothId', 'code', 'x', 'y', 'w', 'h', 'm2', 'catId', 'status', 'price', 'org', 'person', 'tel', 'mail', 'heldAt', 'updatedAt', 'updatedBy'],
  'Ажилтан': ['name', 'pin', 'role', 'active'],
  'Түүх': ['time', 'expoId', 'code', 'action', 'by', 'detail']
};
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
    return out_({ ok: true });
  }
  return handle_(body);
}

const PUBLIC = { list: apiList_, expo: apiExpo_, image: apiImage_, book: apiBook_ };
const STAFF = {
  login: apiLogin_, expos: apiExpos_, createExpo: apiCreateExpo_, updateExpo: apiUpdateExpo_,
  staffExpo: apiStaffExpo_, uploadImage: apiUploadImage_, detect: apiDetect_,
  saveBooths: apiSaveBooths_, setStatus: apiSetStatus_, staffList: apiStaffList_, staffSave: apiStaffSave_
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

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
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
  const now = Date.now(), expos = {}, freed = [];
  readAll_(SH.EXPO).forEach(e => { expos[e.id] = num_(e.holdHours, 48) || 48; });
  readAll_(SH.BOOTH).forEach(b => {
    if (b.status !== 'held' || (expoFilter && String(b.expoId) !== String(expoFilter))) return;
    const t = b.heldAt instanceof Date ? b.heldAt.getTime() : Date.parse(b.heldAt);
    if (!t || now - t < (expos[b.expoId] || 48) * 3600e3) return;
    freed.push({ expoId: b.expoId, code: b.code, org: b.org });
    clearBooking_(b); b.updatedAt = new Date(); b.updatedBy = 'систем';
    writeRow_(SH.BOOTH, b);
    log_(b.expoId, b.code, 'хугацаа дууссан', 'систем', '');
    bump_({ id: b.expoId, slug: (readAll_(SH.EXPO).find(x => String(x.id) === String(b.expoId)) || {}).slug });
  });
  return freed;
}

function clearBooking_(b) {
  b.status = 'free'; b.price = ''; b.org = ''; b.person = ''; b.tel = ''; b.mail = ''; b.heldAt = '';
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
    return { key: String(e.slug || e.id), name: String(e.name), start: iso_(e.start), end: iso_(e.end), place: String(e.place || ''), about: String(e.about || ''), open,
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
  if (!id || !readAll_(SH.EXPO).some(e => String(e.imageId) === id)) fail_('Зураг олдсонгүй.');
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
    const price = listPrice_(b, cats);
    Object.assign(b, { status: 'held', price, org, person, tel, mail, heldAt: new Date(), updatedAt: new Date(), updatedBy: 'оролцогч' });
    writeRow_(SH.BOOTH, b);
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
    expos: readAll_(SH.EXPO).map(e => {
      const bs = booths.filter(b => String(b.expoId) === String(e.id));
      return { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), status: e.status || 'draft', slug: String(e.slug || ''), booths: bs.length, booked: bs.filter(b => BOOKED[b.status]).length, hasImage: !!e.imageId };
    }).reverse()
  };
}

function apiCreateExpo_(req, who) {
  const name = str_(req.name, 120);
  if (!name) fail_('Үзэсгэлэнгийн нэрийг оруулна уу.');
  const id = uid_();
  withLock_(() => { const slug = slug_(req.slug, id); appendRows_(SH.EXPO, [{ id, name, slug, place: str_(req.place, 120), start: str_(req.start, 20), end: str_(req.end, 20), status: 'draft', holdHours: 48, advancePct: 50, createdAt: new Date() }]); });
  log_(id, '', 'үзэсгэлэн үүсгэсэн', who.name, name);
  bump_(null);
  return { id };
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
    expo: { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), imageId: e.imageId, imgW: e.imgW, imgH: e.imgH, status: e.status || 'draft', slug: String(e.slug || ''), place: String(e.place || ''), about: String(e.about || ''), holdHours: e.holdHours, advancePct: e.advancePct, payInfo: String(e.payInfo || '') },
    cats: cats.map(c => ({ id: c.catId, name: c.name, color: c.color, price: num_(c.price) })),
    booths: boothsOf_(e.id).map(b => ({
      id: b.boothId, code: String(b.code), x: num_(b.x), y: num_(b.y), w: num_(b.w), h: num_(b.h), m2: num_(b.m2), cat: b.catId, status: b.status || 'free',
      price: priceOf_(b, cats), org: b.org, person: b.person, tel: String(b.tel || ''), mail: b.mail,
      heldAt: b.heldAt instanceof Date ? b.heldAt.getTime() : (Date.parse(b.heldAt) || null), updatedBy: b.updatedBy
    })),
    now: Date.now(), layoutVer: layoutVer_(cats, boothsOf_(e.id))
  };
}

function folder_() {
  const id = prop_('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Үзэсгэлэнгийн талбайн зургууд');
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', f.getId());
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
      const org = b.org; clearBooking_(b); b.updatedAt = new Date(); b.updatedBy = who.name; writeRow_(SH.BOOTH, b);
      log_(e.id, b.code, 'цуцалсан', who.name, org); return { e, b, prev, org };
    }
    if (prev === 'free') {
      const org = str_(req.org, 120), tel = str_(req.tel, 20).replace(/[\s-]/g, '');
      if (!org) fail_('Байгууллагын нэрийг оруулна уу.');
      if (tel && !/^\d{8}$/.test(tel)) fail_('Утасны дугаар 8 оронтой байх ёстой.');
      Object.assign(b, { org, person: str_(req.person, 80), tel, mail: str_(req.mail, 120), price: listPrice_(b, cats) });
      if (st === 'held') b.heldAt = new Date();
    }
    b.status = st; if (st !== 'held') b.heldAt = b.heldAt || '';
    b.updatedAt = new Date(); b.updatedBy = who.name; writeRow_(SH.BOOTH, b);
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
    if (cur) { Object.assign(cur, o); writeRow_(SH.STAFF, cur); } else appendRows_(SH.STAFF, [o]);
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
  const g = prop_('TELEGRAM_CHAT'), d = prop_('TELEGRAM_DIRECTOR'), a = prop_('TELEGRAM_ADMIN');
  const to = kind === 'ops' ? [g, d] : kind === 'report' ? [d || a] : kind === 'tech' ? [a || d] : [g, d, a];
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

/* ===================== Анхны тохиргоо ===================== */

function setup() {
  Object.keys(COLS).forEach(name => {
    const sh = sheet_(name);
    // Багана нэмэгдсэн бол гарчгийн мөрийг шинэчилнэ (шинэ багана үргэлж төгсгөлд нэмэгддэг)
    sh.getRange(1, 1, 1, COLS[name].length).setValues([COLS[name]]).setFontWeight('bold');
    // Хүснэгтийг гараар засахаас хамгаална: зөвхөн эзэмшигч засна, систем хэвийн бичнэ
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
    if (['hourlyJob', 'dailyReport'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(9).create();
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
const TG_MENU = [['📊 Өнөөдрийн байдал', 'status'], ['💰 Авлага', 'due'], ['⏰ Хугацаа дуусах', 'soon'], ['🔎 Хайх', 'find']];

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
function tgMenuKb_() {
  return [TG_MENU.slice(0, 2).map(m => ({ text: m[0], callback_data: 'm|' + m[1] })), TG_MENU.slice(2).map(m => ({ text: m[0], callback_data: 'm|' + m[1] }))];
}
function hhmm_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), 'HH:mm'); }

/** Зөвхөн тохируулсан чатуудаас ирсэн командыг хүлээн авна. */
function tgWho_(chatId, from) {
  const id = String(chatId || '');
  if (!id) return null;
  const boss = [prop_('TELEGRAM_DIRECTOR'), prop_('TELEGRAM_ADMIN')].filter(Boolean).map(String).indexOf(id) >= 0;
  const staff = !boss && prop_('TELEGRAM_CHAT') && String(prop_('TELEGRAM_CHAT')) === id;
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
  const who = tgWho_(m.chat.id, m.from);
  if (!who) { tgRemember_(m.chat); return; }
  const text = String(m.text || '').trim();
  if (!text) return;
  const cmd = text.split(/[\s@]/)[0].toLowerCase(), fk = 'tgf_' + who.chat + '_' + (m.from && m.from.id);
  if (cmd === '/start' || cmd === '/menu') return tgSend_(who.chat, 'Сая Мөнх · Лангуу захиалга\nДоорх товчийг дарна уу.', { inline_keyboard: tgMenuKb_() });
  const hit = TG_MENU.find(x => text === x[0] || cmd === '/' + x[1]);
  if (hit) return tgMenuDo_(hit[1], who, m.from, m.message_id);
  const toBot = m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.is_bot;
  if (cache.get(fk) || toBot || /^\d{8}$/.test(text.replace(/[\s-]/g, ''))) { cache.remove(fk); return tgFind_(who, text); }
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

function tgCallback_(q) {
  const msg = q.message || {}, who = tgWho_(msg.chat && msg.chat.id, q.from);
  const ans = (text, alert) => tg_('answerCallbackQuery', { callback_query_id: q.id, text: text || '', show_alert: !!alert });
  if (!who) return ans('Энэ чатаас үйлдэл хийх эрхгүй.', true);
  const [act, expoId, boothId, expect] = String(q.data || '').split('|');
  if (act === 'm') { ans(); return tgMenuDo_(expoId, who, q.from, null); }
  const current = () => {
    const e = findExpo_(expoId), b = boothsOf_(e.id).find(x => String(x.boothId) === String(boothId));
    return { e, b };
  };
  try {
    if (act === 'ask') {
      ans();
      const k = (t, a) => ({ text: t, callback_data: [a, expoId, boothId, expect].join('|') });
      return tg_('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [[k('❗ Тийм, цуцлах', 'free'), k('↩️ Үгүй', 'no')]] } });
    }
    if (act === 'no') {
      ans('Цуцлаагүй.');
      const c = current();
      return tg_('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: c.b ? tgButtons_(c.e, c.b) : [] } });
    }
    if (act === 'ext') {
      const r = extendHold_(expoId, boothId, who);
      ans('24 цагаар сунгалаа.');
      return tgEdit_(msg, msg.text + '\n\n⏳ ' + who.short + ' 24 цаг сунгасан · ' + hhmm_() + ' (' + left_(deadline_(r.e, r.b)) + ')', tgButtons_(r.e, r.b));
    }
    if (act === 'adv' || act === 'paid' || act === 'free') {
      const r = changeStatus_({ id: expoId, boothId, status: act, expect }, who);
      const mark = { adv: '✅ Урьдчилгаа орсон', paid: '💵 Бүрэн төлсөн', free: '❌ Цуцалсан' }[act];
      ans(mark + ' — хадгаллаа.');
      tgEdit_(msg, msg.text + '\n\n' + mark + ' · ' + who.short + ' · ' + hhmm_(), tgButtons_(r.e, r.b));
      return statusNotify_(r, who, who.chat);
    }
    ans();
  } catch (err) {
    if (!(err && err.userMessage)) { reportError_('telegram товч', err); return ans('Алдаа гарлаа. Дахин оролдоно уу.', true); }
    ans(err.userMessage, true);
    // Хуучирсан мэдэгдлийг одоогийн байдлаар шинэчилнэ
    try { const c = current(); if (c.b) tgEdit_(msg, tgCard_(c.e, c.b, catsOf_(c.e.id)) + '\n\n(' + hhmm_() + '-ийн байдлаар шинэчлэгдсэн)', tgButtons_(c.e, c.b)); } catch (x) {}
  }
}

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
  const P = PropertiesService.getScriptProperties();
  let sec = prop_('TG_SECRET');
  if (!sec) { sec = Utilities.getUuid().replace(/-/g, ''); P.setProperty('TG_SECRET', sec); }
  const url = (prop_('WEB_APP_URL') || WEB_URL) + '?k=' + sec;
  const r = tg_('setWebhook', { url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  console.log(r.ok ? '✅ Товчнууд идэвхжлээ.' : 'АЛДАА: ' + JSON.stringify(r).slice(0, 200));
  tg_('setMyCommands', { commands: [
    { command: 'menu', description: 'Үндсэн цэс' },
    { command: 'status', description: 'Өнөөдрийн байдал' },
    { command: 'due', description: 'Авлага' },
    { command: 'soon', description: '24 цагт суллагдах лангуу' },
    { command: 'find', description: 'Утас, нэрээр хайх' }
  ] });
  [prop_('TELEGRAM_DIRECTOR'), prop_('TELEGRAM_ADMIN'), prop_('TELEGRAM_CHAT')].filter((c, i, a) => c && a.indexOf(c) === i).forEach(chat => {
    const s = tgSend_(chat, '✅ Лангуу захиалгын товчнууд идэвхжлээ.\nШинэ захиалгын мэдэгдлийн доор төлбөр бүртгэх товч гарна. Цэсийг доороос эсвэл "Menu" товчоор нээнэ.', { inline_keyboard: tgMenuKb_() });
    console.log(chat + ': ' + (s.ok ? 'цэс илгээлээ' : 'АЛДАА ' + JSON.stringify(s).slice(0, 150)));
  });
  Utilities.sleep(1500);
  const info = tg_('getWebhookInfo', {}).result || {};
  if (info.last_error_message) console.log('Сүүлийн алдаа: ' + info.last_error_message);
}
