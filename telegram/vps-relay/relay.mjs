// Telegram → Google Apps Script зуучлагч (VPS дээр, long polling).
// Ботоос шинэ мессежийг тасралтгүй асууж, Apps Script руу дамжуулна.
// Домэйн, HTTPS шаардлагагүй. Нэмэлт сан хэрэггүй (Node 22-ын fetch).
const TOKEN = process.env.TG_TOKEN;
const KEY = process.env.TG_KEY;
const GAS = process.env.GAS_URL || 'https://script.google.com/macros/s/AKfycbyIG0JUpqjVomlhgLR0aTFaDAyPsaseZGvfSR2GGjVZZtlDsAazwHS74kNfuEQPjfuE/exec';
const TG = process.env.TG_API || 'https://api.telegram.org';
if (!TOKEN || !KEY) { console.error('TG_TOKEN болон TG_KEY (.env) тохируулна уу'); process.exit(1); }

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
