// GitHub → Google Apps Script автомат deploy (нэмэлт сан шаардлагагүй, Node 20+).
//
// Алхам: 1) одоогийн кодыг нөөцлөнө  2) зөвхөн "Code" файлыг солино (бусад файл, manifest хэвээр)
//        3) шинэ хувилбар үүсгэнэ  4) веб апп-ын deployment-ийг шинэ хувилбар руу шилжүүлнэ (URL өөрчлөгдөхгүй)
//        5) веб аппыг шалгана — ажиллахгүй бол deployment-ийг өмнөх хувилбар руу автоматаар буцаана.
//
// Орчны хувьсагч: CLASPRC_JSON (clasp login-оос), SCRIPT_ID, DEPLOYMENT_ID, BUILD (жишээ нь коммит), SRC (анхдагч apps-script/Code.gs)
import fs from 'fs';

const env = k => (process.env[k] || '').trim();
const die = m => { console.error('✗ ' + m); process.exit(1); };
const SCRIPT_ID = env('SCRIPT_ID'), DEPLOYMENT_ID = env('DEPLOYMENT_ID'), BUILD = env('BUILD') || 'github', SRC = env('SRC') || 'apps-script/Code.gs';
if (!SCRIPT_ID && !env('CLASPRC_JSON')) { console.log('::warning::Автомат deploy хараахан тохируулаагүй (CLASPRC_JSON, SCRIPT_ID secret алга) — алгаслаа. README → "Автомат deploy" хэсгийг үзнэ үү.'); process.exit(0); }
if (!SCRIPT_ID) die('SCRIPT_ID secret тохируулаагүй байна.');
if (!DEPLOYMENT_ID) die('DEPLOYMENT_ID тохируулаагүй байна.');

// clasp 2.x: {token:{refresh_token}, oauth2ClientSettings:{clientId,clientSecret}}; clasp 3.x: {tokens:{default:{client_id,client_secret,refresh_token}}}
let rc;
try { rc = JSON.parse(env('CLASPRC_JSON')); } catch (e) { die('CLASPRC_JSON secret буруу (JSON биш). ~/.clasprc.json файлын агуулгыг бүтнээр нь хуулна уу.'); }
const t3 = rc.tokens && (rc.tokens.default || Object.values(rc.tokens)[0]);
const cred = t3 ? { id: t3.client_id, secret: t3.client_secret, refresh: t3.refresh_token }
  : { id: rc.oauth2ClientSettings && rc.oauth2ClientSettings.clientId, secret: rc.oauth2ClientSettings && rc.oauth2ClientSettings.clientSecret, refresh: rc.token && rc.token.refresh_token };
if (!cred.id || !cred.secret || !cred.refresh) die('CLASPRC_JSON дотор refresh_token олдсонгүй. clasp login-ийг дахин хийнэ үү.');

async function http(method, url, body, token) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error_description || j.error)) || text.slice(0, 300);
    if (/has not been used|is disabled|SERVICE_DISABLED|User has not enabled the Apps Script API/i.test(msg)) die('Apps Script API идэвхгүй байна: https://script.google.com/home/usersettings хуудсанд "Google Apps Script API"-г ON болгоно уу.');
    if (r.status === 401 || /invalid_grant/i.test(msg)) die('Google нэвтрэлт хүчингүй боллоо. clasp login-ийг дахин хийж CLASPRC_JSON secret-ийг шинэчилнэ үү. (' + msg + ')');
    die(method + ' ' + url.replace(/\?.*/, '') + ' → ' + r.status + ': ' + msg);
  }
  return j || {};
}

const API = 'https://script.googleapis.com/v1/projects/' + SCRIPT_ID;
const tok = (await http('POST', 'https://oauth2.googleapis.com/token', { client_id: cred.id, client_secret: cred.secret, refresh_token: cred.refresh, grant_type: 'refresh_token' })).access_token;
if (!tok) die('Google access token авч чадсангүй.');

// 1) Одоогийн байдал
const content = await http('GET', API + '/content', null, tok);
const files = content.files || [];
fs.mkdirSync('deploy-backup', { recursive: true });
fs.writeFileSync('deploy-backup/previous-content.json', JSON.stringify(content, null, 1));
const code = files.find(f => f.name === 'Code' && f.type === 'SERVER_JS');
if (!code) die('Apps Script төсөлд "Code" нэртэй файл олдсонгүй. Байгаа файлууд: ' + files.map(f => f.name + ' (' + f.type + ')').join(', '));
const dep = await http('GET', API + '/deployments/' + DEPLOYMENT_ID, null, tok);
const prevVersion = dep.deploymentConfig && dep.deploymentConfig.versionNumber;
const webUrl = ((dep.entryPoints || []).find(e => e.entryPointType === 'WEB_APP') || {}).webApp?.url;
console.log('Одоогийн хувилбар: ' + (prevVersion || 'HEAD') + (webUrl ? ' · ' + webUrl : ''));

// 2) Код солих (BUILD тэмдгийг суулгана)
let src = fs.readFileSync(SRC, 'utf8');
if (!/^const BUILD = .*$/m.test(src)) die(SRC + ' дотор "const BUILD = ..." мөр алга.');
src = src.replace(/^const BUILD = .*$/m, 'const BUILD = ' + JSON.stringify(BUILD) + ';');
if (code.source === src) console.log('Код өөрчлөгдөөгүй — гэхдээ шинэ хувилбар үүсгэнэ.');
code.source = src;
await http('PUT', API + '/content', { scriptId: SCRIPT_ID, files }, tok);
console.log('✓ Код шинэчлэгдлээ (' + files.length + ' файл, бусад нь хэвээр).');

// 3) Хувилбар
const ver = await http('POST', API + '/versions', { description: 'GitHub ' + BUILD }, tok);
console.log('✓ Хувилбар ' + ver.versionNumber + ' үүслээ.');

// 4) Deployment шилжүүлэх
const setVersion = n => http('PUT', API + '/deployments/' + DEPLOYMENT_ID, { deploymentConfig: { scriptId: SCRIPT_ID, versionNumber: n, manifestFileName: 'appsscript', description: n === ver.versionNumber ? 'GitHub ' + BUILD : 'Буцаасан (автомат)' } }, tok);
await setVersion(ver.versionNumber);
console.log('✓ Веб апп хувилбар ' + ver.versionNumber + ' руу шилжлээ.');

// 5) Шалгах — ажиллахгүй бол буцаана
const url = webUrl || ('https://script.google.com/macros/s/' + DEPLOYMENT_ID + '/exec');
let ok = false, why = '';
for (let i = 1; i <= 3 && !ok; i++) {
  await new Promise(r => setTimeout(r, 4000 * i));
  try {
    const r = await fetch(url + '?a=list', { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    const j = JSON.parse(await r.text());
    ok = j.ok === true; why = ok ? '' : (j.error || 'ok=false');
  } catch (e) { why = e.message; }
  console.log('Шалгалт ' + i + ': ' + (ok ? 'амжилттай ✓' : 'алдаа — ' + why));
}
if (!ok) {
  if (prevVersion) { await setVersion(prevVersion); console.error('↩️ Веб аппыг өмнөх хувилбар ' + prevVersion + ' руу буцаалаа. Систем хуучнаараа ажиллаж байна.'); }
  die('Шинэ хувилбар ажиллахгүй байна: ' + why);
}
console.log('✅ Deploy амжилттай: ' + BUILD);
