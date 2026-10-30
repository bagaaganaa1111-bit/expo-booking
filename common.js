// Хоёр хуудсанд хамтдаа хэрэглэгдэх туслах функцууд
const $ = s => document.querySelector(s);
const fmt = n => Math.round(Number(n) || 0).toLocaleString("en-US");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(m, ms) {
  const t = $("#toast"); if (!t) return;
  t.textContent = m; t.hidden = false; clearTimeout(toast.k);
  toast.k = setTimeout(() => t.hidden = true, ms || 3800);
}

/** Сервер рүү хүсэлт илгээнэ. Алдаа гарвал хэрэглэгчид ойлгомжтой мессежтэй Error шиднэ. */
async function api(a, data, opts) {
  opts = opts || {};
  const url = window.EXPO_API;
  if (!url || /PASTE_/.test(url)) throw new Error("Системийн холбоос тохируулагдаагүй байна (config.js).");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ a }, data || {})), signal: ctl.signal, redirect: "follow" });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Сервер хариу өгөхгүй удаж байна. Дахин оролдоно уу." : "Интернэт холболтоо шалгаад дахин оролдоно уу.");
  } finally { clearTimeout(timer); }
  let j;
  try { j = await res.json(); } catch (e) { throw new Error("Серверээс буруу хариу ирлээ. Хэсэг хугацааны дараа дахин оролдоно уу."); }
  if (!j.ok) { const err = new Error(j.error || "Алдаа гарлаа."); err.server = true; throw err; }
  return j;
}

/** Талбайн зургийг авчирна. Нэг удаа татсан зургийг төхөөрөмж дээр хадгалж дахин ашиглана. */
async function loadImage(id) {
  const k = "expo-img-" + id;
  try { const c = localStorage.getItem(k); if (c) return c; } catch (e) {}
  const r = await api("image", { id }, { timeout: 45000 });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key && key.indexOf("expo-img-") === 0 && key !== k) localStorage.removeItem(key); }
    localStorage.setItem(k, r.data);
  } catch (e) {}
  return r.data;
}

/** Постер зургийг авчирна. Төхөөрөмж дээр хадгална; одоо харагдахгүй болсон постеруудыг цэвэрлэнэ. */
async function loadPoster(id, keep) {
  const k = "expo-poster-" + id;
  try { const c = localStorage.getItem(k); if (c) return c; } catch (e) {}
  const r = await api("image", { id }, { timeout: 45000 });
  try {
    if (keep) for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key && key.indexOf("expo-poster-") === 0 && keep.indexOf(key.slice(12)) < 0) localStorage.removeItem(key); }
    localStorage.setItem(k, r.data);
  } catch (e) {}
  return r.data;
}

/** Зургийг төхөөрөмж дээр жижигрүүлж JPEG болгоно (илгээхэд хурдан, хадгалахад бага). */
function shrinkImage(file, maxSide, quality) {
  return new Promise((ok, bad) => {
    if (!/^image\//.test(file.type)) return bad(new Error("JPG эсвэл PNG зураг сонгоно уу."));
    const rd = new FileReader();
    rd.onerror = () => bad(new Error("Зургийг уншиж чадсангүй."));
    rd.onload = () => {
      const im = new Image();
      im.onerror = () => bad(new Error("Зургийг нээж чадсангүй. Өөр зураг сонгоно уу."));
      im.onload = () => {
        const k = Math.min(1, maxSide / Math.max(im.width, im.height)), c = document.createElement("canvas");
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        let q = quality, d = c.toDataURL("image/jpeg", q);
        while (d.length > 400000 && q > 0.5) { q -= 0.1; d = c.toDataURL("image/jpeg", q); }
        ok({ data: d, w: c.width, h: c.height });
      };
      im.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

function pillHtml(st, pub) {
  const map = pub ? { free: ["free", "Сул"], held: ["held", "Түр барьсан"], sold: ["paid", "Захиалагдсан"] }
                  : { free: ["free", "Сул"], held: ["held", "Түр барьсан"], adv: ["adv", "Урьдчилгаа төлсөн"], paid: ["paid", "Бүрэн төлсөн"] };
  const m = map[st] || map.free;
  return '<span class="pill" style="color:var(--' + m[0] + ');border-color:var(--' + m[0] + ')">' + m[1] + "</span>";
}

/** Утсан дээр лангуутай хэсгийг дэлгэцэнд багтаж харагдахаар томруулж, тэр хэсэг рүү гүйлгэнэ. */
function fitBooths(booths, frame, small) {
  if (!booths.length) return { zoom: 100, scroll() {} };
  const y0 = Math.min(...booths.map(b => b.y)), x0 = Math.min(...booths.map(b => b.x)), x1 = Math.max(...booths.map(b => b.x + b.w));
  const span = Math.max(5, x1 - x0 + 3);
  const z = small ? Math.max(100, Math.min(320, Math.floor(10000 / span / 10) * 10)) : 100;
  return { zoom: z, scroll: () => { const pw = frame.firstElementChild.offsetWidth; frame.scrollLeft = Math.max(0, (x0 - 1.5) / 100 * pw); if (small) frame.scrollTop = Math.max(0, (y0 - 1.5) / 100 * frame.firstElementChild.offsetHeight); } };
}
