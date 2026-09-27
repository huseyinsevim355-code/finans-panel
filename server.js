/* ============================================================================
   FİNANS YÖNETİM PANELİ — TEK DOSYA SUNUCU
   ----------------------------------------------------------------------------
   Bu dosya, projenin tüm sunucu tarafı kodunu (veritabanı, kimlik doğrulama,
   API rotaları, statik dosya sunumu) TEK bir dosyada birleştirir. Böylece
   GitHub'a dosya yüklerken hiçbir klasör oluşturmaya veya dosya adını
   değiştirmeye gerek kalmaz — her şey depo kökünde düz (flat) durur.
   ========================================================================== */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============================================================================
   VERİTABANI
   ========================================================================== */
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'finans.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'light',
  palette TEXT NOT NULL DEFAULT 'saas',
  salary_cents INTEGER NOT NULL DEFAULT 0,
  app_title TEXT,
  app_subtitle TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Nakit',
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'Diğer',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);

CREATE TABLE IF NOT EXISTS debts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creditor TEXT NOT NULL,
  original_cents INTEGER NOT NULL DEFAULT 0,
  remaining_cents INTEGER NOT NULL DEFAULT 0,
  min_pay_cents INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);

CREATE TABLE IF NOT EXISTS debt_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  debt_id TEXT,
  creditor TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_debt_payments_user ON debt_payments(user_id);

CREATE TABLE IF NOT EXISTS receivables (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  original_cents INTEGER NOT NULL DEFAULT 0,
  monthly_expected_cents INTEGER NOT NULL DEFAULT 0,
  known_deficit_cents INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receivables_user ON receivables(user_id);

CREATE TABLE IF NOT EXISTS receivable_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receivable_id TEXT,
  person TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receivable_payments_user ON receivable_payments(user_id);

CREATE TABLE IF NOT EXISTS budgets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  limit_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS goals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_cents INTEGER NOT NULL DEFAULT 0,
  current_cents INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS salary_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_salary_history_user ON salary_history(user_id);

CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  day INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring(user_id);
`);

/* ============================================================================
   PARA / TARİH YARDIMCILARI
   ========================================================================== */
function toCents(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}
function fromCents(c) {
  const n = Number(c) || 0;
  return Math.round(n) / 100;
}
function toISODate(trDate) {
  if (!trDate || typeof trDate !== 'string') return null;
  const m = trDate.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trDate.trim())) return trDate.trim();
    return null;
  }
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function toTRDate(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const m = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  const [, y, mo, d] = m;
  return `${d}.${mo}.${y}`;
}

/* ============================================================================
   KİMLİK DOĞRULAMA (JWT + httpOnly cookie)
   ========================================================================== */
const SECRET_PATH = process.env.JWT_SECRET_PATH || path.join(DATA_DIR, 'jwt_secret.txt');
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch (e) {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret, 'utf8');
    return secret;
  }
}
const JWT_SECRET = getSecret();
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

function hashPassword(plain) { return bcrypt.hashSync(plain, 10); }
function verifyPassword(plain, hash) { return bcrypt.compareSync(plain, hash); }
function signToken(userId) { return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function setSessionCookie(res, token) {
  res.cookie('finans_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  });
}
function clearSessionCookie(res) {
  res.clearCookie('finans_session', { path: '/' });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.finans_session;
  if (!token) return res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
  const payload = verifyToken(token);
  if (!payload || !payload.uid) return res.status(401).json({ error: 'Oturum geçersiz. Lütfen tekrar giriş yapın.' });

  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ error: 'Oturum geçersiz. Lütfen tekrar giriş yapın.' });

  req.userId = user.id;
  req.user = user;

  const fresh = signToken(user.id);
  setSessionCookie(res, fresh);

  next();
}

function uidShort() { return crypto.randomBytes(9).toString('hex'); }
function uidLong() { return crypto.randomBytes(12).toString('hex'); }
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ============================================================================
   STATE OKUMA / YAZMA
   ========================================================================== */
function getFullState(userId) {
  const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) || {};
  const goal = db.prepare('SELECT * FROM goals WHERE user_id = ?').get(userId) || {};

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(a => ({ id: a.id, name: a.name, type: a.type, balance: fromCents(a.balance_cents) }));

  const expenses = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(e => ({ id: e.id, category: e.category, amount: fromCents(e.amount_cents), note: e.note || '', date: toTRDate(e.date) }));

  const debts = db.prepare('SELECT * FROM debts WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(d => ({ id: d.id, creditor: d.creditor, original: fromCents(d.original_cents), remaining: fromCents(d.remaining_cents), minPay: fromCents(d.min_pay_cents), rate: d.rate || 0 }));

  const payments = db.prepare('SELECT * FROM debt_payments WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(p => ({ id: p.id, debtId: p.debt_id, creditor: p.creditor || '', amount: fromCents(p.amount_cents), date: toTRDate(p.date) }));

  const receivables = db.prepare('SELECT * FROM receivables WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(r => ({ id: r.id, person: r.person, original: fromCents(r.original_cents), monthlyExpected: fromCents(r.monthly_expected_cents), knownDeficit: fromCents(r.known_deficit_cents), startDate: r.start_date ? toTRDate(r.start_date) : '' }));

  const receivablePayments = db.prepare('SELECT * FROM receivable_payments WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(p => ({ id: p.id, receivableId: p.receivable_id, person: p.person || '', amount: fromCents(p.amount_cents), date: toTRDate(p.date) }));

  const budgetRows = db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(userId);
  const budgets = {};
  budgetRows.forEach(b => { budgets[b.category] = fromCents(b.limit_cents); });

  const salaryHistory = db.prepare('SELECT * FROM salary_history WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(s => ({ id: s.id, amount: fromCents(s.amount_cents), date: toTRDate(s.date) }));

  const recurring = db.prepare('SELECT * FROM recurring WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(r => ({ id: r.id, name: r.name, amount: fromCents(r.amount_cents), day: r.day }));

  return {
    salary: fromCents(settings.salary_cents || 0),
    theme: settings.theme || 'light',
    palette: settings.palette || 'saas',
    appTitle: settings.app_title || null,
    appSubtitle: settings.app_subtitle || null,
    accounts, expenses, debts, payments, receivables, receivablePayments,
    budgets,
    savingsGoal: { target: fromCents(goal.target_cents || 0), current: fromCents(goal.current_cents || 0), deadline: goal.deadline || '' },
    salaryHistory, recurring
  };
}

function reconcileTable({ tableName, userId, incomingRows, columns }) {
  const existingIds = db.prepare(`SELECT id FROM ${tableName} WHERE user_id = ?`).all(userId).map(r => r.id);
  const incomingIds = new Set();

  const colNames = columns.map(c => c.dbCol);
  const insertStmt = db.prepare(`
    INSERT INTO ${tableName} (id, user_id, ${colNames.join(',')})
    VALUES (?, ?, ${colNames.map(() => '?').join(',')})
    ON CONFLICT(id) DO UPDATE SET ${colNames.map(c => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')
  `);
  const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE id = ? AND user_id = ?`);

  for (const row of (incomingRows || [])) {
    const id = row.id && String(row.id).trim() ? String(row.id).trim() : uidShort();
    incomingIds.add(id);
    const values = [id, userId, ...columns.map(c => c.get(row))];
    insertStmt.run(...values);
  }
  existingIds.forEach(id => {
    if (!incomingIds.has(id)) deleteStmt.run(id, userId);
  });
}

/* ============================================================================
   EXPRESS UYGULAMASI
   ========================================================================== */
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

/* ---- Kimlik doğrulama rotaları ---- */
const authRouter = express.Router();

authRouter.post('/register', (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Bu e-posta ile zaten bir hesap var.' });

    const id = uidLong();
    const passwordHash = hashPassword(String(password));
    const insertUser = db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?,?,?,?)');
    const insertSettings = db.prepare('INSERT INTO settings (user_id) VALUES (?)');
    const insertGoal = db.prepare('INSERT INTO goals (user_id) VALUES (?)');

    const tx = db.transaction(() => {
      insertUser.run(id, email.toLowerCase().trim(), passwordHash, (name || '').trim() || null);
      insertSettings.run(id);
      insertGoal.run(id);
    });
    tx();

    const token = signToken(id);
    setSessionCookie(res, token);
    res.json({ user: { id, email: email.toLowerCase().trim(), name: name || null } });
  } catch (e) {
    console.error('[auth/register]', e);
    res.status(500).json({ error: 'Kayıt oluşturulamadı. Lütfen tekrar deneyin.' });
  }
});

authRouter.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) return res.status(400).json({ error: 'E-posta ve şifre gerekli.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    }
    const token = signToken(user.id);
    setSessionCookie(res, token);
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Giriş yapılamadı. Lütfen tekrar deneyin.' });
  }
});

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.use('/api/auth', authRouter);

/* ---- State rotaları ---- */
const stateRouter = express.Router();

stateRouter.get('/', requireAuth, (req, res) => {
  try {
    res.json({ state: getFullState(req.userId) });
  } catch (e) {
    console.error('[state/get]', e);
    res.status(500).json({ error: 'Veriler yüklenemedi. Lütfen tekrar deneyin.' });
  }
});

stateRouter.put('/', requireAuth, (req, res) => {
  const incoming = req.body || {};
  try {
    const userId = req.userId;
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO settings (user_id, theme, palette, salary_cents, app_title, app_subtitle, updated_at)
        VALUES (?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme, palette=excluded.palette,
          salary_cents=excluded.salary_cents, app_title=excluded.app_title, app_subtitle=excluded.app_subtitle,
          updated_at=datetime('now')
      `).run(userId, incoming.theme || 'light', incoming.palette || 'saas', toCents(incoming.salary || 0), incoming.appTitle || null, incoming.appSubtitle || null);

      const g = incoming.savingsGoal || {};
      db.prepare(`
        INSERT INTO goals (user_id, target_cents, current_cents, deadline, updated_at)
        VALUES (?,?,?,?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET target_cents=excluded.target_cents, current_cents=excluded.current_cents,
          deadline=excluded.deadline, updated_at=datetime('now')
      `).run(userId, toCents(Math.max(0, g.target || 0)), toCents(Math.max(0, g.current || 0)), g.deadline || null);

      reconcileTable({
        tableName: 'accounts', userId, incomingRows: incoming.accounts,
        columns: [
          { dbCol: 'name', get: r => String(r.name || '').slice(0, 200) },
          { dbCol: 'type', get: r => String(r.type || 'Nakit') },
          { dbCol: 'balance_cents', get: r => toCents(r.balance || 0) }
        ]
      });

      reconcileTable({
        tableName: 'expenses', userId, incomingRows: incoming.expenses,
        columns: [
          { dbCol: 'category', get: r => String(r.category || 'Diğer') },
          { dbCol: 'amount_cents', get: r => Math.max(0, toCents(r.amount || 0)) },
          { dbCol: 'note', get: r => (r.note || '').slice(0, 500) },
          { dbCol: 'date', get: r => toISODate(r.date) || new Date().toISOString().slice(0, 10) }
        ]
      });

      reconcileTable({
        tableName: 'debts', userId, incomingRows: incoming.debts,
        columns: [
          { dbCol: 'creditor', get: r => String(r.creditor || '').slice(0, 200) },
          { dbCol: 'original_cents', get: r => Math.max(0, toCents(r.original || 0)) },
          { dbCol: 'remaining_cents', get: r => Math.max(0, toCents(r.remaining || 0)) },
          { dbCol: 'min_pay_cents', get: r => Math.max(0, toCents(r.minPay || 0)) },
          { dbCol: 'rate', get: r => Number(r.rate) || 0 }
        ]
      });

      reconcileTable({
        tableName: 'debt_payments', userId, incomingRows: incoming.payments,
        columns: [
          { dbCol: 'debt_id', get: r => r.debtId || null },
          { dbCol: 'creditor', get: r => (r.creditor || '').slice(0, 200) },
          { dbCol: 'amount_cents', get: r => Math.max(0, toCents(r.amount || 0)) },
          { dbCol: 'date', get: r => toISODate(r.date) || new Date().toISOString().slice(0, 10) }
        ]
      });

      reconcileTable({
        tableName: 'receivables', userId, incomingRows: incoming.receivables,
        columns: [
          { dbCol: 'person', get: r => String(r.person || '').slice(0, 200) },
          { dbCol: 'original_cents', get: r => Math.max(0, toCents(r.original || 0)) },
          { dbCol: 'monthly_expected_cents', get: r => Math.max(0, toCents(r.monthlyExpected || 0)) },
          { dbCol: 'known_deficit_cents', get: r => Math.max(0, toCents(r.knownDeficit || 0)) },
          { dbCol: 'start_date', get: r => toISODate(r.startDate) || null }
        ]
      });

      reconcileTable({
        tableName: 'receivable_payments', userId, incomingRows: incoming.receivablePayments,
        columns: [
          { dbCol: 'receivable_id', get: r => r.receivableId || null },
          { dbCol: 'person', get: r => (r.person || '').slice(0, 200) },
          { dbCol: 'amount_cents', get: r => Math.max(0, toCents(r.amount || 0)) },
          { dbCol: 'date', get: r => toISODate(r.date) || new Date().toISOString().slice(0, 10) }
        ]
      });

      reconcileTable({
        tableName: 'salary_history', userId, incomingRows: incoming.salaryHistory,
        columns: [
          { dbCol: 'amount_cents', get: r => Math.max(0, toCents(r.amount || 0)) },
          { dbCol: 'date', get: r => toISODate(r.date) || new Date().toISOString().slice(0, 10) }
        ]
      });

      reconcileTable({
        tableName: 'recurring', userId, incomingRows: incoming.recurring,
        columns: [
          { dbCol: 'name', get: r => String(r.name || '').slice(0, 200) },
          { dbCol: 'amount_cents', get: r => Math.max(0, toCents(r.amount || 0)) },
          { dbCol: 'day', get: r => Number.isInteger(r.day) ? r.day : (parseInt(r.day) || null) }
        ]
      });

      const incomingBudgets = incoming.budgets || {};
      const existingBudgetCats = db.prepare('SELECT category FROM budgets WHERE user_id = ?').all(userId).map(r => r.category);
      const upsertBudget = db.prepare(`
        INSERT INTO budgets (user_id, category, limit_cents, updated_at) VALUES (?,?,?, datetime('now'))
        ON CONFLICT(user_id, category) DO UPDATE SET limit_cents=excluded.limit_cents, updated_at=datetime('now')
      `);
      const deleteBudget = db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?');
      Object.keys(incomingBudgets).forEach(cat => {
        upsertBudget.run(userId, cat, Math.max(0, toCents(incomingBudgets[cat] || 0)));
      });
      existingBudgetCats.forEach(cat => {
        if (!(cat in incomingBudgets)) deleteBudget.run(userId, cat);
      });
    });

    tx();
    res.json({ state: getFullState(userId) });
  } catch (e) {
    console.error('[state/put]', e);
    res.status(500).json({ error: 'İşlem kaydedilemedi. Lütfen tekrar deneyin.' });
  }
});

app.use('/api/state', stateRouter);

/* ---- Statik frontend (index.html, manifest.json, ikonlar — hepsi bu klasörde, düz yapı) ---- */
app.use(express.static(ROOT_DIR, {
  // server.js, package.json gibi sunucu dosyalarının yanlışlıkla servis edilmemesi için
  // sadece bilinen statik uzantılar otomatik olarak sunulur; index.html zaten kökte.
  index: 'index.html'
}));

// SPA: API olmayan tüm GET yolları index.html'e düşsün
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// global hata yakalayıcı
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.' });
});

app.listen(PORT, () => {
  console.log(`Finans Yönetim Paneli sunucusu http://localhost:${PORT} adresinde çalışıyor`);
});
