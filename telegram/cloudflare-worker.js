// Telegram → Google Apps Script зуучлагч.
// Telegram-д шууд "ok" (200) гэж хариулаад мессежийг ард нь Apps Script руу дамжуулна.
// Ингэснээр Google-ийн 302 хариуг Telegram алдаа гэж үзэж хойшлуулахгүй.
const GAS = 'https://script.google.com/macros/s/AKfycbyIG0JUpqjVomlhgLR0aTFaDAyPsaseZGvfSR2GGjVZZtlDsAazwHS74kNfuEQPjfuE/exec';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('ok');
    const search = new URL(request.url).search; // ?k=нууц түлхүүр
    const body = await request.text();
    ctx.waitUntil(fetch(GAS + search, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' }));
    return new Response('ok');
  }
};
