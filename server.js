// שבצ"ק - שרת (Node http בלבד). רץ מקומית עם קובץ, ובענן עם Upstash + קוד גישה.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3220;           // בענן (Render) הפורט מגיע ממשתנה סביבה
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- קוד גישה (מופעל רק אם הוגדר משתנה סביבה ACCESS_CODE — כלומר בענן) ---------- */
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const authRequired = () => ACCESS_CODE.length > 0;
const issuedToken = () => crypto.createHash('sha256').update('shibutz:' + ACCESS_CODE).digest('hex');
function codeOk(code) {
  const a = Buffer.from(String(code || '')), b = Buffer.from(ACCESS_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function tokenOk(req) {
  if (!authRequired()) return true;
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === issuedToken();
}

/* ---------- שמירת מצב: Upstash בענן, קובץ מקומי אחרת ---------- */
const useUpstash = () => !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
async function upstash(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
async function readStateStr() {
  if (useUpstash()) { try { const d = await upstash(['GET', 'shibutz_state']); return d && d.result ? d.result : null; } catch (e) { return null; } }
  try { return fs.readFileSync(STATE_FILE, 'utf8'); } catch (e) { return null; }
}
async function writeStateStr(str) {
  if (useUpstash()) { await upstash(['SET', 'shibutz_state', str]); return; }
  fs.writeFileSync(STATE_FILE, str, 'utf8');
}

/* ---------- מידע לשיתוף ---------- */
function lanUrls() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(net => {
    if ((net.family === 'IPv4' || net.family === 4) && !net.internal) out.push(`http://${net.address}:${PORT}`);
  }));
  return out;
}
function publicUrl() {
  try {
    const m = fs.readFileSync(TUNNEL_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return m && m.length ? m[m.length - 1] : null;
  } catch (e) { return null; }
}

/* ---------- HTTP ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
function sendJson(res, code, obj) {
  // תשובות API לעולם לא נשמרות במטמון (מונע מצב/הרשאה ישנים מהדפדפן)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(body));
}
// רק קבצי הסטטיק המותרים מוגשים — כך קבצי קוד/נתונים (server.js, state.json וכו') לא נחשפים
const STATIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'logo.png']);
function serveStatic(req, res) {
  let name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  if (name === '') name = 'index.html';
  if (!STATIC_FILES.has(name)) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      // הדפדפן חייב לאמת מול השרת בכל טעינה — כך עדכוני קוד/עיצוב מופיעים מיד ולא נתקעים במטמון
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // סטטוס אבטחה — ציבורי
  if (url === '/api/auth-status' && req.method === 'GET')
    return sendJson(res, 200, { required: authRequired() });

  // התחברות — ציבורי
  if (url === '/api/login' && req.method === 'POST') {
    return readBody(req, body => {
      let code; try { code = JSON.parse(body).code; } catch (e) { return sendJson(res, 400, { ok: false }); }
      if (codeOk(code)) sendJson(res, 200, { ok: true, token: issuedToken() });
      else sendJson(res, 401, { ok: false, error: 'קוד שגוי' });
    });
  }

  // מכאן ואילך — דורש קוד (אם הופעל)
  if (url.startsWith('/api/')) {
    if (!tokenOk(req)) return sendJson(res, 401, { ok: false, error: 'לא מורשה' });

    if (url === '/api/share-info' && req.method === 'GET')
      return sendJson(res, 200, { lan: lanUrls(), public: publicUrl(), port: PORT });

    if (url === '/api/state' && req.method === 'GET') {
      return readStateStr().then(str => {
        if (!str) return sendJson(res, 200, null);
        try { sendJson(res, 200, JSON.parse(str)); } catch (e) { sendJson(res, 200, null); }
      });
    }

    if (url === '/api/state' && req.method === 'POST') {
      return readBody(req, body => {
        try { JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON לא תקין' }); }
        writeStateStr(body).then(() => sendJson(res, 200, { ok: true }))
          .catch(err => sendJson(res, 500, { ok: false, error: String(err) }));
      });
    }

    return sendJson(res, 404, { ok: false });
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  שבצ"ק פועל על פורט ${PORT}`);
  if (authRequired()) console.log('  🔐 קוד גישה: מופעל');
  if (useUpstash()) console.log('  💾 שמירה: Upstash (ענן)');
  lanUrls().forEach(u => console.log(`  ברשת המקומית: ${u}`));
  console.log('');
});
