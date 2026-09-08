import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 5600);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = String(process.env.SESSION_SECRET || 'change-this-session-secret');
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB = String(process.env.MONGODB_DB || 'fakenewsdetect').trim();

let mongoClient = null;
let mongoDb = null;
let mongoError = null;

function mongoConfigured() {
  return Boolean(MONGODB_URI && !MONGODB_URI.includes('PASTE_YOUR'));
}
async function connectMongo() {
  if (!mongoConfigured()) {
    mongoError = new Error('MONGODB_URI is not configured.');
    return null;
  }
  if (mongoDb) return mongoDb;
  try {
    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB);
    await Promise.all([
      mongoDb.collection('users').createIndex({ email: 1 }, { unique: true }),
      mongoDb.collection('history').createIndex({ owner: 1, createdAt: -1 }),
      mongoDb.collection('saved').createIndex({ owner: 1, savedAt: -1 }),
      mongoDb.collection('saved').createIndex({ owner: 1, historyId: 1 }, { unique: true, sparse: true })
    ]);
    mongoError = null;
    console.log(`MongoDB: connected (${MONGODB_DB})`);
    return mongoDb;
  } catch (error) {
    mongoError = error;
    console.error('MongoDB connection error:', error.message);
    try { await mongoClient?.close(); } catch {}
    mongoClient = null;
    mongoDb = null;
    return null;
  }
}
async function dbOrThrow() {
  const db = mongoDb || await connectMongo();
  if (!db) throw Object.assign(new Error('MongoDB is not connected. Add MONGODB_URI in .env/Render and restart.'), { status: 503 });
  return db;
}

function id(prefix = 'id') { return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`; }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored = '') {
  try {
    const [kind, salt, expectedHex] = String(stored).split('$');
    if (kind !== 'scrypt' || !salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}
function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  if (!current) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', Array.isArray(current) ? [...current, value] : [current, value]);
}
function cookieSecure() { return process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER); }
function b64url(value) { return Buffer.from(value).toString('base64url'); }
function createSessionToken(userId) {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySessionToken(token = '') {
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.uid || Number(parsed.exp) < Date.now()) return null;
    return String(parsed.uid);
  } catch { return null; }
}
function setAuthCookie(res, userId) {
  appendCookie(res, `ngsid=${encodeURIComponent(createSessionToken(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${cookieSecure() ? '; Secure' : ''}`);
}
function clearAuthCookie(res) {
  appendCookie(res, `ngsid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure() ? '; Secure' : ''}`);
}
function getIdentity(req, res) {
  const cookies = parseCookies(req);
  let guestId = cookies.ngguest;
  if (!guestId || !/^guest_[a-zA-Z0-9_]+$/.test(guestId)) {
    guestId = id('guest');
    appendCookie(res, `ngguest=${encodeURIComponent(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${cookieSecure() ? '; Secure' : ''}`);
  }
  const userId = verifySessionToken(cookies.ngsid || '');
  return { guestId, userId, owner: userId ? `user:${userId}` : `guest:${guestId}` };
}
function publicUser(user) {
  return user ? { id: user.id, fullName: user.fullName, email: user.email, bio: user.bio || '', notifications: user.notifications !== false, createdAt: user.createdAt || null } : null;
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
async function readJson(req, maxBytes = 12 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON request.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function geminiConfigured() {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && !key.includes('PASTE_YOUR'));
}
function firebaseConfigured() {
  const key = String(process.env.FIREBASE_API_KEY || '').trim();
  return Boolean(key && !key.includes('PASTE_YOUR'));
}
function firebaseErrorMessage(code = '') {
  const c = String(code).split(' : ')[0].trim();
  const map = {
    EMAIL_EXISTS: 'This email already exists in Firebase.',
    OPERATION_NOT_ALLOWED: 'Enable Email/Password in Firebase Authentication.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Please try again later.',
    EMAIL_NOT_FOUND: 'No Firebase reset account exists for this email.',
    INVALID_PASSWORD: 'Invalid password.',
    INVALID_LOGIN_CREDENTIALS: 'Invalid credentials.',
    USER_DISABLED: 'This Firebase account has been disabled.',
    INVALID_EMAIL: 'Enter a valid email address.',
    WEAK_PASSWORD: 'Password must be at least 6 characters.',
    RESET_PASSWORD_EXCEED_LIMIT: 'Too many reset requests. Try again later.',
    EXPIRED_OOB_CODE: 'This password reset link has expired.',
    INVALID_OOB_CODE: 'This password reset link is invalid or already used.'
  };
  return map[c] || c.replaceAll('_', ' ').toLowerCase().replace(/^./, s => s.toUpperCase()) || 'Firebase request failed.';
}
async function firebaseCall(action, payload) {
  if (!firebaseConfigured()) throw Object.assign(new Error('Firebase API key is not configured. Add FIREBASE_API_KEY to the server environment.'), { status: 503 });
  const apiKey = String(process.env.FIREBASE_API_KEY).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const raw = data?.error?.message || `Firebase error (${response.status})`;
      throw Object.assign(new Error(firebaseErrorMessage(raw)), { status: response.status === 400 ? 400 : 502, firebaseCode: raw });
    }
    return data;
  } finally { clearTimeout(timer); }
}
async function mirrorFirebaseSignup(email, password, fullName) {
  if (!firebaseConfigured()) return { ready: false, warning: 'Firebase reset is not configured yet.' };
  try {
    const auth = await firebaseCall('signUp', { email, password, returnSecureToken: true });
    try { await firebaseCall('update', { idToken: auth.idToken, displayName: fullName, returnSecureToken: false }); } catch {}
    return { ready: true, firebaseUid: auth.localId || '' };
  } catch (error) {
    if (String(error.firebaseCode || '').startsWith('EMAIL_EXISTS')) return { ready: true, warning: 'Firebase reset account already existed.' };
    return { ready: false, warning: `MongoDB account created, but Firebase reset mirror failed: ${error.message}` };
  }
}
async function bestEffortFirebasePasswordSync(email, oldPassword, newPassword) {
  if (!firebaseConfigured()) return false;
  try {
    const auth = await firebaseCall('signInWithPassword', { email, password: oldPassword, returnSecureToken: true });
    await firebaseCall('update', { idToken: auth.idToken, password: newPassword, returnSecureToken: false });
    return true;
  } catch { return false; }
}

function htmlToText(html) {
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ').replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('10.') || h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) || h.endsWith('.local');
}
async function fetchArticleText(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only http/https URLs are supported.'), { status: 400 });
  if (isPrivateHost(url.hostname)) throw Object.assign(new Error('Local/private URLs are not allowed.'), { status: 400 });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 FakeNewsDetect/5.0' } });
    if (!response.ok) throw new Error(`Article returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('text/plain')) throw new Error('URL does not point to readable HTML/text.');
    const text = htmlToText(await response.text());
    if (text.length < 80) throw new Error('Could not extract enough article text from this URL.');
    return text.slice(0, 18000);
  } finally { clearTimeout(timer); }
}
function normalizeVerdict(v = '') { const s = String(v).toLowerCase(); if (s.includes('real') || s.includes('true')) return 'Real'; if (s.includes('mislead')) return 'Misleading'; if (s.includes('fake') || s.includes('false')) return 'Fake'; return 'Unverified'; }
function sanitizeAnalysis(obj, sourceType, originalInput) {
  return {
    verdict: normalizeVerdict(obj?.verdict), confidence: Math.max(0, Math.min(100, Math.round(Number(obj?.confidence) || 50))),
    headline: String(obj?.headline || obj?.claim || originalInput || 'Analyzed news').slice(0, 500),
    summary: String(obj?.summary || 'No summary was returned.').slice(0, 1800),
    reasons: Array.isArray(obj?.reasons) && obj.reasons.length ? obj.reasons.filter(Boolean).slice(0, 5) : ['The model did not return detailed reasons.'],
    warningSigns: Array.isArray(obj?.warningSigns) ? obj.warningSigns.filter(Boolean).slice(0, 6) : [],
    trustedSources: Array.isArray(obj?.trustedSources) ? obj.trustedSources.slice(0, 4).map(s => ({ name: String(s?.name || 'Trusted source'), url: /^https?:\/\//i.test(String(s?.url || '')) ? String(s.url) : '', note: String(s?.note || '') })) : [],
    sourceType, checkedAt: new Date().toISOString(), provider: 'Gemini API'
  };
}
async function runGemini({ text, imageBase64, imageMime }) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiConfigured()) throw Object.assign(new Error('Gemini API key is not configured. Add GEMINI_API_KEY to the server environment.'), { status: 503 });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const system = `You are a careful news-verification assistant. Assess supplied content as exactly one of Real, Fake, Misleading, or Unverified. Do not invent facts or citations. If evidence is insufficient, ambiguous, or too current to verify confidently, prefer Unverified. Confidence is confidence in the classification, not probability the claim is true. Explain uncertainty. For trustedSources, only suggest well-known primary institutions, established reputable outlets, or recognized fact-checkers. Do not fabricate deep links.`;
  const prompt = `Analyze this news content for misinformation. Return a concise mobile-app fact-check result.\n\nCONTENT:\n${text || 'The news claim is contained in the attached image.'}`;
  const parts = [{ text: prompt }];
  if (imageBase64) parts.unshift({ inlineData: { mimeType: imageMime, data: imageBase64 } });
  const schema = { type: 'OBJECT', properties: { verdict: { type: 'STRING', enum: ['Real', 'Fake', 'Misleading', 'Unverified'] }, confidence: { type: 'INTEGER' }, headline: { type: 'STRING' }, summary: { type: 'STRING' }, reasons: { type: 'ARRAY', items: { type: 'STRING' } }, warningSigns: { type: 'ARRAY', items: { type: 'STRING' } }, trustedSources: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, url: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['name', 'url', 'note'] } } }, required: ['verdict', 'confidence', 'headline', 'summary', 'reasons', 'warningSigns', 'trustedSources'] };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'x-goog-api-client': 'fakenewsdetect/5.0' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini API error (${response.status}).`), { status: 502 });
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
  if (!raw) throw Object.assign(new Error('Gemini returned no analysis.'), { status: 502 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Gemini returned an unreadable JSON result.'), { status: 502 }); }
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? 'Page/index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(__dirname, rel);
  return full.startsWith(path.resolve(__dirname) + path.sep) ? full : null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  const full = safeStaticPath(req.url); if (!full) return sendText(res, 403, 'Forbidden');
  let target = full;
  try { if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html'); } catch {}
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return sendText(res, 404, 'Not found');
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=60' });
  fs.createReadStream(target).pipe(res);
}

async function profileStats(db, owner) {
  const [checked, fake, real] = await Promise.all([
    db.collection('history').countDocuments({ owner }),
    db.collection('history').countDocuments({ owner, 'analysis.verdict': { $in: ['Fake', 'Misleading'] } }),
    db.collection('history').countDocuments({ owner, 'analysis.verdict': 'Real' })
  ]);
  return { checked, fake, real };
}

async function handleApi(req, res, url) {
  const identity = getIdentity(req, res);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const db = mongoDb;
    const user = db && identity.userId ? await db.collection('users').findOne({ id: identity.userId }) : null;
    return sendJson(res, 200, {
      success: true,
      mongoConfigured: mongoConfigured(),
      mongoConnected: Boolean(mongoDb),
      mongoError: mongoError ? mongoError.message : null,
      firebaseConfigured: firebaseConfigured(),
      geminiConfigured: geminiConfigured(),
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      user: publicUser(user)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/signup') {
    const db = await dbOrThrow();
    const body = await readJson(req, 100000);
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (fullName.length < 2) return sendJson(res, 400, { success: false, error: 'Enter your full name.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return sendJson(res, 400, { success: false, error: 'Enter a valid email.' });
    if (password.length < 6) return sendJson(res, 400, { success: false, error: 'Password must be at least 6 characters.' });
    if (await db.collection('users').findOne({ email })) return sendJson(res, 409, { success: false, error: 'This email is already registered.' });

    const mirror = await mirrorFirebaseSignup(email, password, fullName);
    const user = { id: id('user'), fullName, email, passwordHash: hashPassword(password), bio: '', notifications: true, createdAt: new Date().toISOString(), firebaseResetReady: mirror.ready, firebaseUid: mirror.firebaseUid || null };
    await db.collection('users').insertOne(user);
    setAuthCookie(res, user.id);
    return sendJson(res, 200, { success: true, user: publicUser(user), warning: mirror.warning || null });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const db = await dbOrThrow();
    const body = await readJson(req, 100000);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await db.collection('users').findOne({ email });
    if (!user) return sendJson(res, 401, { success: false, error: 'Invalid email or password.' });
    let valid = verifyPassword(password, user.passwordHash);
    let syncedFromFirebaseReset = false;
    if (!valid && firebaseConfigured()) {
      try {
        await firebaseCall('signInWithPassword', { email, password, returnSecureToken: false });
        valid = true;
        syncedFromFirebaseReset = true;
        user.passwordHash = hashPassword(password);
        user.firebaseResetReady = true;
        user.updatedAt = new Date().toISOString();
        await db.collection('users').updateOne({ id: user.id }, { $set: { passwordHash: user.passwordHash, firebaseResetReady: true, updatedAt: user.updatedAt } });
      } catch { /* Invalid in both MongoDB and Firebase. */ }
    }
    if (!valid) return sendJson(res, 401, { success: false, error: 'Invalid email or password.' });
    setAuthCookie(res, user.id);
    return sendJson(res, 200, { success: true, user: publicUser(user), passwordSyncedFromFirebaseReset: syncedFromFirebaseReset });
  }

  // Firebase is intentionally kept ONLY for the forgot/reset email flow.
  if (req.method === 'POST' && url.pathname === '/api/forgot-password') {
    const body = await readJson(req, 100000);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return sendJson(res, 400, { success: false, error: 'Enter a valid email.' });
    try { await firebaseCall('sendOobCode', { requestType: 'PASSWORD_RESET', email }); }
    catch (error) {
      if (String(error.firebaseCode || '').startsWith('EMAIL_NOT_FOUND')) return sendJson(res, 200, { success: true, message: 'If an account exists for that email, a reset link will be sent.' });
      throw error;
    }
    return sendJson(res, 200, { success: true, message: 'Firebase password reset email sent. Check your inbox and spam folder.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/firebase-reset/verify') {
    const body = await readJson(req, 100000);
    const oobCode = String(body.oobCode || '').trim();
    if (!oobCode) return sendJson(res, 400, { success: false, error: 'Reset code is missing.' });
    const data = await firebaseCall('resetPassword', { oobCode });
    return sendJson(res, 200, { success: true, email: data.email || '' });
  }

  if (req.method === 'POST' && url.pathname === '/api/firebase-reset/confirm') {
    const db = await dbOrThrow();
    const body = await readJson(req, 100000);
    const oobCode = String(body.oobCode || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!oobCode) return sendJson(res, 400, { success: false, error: 'Reset code is missing.' });
    if (newPassword.length < 6) return sendJson(res, 400, { success: false, error: 'New password must be at least 6 characters.' });
    const data = await firebaseCall('resetPassword', { oobCode, newPassword });
    const email = String(data.email || '').trim().toLowerCase();
    if (!email) return sendJson(res, 502, { success: false, error: 'Firebase did not return the account email.' });
    const result = await db.collection('users').updateOne({ email }, { $set: { passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString(), firebaseResetReady: true } });
    if (!result.matchedCount) return sendJson(res, 404, { success: false, error: 'Password changed in Firebase, but matching MongoDB user was not found.' });
    return sendJson(res, 200, { success: true, message: 'Password reset successfully. You can sign in now.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/change-password') {
    const db = await dbOrThrow();
    if (!identity.userId) return sendJson(res, 401, { success: false, error: 'Please sign in to change your password.' });
    const body = await readJson(req, 100000);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) return sendJson(res, 400, { success: false, error: 'New password must be at least 6 characters.' });
    if (currentPassword === newPassword) return sendJson(res, 400, { success: false, error: 'Choose a different new password.' });
    const user = await db.collection('users').findOne({ id: identity.userId });
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return sendJson(res, 401, { success: false, error: 'Current password is incorrect.' });
    const firebaseSynced = await bestEffortFirebasePasswordSync(user.email, currentPassword, newPassword);
    await db.collection('users').updateOne({ id: user.id }, { $set: { passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString(), firebaseResetReady: user.firebaseResetReady || firebaseSynced } });
    return sendJson(res, 200, { success: true, message: firebaseSynced ? 'Password changed in MongoDB and Firebase reset mirror.' : 'Password changed in MongoDB.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    clearAuthCookie(res);
    return sendJson(res, 200, { success: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/profile') {
    const db = await dbOrThrow();
    const user = identity.userId ? await db.collection('users').findOne({ id: identity.userId }) : null;
    return sendJson(res, 200, { success: true, guest: !user, user: publicUser(user), stats: await profileStats(db, identity.owner) });
  }

  if (req.method === 'PUT' && url.pathname === '/api/profile') {
    const db = await dbOrThrow();
    if (!identity.userId) return sendJson(res, 401, { success: false, error: 'Login to edit your profile.' });
    const body = await readJson(req, 100000);
    const fullName = String(body.fullName || '').trim();
    const bio = String(body.bio || '').trim().slice(0, 500);
    if (fullName.length < 2) return sendJson(res, 400, { success: false, error: 'Enter your full name.' });
    const result = await db.collection('users').findOneAndUpdate({ id: identity.userId }, { $set: { fullName, bio, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
    if (!result) return sendJson(res, 404, { success: false, error: 'User not found.' });
    return sendJson(res, 200, { success: true, user: publicUser(result), message: 'Profile updated in MongoDB.' });
  }

  if (req.method === 'PUT' && url.pathname === '/api/preferences') {
    const db = await dbOrThrow();
    if (!identity.userId) return sendJson(res, 401, { success: false, error: 'Login to save account preferences.' });
    const body = await readJson(req, 100000);
    const patch = {};
    if (typeof body.notifications === 'boolean') patch.notifications = body.notifications;
    const result = await db.collection('users').findOneAndUpdate({ id: identity.userId }, { $set: { ...patch, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
    return sendJson(res, 200, { success: true, user: publicUser(result) });
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const db = await dbOrThrow();
    const body = await readJson(req, 12 * 1024 * 1024);
    const mode = String(body.mode || 'text');
    let originalInput = '', analysisText = '', sourceType = 'Pasted Text', imageBase64 = '', imageMime = '';
    if (mode === 'image') {
      imageBase64 = String(body.imageBase64 || ''); imageMime = String(body.imageMime || '');
      if (!imageBase64) return sendJson(res, 400, { success: false, error: 'Choose an image first.' });
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageMime)) return sendJson(res, 400, { success: false, error: 'Use JPG, PNG, or WEBP image.' });
      if (Buffer.byteLength(imageBase64, 'base64') > 8 * 1024 * 1024) return sendJson(res, 413, { success: false, error: 'Image must be 8 MB or smaller.' });
      originalInput = String(body.imageName || 'Uploaded image').slice(0, 300); sourceType = 'Uploaded Image';
    } else if (mode === 'url') {
      const raw = String(body.url || '').trim();
      if (!raw) return sendJson(res, 400, { success: false, error: 'Paste an article URL.' });
      originalInput = raw; sourceType = 'Article URL'; analysisText = `Article URL: ${raw}\n\nExtracted article text:\n${await fetchArticleText(raw)}`;
    } else {
      const text = String(body.text || '').trim();
      if (text.length < 8) return sendJson(res, 400, { success: false, error: 'Enter a longer news claim or article text.' });
      originalInput = text; analysisText = text.slice(0, 18000);
    }
    const rawAnalysis = await runGemini({ text: analysisText, imageBase64, imageMime });
    const analysis = sanitizeAnalysis(rawAnalysis, sourceType, originalInput);
    const item = { id: id('history'), owner: identity.owner, input: originalInput, mode, analysis, createdAt: new Date().toISOString() };
    await db.collection('history').insertOne(item);
    return sendJson(res, 200, { success: true, item });
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    const db = await dbOrThrow();
    const history = await db.collection('history').find({ owner: identity.owner }).sort({ createdAt: -1 }).limit(500).project({ _id: 0 }).toArray();
    return sendJson(res, 200, { success: true, history });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    const db = await dbOrThrow();
    const result = await db.collection('history').deleteMany({ owner: identity.owner });
    await db.collection('saved').deleteMany({ owner: identity.owner });
    return sendJson(res, 200, { success: true, deleted: result.deletedCount });
  }
  let m = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (m) {
    const db = await dbOrThrow();
    const itemId = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const item = await db.collection('history').findOne({ id: itemId, owner: identity.owner }, { projection: { _id: 0 } });
      return item ? sendJson(res, 200, { success: true, item }) : sendJson(res, 404, { success: false, error: 'History item not found.' });
    }
    if (req.method === 'DELETE') {
      const result = await db.collection('history').deleteOne({ id: itemId, owner: identity.owner });
      await db.collection('saved').deleteMany({ historyId: itemId, owner: identity.owner });
      return sendJson(res, 200, { success: true, deleted: Boolean(result.deletedCount) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/saved') {
    const db = await dbOrThrow();
    const saved = await db.collection('saved').find({ owner: identity.owner }).sort({ savedAt: -1 }).limit(500).project({ _id: 0 }).toArray();
    return sendJson(res, 200, { success: true, saved });
  }
  if (req.method === 'POST' && url.pathname === '/api/saved') {
    const db = await dbOrThrow();
    const body = await readJson(req, 100000);
    const historyId = String(body.historyId || '');
    const item = await db.collection('history').findOne({ id: historyId, owner: identity.owner }, { projection: { _id: 0 } });
    if (!item) return sendJson(res, 404, { success: false, error: 'Analysis result not found.' });
    try {
      await db.collection('saved').insertOne({ id: id('saved'), historyId, owner: identity.owner, item, savedAt: new Date().toISOString() });
      return sendJson(res, 200, { success: true });
    } catch (error) {
      if (error?.code === 11000) return sendJson(res, 200, { success: true, alreadySaved: true });
      throw error;
    }
  }
  m = url.pathname.match(/^\/api\/saved\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const db = await dbOrThrow();
    const savedId = decodeURIComponent(m[1]);
    const result = await db.collection('saved').deleteOne({ id: savedId, owner: identity.owner });
    return sendJson(res, 200, { success: true, deleted: Boolean(result.deletedCount) });
  }

  return sendJson(res, 404, { success: false, error: 'API route not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, error.status || 500, { success: false, error: error.message || 'Server error.' });
    else res.end();
  }
});

await connectMongo();
server.listen(PORT, HOST, () => {
  console.log(`\nFakeNewsDetect running on ${HOST}:${PORT}`);
  console.log(`Local: http://127.0.0.1:${PORT}/Page/login.html`);
  console.log(`MongoDB: ${mongoDb ? 'connected' : 'NOT connected — add MONGODB_URI'}`);
  console.log(`Gemini: ${geminiConfigured() ? 'configured' : 'NOT configured — add GEMINI_API_KEY'}`);
  console.log(`Firebase forgot-password: ${firebaseConfigured() ? 'configured' : 'NOT configured — add FIREBASE_API_KEY'}`);
});

async function shutdown() {
  try { await mongoClient?.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
