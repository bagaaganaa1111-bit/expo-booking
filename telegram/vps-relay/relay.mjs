// Telegram → Google Apps Script зуучлагч (VPS дээр, long polling).
// Ботоос шинэ мессежийг тасралтгүй асууж, Apps Script руу дамжуулна.
// Домэйн, HTTPS шаардлагагүй. Нэмэлт сан хэрэггүй (Node 22-ын fetch).
//
// Анх холбох:  node relay.mjs pair 123456   (кодыг Apps Script → relayCode гаргана)
import fs from 'fs';
const ENV_FILE = new URL('./.env', import.meta.url);
const fileEnv = {};
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) {}
const env = k => process.env[k] || fileEnv[k] || '';
const GAS = env('GAS_URL') || 'https://script.google.com/macros/s/AKfycbyIG0JUpqjVomlhgLR0aTFaDAyPsaseZGvfSR2GGjVZZtlDsAazwHS74kNfuEQPjfuE/exec';
const TG = env('TG_API') || 'https://api.telegram.org';

if (process.argv[2] === 'pair') {
  const code = String(process.argv[3] || '').trim();
  if (!/^\d{6}$/.test(code)) { console.error('6 оронтой код бичнэ үү: node relay.mjs pair 123456'); process.exit(1); }
  try {
    const r = await (await fetch(`${GAS}?a=relayPair&code=${code}`, { redirect: 'follow', signal: AbortSignal.timeout(60000) })).json();
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(1); }
    fs.writeFileSync(ENV_FILE, `TG_TOKEN=${r.token}\nTG_KEY=${r.key}\n`, { mode: 0o600 });
    console.log('✓ Холбогдлоо. Одоо:  docker compose up -d && docker compose logs -f');
    process.exit(0);
  } catch (e) { console.error('✗ Apps Script-д холбогдож чадсангүй: ' + e.message); process.exit(1); }
}

const TOKEN = env('TG_TOKEN');
const KEY = env('TG_KEY');
if (!TOKEN || !KEY) { console.error('Тохиргоо алга. Эхлээд:  docker compose run --rm relay node relay.mjs pair <код>'); await new Promise(r => setTimeout(r, 60000)); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ulaanbaatar' });
const log = (...a) => console.log(now(), ...a);

async function tg(method, body, ms = 70000) {
  const r = await fetch(`${TG}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms)
  });
  return r.json();
}

// Apps Script руу дамжуулна. Алдаа гарвал 3 удаа оролдоно (Apps Script давхардлыг update_id-аар шүүдэг).
async function forward(u) {
  const t0 = Date.now();
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${GAS}?k=${encodeURIComponent(KEY)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(u), redirect: 'follow', signal: AbortSignal.timeout(60000)
      });
      if (r.ok) { log('→', u.update_id, u.callback_query ? 'товч' : 'мессеж', (Date.now() - t0) + 'мс'); return; }
      log('Apps Script хариу', r.status, 'оролдлого', i);
    } catch (e) { log('Apps Script алдаа:', e.message, 'оролдлого', i); }
    await sleep(2000 * i);
  }
  log('ДАМЖУУЛЖ ЧАДСАНГҮЙ', u.update_id);
}

async function main() {
  const me = await tg('getMe', {}, 15000);
  if (!me.ok) { console.error('Токен буруу:', JSON.stringify(me)); await sleep(60000); process.exit(1); }
  await tg('deleteWebhook', { drop_pending_updates: false }, 15000);
  log('Зуучлагч ажиллаж эхэллээ: @' + me.result.username);
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (!r.ok) {
        log('getUpdates:', JSON.stringify(r).slice(0, 200));
        if (r.error_code === 409) await tg('deleteWebhook', {}, 15000); // хэн нэгэн tgConnect ажиллуулбал
        await sleep(5000); continue;
      }
      for (const u of r.result) { offset = u.update_id + 1; forward(u); } // зэрэг дамжуулна: хүлээлгэхгүй
    } catch (e) { log('Сүлжээ:', e.message); await sleep(3000); }
  }
}
main();
