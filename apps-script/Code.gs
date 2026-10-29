/**
 * Үзэсгэлэнгийн лангуу захиалгын систем — сервер (Google Apps Script)
 *
 * Өгөгдөл: энэ скрипт холбогдсон Google Sheets файл.
 * Тохиргоо (Project Settings → Script properties):
 *   CLAUDE_API_KEY   — зураг таних (заавал биш, байхгүй бол гараар тэмдэглэнэ)
 *   CLAUDE_MODEL     — заавал биш, анхдагч: claude-sonnet-5-5
 *   TELEGRAM_TOKEN   — мэдэгдэл илгээх ботын токен (заавал биш)
 *   TELEGRAM_CHAT    — мэдэгдэл очих чат/группын ID (заавал биш)
 *   ADMIN_PIN        — анхны захирлын нэвтрэх PIN (setup() ажиллуулахад ашиглана)
 *
 * Анх суулгахдаа setup() функцийг нэг удаа ажиллуулна.
 */

const SH = { EXPO: 'Үзэсгэлэн', CAT: 'Салбар', BOOTH: 'Лангуу', STAFF: 'Ажилтан', LOG: 'Түүх' };
const COLS = {
  'Үзэсгэлэн': ['id', 'name', 'start', 'end', 'imageId', 'imgW', 'imgH', 'status', 'holdHours', 'advancePct', 'createdAt', 'payInfo'],
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
  return handle_(body);
}

const PUBLIC = { expo: apiExpo_, image: apiImage_, book: apiBook_ };
const STAFF = {
  login: apiLogin_, expos: apiExpos_, createExpo: apiCreateExpo_, updateExpo: apiUpdateExpo_,
  staffExpo: apiStaffExpo_, uploadImage: apiUploadImage_, detect: apiDetect_,
  saveBooths: apiSaveBooths_, setStatus: apiSetStatus_
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
  const e = readAll_(SH.EXPO).find(x => String(x.id) === String(id));
  if (!e) fail_('Үзэсгэлэн олдсонгүй. Холбоосоо шалгана уу.');
  e.holdHours = num_(e.holdHours, 48) || 48;
  e.advancePct = num_(e.advancePct, 50) || 50;
  return e;
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
  });
  return freed;
}

function clearBooking_(b) {
  b.status = 'free'; b.price = ''; b.org = ''; b.person = ''; b.tel = ''; b.mail = ''; b.heldAt = '';
}

/* ===================== Нийтийн (оролцогчийн) API ===================== */

function apiExpo_(req) {
  const e = findExpo_(req.e);
  if (e.status !== 'open') fail_(e.status === 'closed' ? 'Энэ үзэсгэлэнгийн захиалга хаагдсан байна.' : 'Захиалга хараахан нээгдээгүй байна.');
  if (boothsOf_(e.id).some(b => b.status === 'held')) withLock_(() => expireHolds_(e.id));
  const cats = catsOf_(e.id);
  return {
    expo: { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), imageId: e.imageId, imgW: e.imgW, imgH: e.imgH, holdHours: e.holdHours, advancePct: e.advancePct, payInfo: String(e.payInfo || '') },
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
    return { e, b, price };
  });
  const adv = Math.round(res.price * res.e.advancePct / 100);
  notify_('🟨 Шинэ захиалга — ' + res.e.name + '\nЛангуу: ' + res.b.code + ' (' + res.b.m2 + ' м²)\n' + org + (person ? ', ' + person : '') + '\n📞 ' + tel + (mail ? '\n✉️ ' + mail : '') +
    '\nДүн: ' + fmt_(res.price) + '₮, урьдчилгаа ' + fmt_(adv) + '₮\n' + res.e.holdHours + ' цагийн дотор урьдчилгаа орохгүй бол автоматаар суллагдана.');
  return { booking: { code: String(res.b.code), price: res.price, advance: adv, holdHours: res.e.holdHours, org, payInfo: String(res.e.payInfo || '') } };
}

/* ===================== Ажилтны API ===================== */

function auth_(pin) {
  pin = str_(pin, 20);
  if (!pin) fail_('PIN кодоо оруулна уу.');
  const same = x => String(x.pin).trim() === pin || (/^\d+$/.test(pin) && /^\d+$/.test(String(x.pin).trim()) && Number(x.pin) === Number(pin));
  const s = readAll_(SH.STAFF).find(x => same(x) && String(x.active).toLowerCase() !== 'false' && String(x.active) !== 'үгүй');
  if (!s) { Utilities.sleep(800); fail_('PIN код буруу байна.'); }
  return { name: String(s.name), role: String(s.role || 'staff') };
}

function apiLogin_(req, who) { return { user: who }; }

function apiExpos_() {
  const booths = readAll_(SH.BOOTH);
  return {
    expos: readAll_(SH.EXPO).map(e => {
      const bs = booths.filter(b => String(b.expoId) === String(e.id));
      return { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), status: e.status || 'draft', booths: bs.length, booked: bs.filter(b => BOOKED[b.status]).length, hasImage: !!e.imageId };
    }).reverse()
  };
}

function apiCreateExpo_(req, who) {
  const name = str_(req.name, 120);
  if (!name) fail_('Үзэсгэлэнгийн нэрийг оруулна уу.');
  const id = uid_();
  withLock_(() => appendRows_(SH.EXPO, [{ id, name, start: str_(req.start, 20), end: str_(req.end, 20), status: 'draft', holdHours: 48, advancePct: 50, createdAt: new Date() }]));
  log_(id, '', 'үзэсгэлэн үүсгэсэн', who.name, name);
  return { id };
}

function apiUpdateExpo_(req, who) {
  return withLock_(() => {
    const e = findExpo_(req.id);
    if (req.name !== undefined) e.name = str_(req.name, 120) || e.name;
    if (req.start !== undefined) e.start = str_(req.start, 20);
    if (req.end !== undefined) e.end = str_(req.end, 20);
    if (req.holdHours !== undefined) e.holdHours = Math.max(1, Math.min(240, num_(req.holdHours, 48)));
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
    return { expo: { id: e.id, status: e.status } };
  });
}

function apiStaffExpo_(req) {
  const e = findExpo_(req.id);
  if (boothsOf_(e.id).some(b => b.status === 'held')) withLock_(() => expireHolds_(e.id));
  const cats = catsOf_(e.id);
  return {
    expo: { id: e.id, name: e.name, start: iso_(e.start), end: iso_(e.end), imageId: e.imageId, imgW: e.imgW, imgH: e.imgH, status: e.status || 'draft', holdHours: e.holdHours, advancePct: e.advancePct, payInfo: String(e.payInfo || '') },
    cats: cats.map(c => ({ id: c.catId, name: c.name, color: c.color, price: num_(c.price) })),
    booths: boothsOf_(e.id).map(b => ({
      id: b.boothId, code: String(b.code), x: num_(b.x), y: num_(b.y), w: num_(b.w), h: num_(b.h), m2: num_(b.m2), cat: b.catId, status: b.status || 'free',
      price: priceOf_(b, cats), org: b.org, person: b.person, tel: String(b.tel || ''), mail: b.mail,
      heldAt: b.heldAt instanceof Date ? b.heldAt.getTime() : (Date.parse(b.heldAt) || null), updatedBy: b.updatedBy
    })),
    now: Date.now()
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
    const cats = inC.map((c, i) => ({ expoId: e.id, catId: str_(c.id, 20) || ('c' + i), name: str_(c.name, 60) || ('Салбар ' + (i + 1)), color: str_(c.color, 9) || PALETTE[i % PALETTE.length], price: Math.max(0, num_(c.price)) }));
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
    return { saved: out.length };
  });
}

function apiSetStatus_(req, who) {
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
  if (!r.same) {
    const t = { free: '⬜ Цуцлагдсан', held: '🟨 Утсаар захиалга', adv: '🟧 Урьдчилгаа орсон', paid: '🟥 Бүрэн төлсөн' }[st];
    notify_(t + ' — ' + r.e.name + '\nЛангуу: ' + r.b.code + '\n' + (r.org || r.b.org || '') + '\nБүртгэсэн: ' + who.name);
  }
  return { status: st };
}

/* ===================== Мэдэгдэл, тайлан ===================== */

function notify_(text) {
  const token = prop_('TELEGRAM_TOKEN'), chat = prop_('TELEGRAM_CHAT');
  if (!token || !chat) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) {}
}

function reportError_(where, err) {
  try {
    console.error(where, err && err.stack || err);
    const c = CacheService.getScriptCache(), k = 'err_' + where;
    if (c.get(k)) return;
    c.put(k, '1', 600);
    notify_('⚠️ Системийн алдаа (' + where + '): ' + String(err && err.message || err).slice(0, 300));
  } catch (e) {}
}

/** Цаг тутам: хугацаа дууссан түр захиалгыг суллана. */
function hourlyJob() {
  const freed = withLock_(() => expireHolds_());
  if (!freed.length) return;
  const names = {}; readAll_(SH.EXPO).forEach(e => { names[e.id] = e.name; });
  notify_('⏰ Урьдчилгаа ороогүй тул суллагдсан:\n' + freed.map(f => '• ' + f.code + ' — ' + (f.org || '') + ' (' + (names[f.expoId] || '') + ')').join('\n'));
}

/** Өдөр бүр: нээлттэй үзэсгэлэн бүрийн товч тайлан. */
function dailyReport() {
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
  notify_('Өглөөний тайлан\n\n' + lines.join('\n\n'));
}

/* ===================== Анхны тохиргоо ===================== */

function setup() {
  Object.keys(COLS).forEach(sheet_);
  const def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('Хуудас1');
  if (def && ss_().getSheets().length > 1 && def.getLastRow() === 0) ss_().deleteSheet(def);
  folder_();
  if (!readAll_(SH.STAFF).length) {
    const pin = prop_('ADMIN_PIN') || String(Math.floor(100000 + Math.random() * 900000));
    appendRows_(SH.STAFF, [{ name: 'Захирал', pin: "'" + pin, role: 'admin', active: 'тийм' }]);
    console.log('Захирлын PIN: ' + pin + ' — "Ажилтан" хуудаснаас харж, өөрчилж болно.');
  }
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['hourlyJob', 'dailyReport'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(9).create();
  console.log('Тохиргоо дууслаа. Одоо Deploy → New deployment → Web app хийнэ үү.');
}

/** Telegram тохиргоог шалгах: ажиллуулахад туршилтын мессеж очно. */
function testTelegram() { notify_('✅ Үзэсгэлэнгийн захиалгын систем Telegram-тай холбогдлоо.'); }
