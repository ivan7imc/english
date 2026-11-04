import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { initDatabase, query, withTransaction, closeDatabase, databaseKind } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(crypto.scrypt);
const APP_NAME = process.env.APP_NAME || 'English Hub';
const MAX_UPLOAD_MB = Math.min(Math.max(Number(process.env.MAX_UPLOAD_MB || 15), 1), 50);
const SESSION_DAYS = 7;
const TICKET_MINUTES = 15;
const isProd = process.env.NODE_ENV === 'production';
const isDemo = process.env.DEMO_MODE === 'true';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = () => crypto.randomUUID();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const clean = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const normalizeEmail = (v) => clean(v, 254).toLowerCase();
const isUuid = (v) => UUID_RE.test(String(v || ''));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = await scrypt(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}
function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active };
}
function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 128) throw new HttpError(400, 'A senha deve ter entre 8 e 128 caracteres.');
  return p;
}
function validateEmail(email) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}
function validateName(name) {
  const n = clean(name, 120);
  if (n.length < 2) throw new HttpError(400, 'Informe um nome com pelo menos 2 caracteres.');
  return n;
}
function validateUrl(url) {
  const u = clean(url, 2000);
  let parsed;
  try { parsed = new URL(u); } catch { throw new HttpError(400, 'Informe um link válido (https://...).'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'O link deve começar com http:// ou https://.');
  return u;
}
function bool(v) {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}
function intPosition(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : fallback;
}

const SLIDE_EXT = new Set(['.pdf', '.ppt', '.pptx', '.odp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac']);
const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm', '.flac': 'audio/flac'
};
function safeFileName(name) {
  const base = path.basename(String(name || 'arquivo')).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
  return base || 'arquivo';
}
function validateUpload(type, file) {
  if (!file) throw new HttpError(400, 'Selecione um arquivo.');
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = type === 'slide' ? SLIDE_EXT : AUDIO_EXT;
  if (!allowed.has(ext)) {
    throw new HttpError(400, type === 'slide'
      ? 'Slides devem ser PDF, PPT, PPTX ou ODP.'
      : 'Áudios devem ser MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC.');
  }
  if (file.size <= 0) throw new HttpError(400, 'O arquivo está vazio.');
  return { ext, mime: MIME_BY_EXT[ext] || file.mimetype || 'application/octet-stream', name: safeFileName(file.originalname) };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
});

async function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [sha256(token), userId, expires]);
  return { token, expiresAt: expires.toISOString() };
}
async function destroySession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
}
async function getUserByToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.role, u.active, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > NOW() AND u.active = TRUE`,
    [sha256(token)]
  );
  return rows[0] || null;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
const requireAuth = asyncHandler(async (req, res, next) => {
  const user = await getUserByToken(bearer(req));
  if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  req.user = user;
  req.token = bearer(req);
  next();
});
const requireTeacher = (req, res, next) => {
  if (req.user?.role !== 'teacher') return next(new HttpError(403, 'Acesso exclusivo do professor.'));
  next();
};
const requireStudent = (req, res, next) => {
  if (req.user?.role !== 'student') return next(new HttpError(403, 'Acesso exclusivo do aluno.'));
  next();
};
function uuidParam(req, res, next) {
  if (!isUuid(req.params.id)) return next(new HttpError(404, 'Registro não encontrado.'));
  next();
}
async function cleanupExpired() {
  await query('DELETE FROM sessions WHERE expires_at <= NOW()');
  await query('DELETE FROM media_tickets WHERE expires_at <= NOW()');
}
async function teacherExists() {
  const { rows } = await query("SELECT 1 FROM users WHERE role='teacher' LIMIT 1");
  return rows.length > 0;
}
async function createUser({ name, email, password, role }) {
  const passwordHash = await hashPassword(password);
  const userId = id();
  await query(
    'INSERT INTO users (id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
    [userId, validateName(name), validateEmail(normalizeEmail(email)), passwordHash, role]
  );
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [userId]);
  return rows[0];
}
async function seedTeacherFromEnv() {
  if (await teacherExists()) return;
  const email = normalizeEmail(process.env.TEACHER_EMAIL || '');
  const password = String(process.env.TEACHER_PASSWORD || '');
  if (!email || !password) return;
  await createUser({ name: process.env.TEACHER_NAME || 'Professor', email, password, role: 'teacher' });
  console.log(`[setup] Professor inicial criado: ${email}`);
}
async function seedDemo() {
  if (!isDemo || process.env.SEED_DEMO !== 'true') return;
  if (await teacherExists()) return;
  const teacher = await createUser({ name: 'Prof. Demo', email: 'professor@demo.com', password: 'Professor123!', role: 'teacher' });
  const student = await createUser({ name: 'Ana Souza', email: 'aluno@demo.com', password: 'Aluno123!', role: 'student' });
  const student2 = await createUser({ name: 'Bruno Lima', email: 'bruno@demo.com', password: 'Aluno123!', role: 'student' });

  const lessons = [
    { title: 'Lesson 1 — Greetings & Introductions', description: 'Cumprimentos, apresentações e verbo to be.', published: true, position: 1 },
    { title: 'Lesson 2 — Daily Routine', description: 'Present simple, horários e hábitos do dia a dia.', published: true, position: 2 },
    { title: 'Lesson 3 — Listening Practice', description: 'Compreensão auditiva com diálogos curtos.', published: true, position: 3 },
    { title: 'Lesson 4 — Travel Vocabulary (rascunho)', description: 'Aula ainda não publicada para os alunos.', published: false, position: 4 }
  ];
  const lessonIds = [];
  for (const l of lessons) {
    const lessonId = id();
    lessonIds.push(lessonId);
    await query('INSERT INTO lessons (id,title,description,position,published) VALUES ($1,$2,$3,$4,$5)', [lessonId, l.title, l.description, l.position, l.published]);
  }
  const materials = [
    { lesson: 0, type: 'text', title: 'Key phrases', body: 'Hello! My name is ___.\nNice to meet you.\nI am from Brazil.\nWhat do you do?\n\nPractice: introduce yourself in 3 sentences.' },
    { lesson: 0, type: 'link', title: 'BBC Learning English — Greetings', url: 'https://www.bbc.co.uk/learningenglish/english/features/english-at-work/ep-170906' },
    { lesson: 1, type: 'text', title: 'Present Simple — rules', body: 'I/You/We/They + base verb: I work, they study.\nHe/She/It + verb-s: she works, he studies.\n\nNegative: do not / does not.\nQuestion: Do you...? / Does she...?' },
    { lesson: 1, type: 'link', title: 'Practice: Daily routines', url: 'https://learnenglish.britishcouncil.org/grammar/a1-a2-grammar/present-simple' },
    { lesson: 2, type: 'text', title: 'Listening strategy', body: '1. Read the questions first.\n2. Listen for keywords, not every word.\n3. Listen twice: general idea, then details.\n4. Check new vocabulary after listening.' },
    { lesson: 2, type: 'link', title: 'Elllo — English listening library', url: 'https://elllo.org/' }
  ];
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    await query(
      'INSERT INTO materials (id,lesson_id,type,title,body,url,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id(), lessonIds[m.lesson], m.type, m.title, m.body || '', m.url || '', i + 1]
    );
  }
  await query('INSERT INTO lesson_progress (user_id,lesson_id,seen) VALUES ($1,$2,TRUE)', [student.id, lessonIds[0]]);
  console.log('[demo] Contas: professor@demo.com / Professor123! | aluno@demo.com / Aluno123!');
}

function materialRow(row) {
  return {
    id: row.id, lessonId: row.lesson_id, type: row.type, title: row.title, body: row.body, url: row.url,
    fileName: row.file_name, fileSize: row.file_size, mimeType: row.mime_type, hasFile: !!row.file_name,
    position: row.position, createdAt: row.created_at
  };
}
function lessonRow(row) {
  return {
    id: row.id, title: row.title, description: row.description, position: row.position, published: row.published,
    createdAt: row.created_at, updatedAt: row.updated_at,
    materialCount: row.material_count !== undefined ? Number(row.material_count) : undefined,
    seen: row.seen === undefined ? undefined : !!row.seen,
    seenCount: row.seen_count !== undefined ? Number(row.seen_count) : undefined
  };
}
async function getLessonForUser(lessonId, user) {
  const { rows } = await query(
    `SELECT l.*, (SELECT COUNT(*) FROM materials m WHERE m.lesson_id=l.id) AS material_count
     FROM lessons l WHERE l.id=$1`, [lessonId]
  );
  const lesson = rows[0];
  if (!lesson) throw new HttpError(404, 'Aula não encontrada.');
  if (user.role === 'student' && !lesson.published) throw new HttpError(404, 'Aula não encontrada.');
  return lesson;
}
async function getMaterialForUser(materialId, user) {
  const { rows } = await query(
    `SELECT m.*, l.published, l.id AS lesson_id FROM materials m JOIN lessons l ON l.id=m.lesson_id WHERE m.id=$1`,
    [materialId]
  );
  const material = rows[0];
  if (!material) throw new HttpError(404, 'Material não encontrado.');
  if (user.role === 'student' && !material.published) throw new HttpError(404, 'Material não encontrado.');
  return material;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'media-src': ["'self'", 'blob:'],
        'frame-src': ["'self'"],
        'object-src': ["'self'"],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        ...(isProd && !isDemo ? { 'frame-ancestors': ["'self'"] } : { 'frame-ancestors': ['*'] })
      }
    },
    crossOriginEmbedderPolicy: false,
    frameguard: isProd && !isDemo ? { action: 'sameorigin' } : false
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
  const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas requisições. Aguarde um pouco.' } });
  app.use('/api', apiLimiter);

  app.get('/api/health', asyncHandler(async (req, res) => {
    await query('SELECT 1');
    res.json({ ok: true, app: APP_NAME, database: databaseKind(), demo: isDemo });
  }));

  app.get('/api/bootstrap', asyncHandler(async (req, res) => {
    const needsSetup = !(await teacherExists());
    // Em produção o setup pela web só funciona se SETUP_KEY estiver definida.
    const setupAllowed = !needsSetup || !(isProd && !isDemo && !process.env.SETUP_KEY);
    res.json({ appName: APP_NAME, demo: isDemo, needsSetup, setupAllowed, maxUploadMB: MAX_UPLOAD_MB });
  }));

  app.post('/api/setup', loginLimiter, asyncHandler(async (req, res) => {
    if (await teacherExists()) throw new HttpError(409, 'O professor inicial já foi cadastrado.');
    if (isProd && !isDemo && !process.env.SETUP_KEY) {
      throw new HttpError(403, 'Configuração inicial protegida. Defina SETUP_KEY no Render ou crie o professor via TEACHER_EMAIL/TEACHER_PASSWORD.');
    }
    if (process.env.SETUP_KEY && clean(req.body.setupKey, 200) !== process.env.SETUP_KEY) {
      throw new HttpError(403, 'Chave de configuração inválida.');
    }
    const user = await createUser({ name: req.body.name, email: req.body.email, password: validatePassword(req.body.password), role: 'teacher' });
    const session = await createSession(user.id);
    res.status(201).json({ user: publicUser(user), ...session });
  }));

  app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    const session = await createSession(user.id);
    res.json({ user: publicUser(user), ...session });
  }));

  app.post('/api/logout', requireAuth, asyncHandler(async (req, res) => {
    await destroySession(req.token);
    res.json({ ok: true });
  }));

  app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/change-password', requireAuth, asyncHandler(async (req, res) => {
    const current = String(req.body.currentPassword || '');
    const next = validatePassword(req.body.newPassword);
    const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await verifyPassword(current, rows[0].password_hash))) throw new HttpError(400, 'Senha atual incorreta.');
    await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [await hashPassword(next), req.user.id]);
    await query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, sha256(req.token)]);
    res.json({ ok: true });
  }));

  // ---------- Lessons ----------
  app.get('/api/lessons', requireAuth, asyncHandler(async (req, res) => {
    if (req.user.role === 'teacher') {
      const { rows } = await query(
        `SELECT l.*, (SELECT COUNT(*) FROM materials m WHERE m.lesson_id=l.id) AS material_count,
                (SELECT COUNT(*) FROM lesson_progress p JOIN users u ON u.id=p.user_id WHERE p.lesson_id=l.id AND p.seen=TRUE AND u.role='student' AND u.active=TRUE) AS seen_count
         FROM lessons l ORDER BY l.position, l.created_at`
      );
      return res.json({ lessons: rows.map(lessonRow) });
    }
    const { rows } = await query(
      `SELECT l.*, (SELECT COUNT(*) FROM materials m WHERE m.lesson_id=l.id) AS material_count,
              COALESCE(p.seen, FALSE) AS seen
       FROM lessons l LEFT JOIN lesson_progress p ON p.lesson_id=l.id AND p.user_id=$1
       WHERE l.published=TRUE ORDER BY l.position, l.created_at`, [req.user.id]
    );
    res.json({ lessons: rows.map(lessonRow) });
  }));

  app.post('/api/lessons', requireAuth, requireTeacher, asyncHandler(async (req, res) => {
    const title = clean(req.body.title, 180);
    if (!title) throw new HttpError(400, 'Informe o título da aula.');
    const lessonId = id();
    await query('INSERT INTO lessons (id,title,description,position,published) VALUES ($1,$2,$3,$4,$5)',
      [lessonId, title, clean(req.body.description, 2000), intPosition(req.body.position, 0), bool(req.body.published)]);
    const { rows } = await query('SELECT l.*, 0 AS material_count, 0 AS seen_count FROM lessons l WHERE id=$1', [lessonId]);
    res.status(201).json({ lesson: lessonRow(rows[0]) });
  }));

  app.get('/api/lessons/:id', requireAuth, uuidParam, asyncHandler(async (req, res) => {
    const lesson = await getLessonForUser(req.params.id, req.user);
    const { rows: materials } = await query('SELECT * FROM materials WHERE lesson_id=$1 ORDER BY position, created_at', [lesson.id]);
    let seen = false;
    if (req.user.role === 'student') {
      const { rows } = await query('SELECT seen FROM lesson_progress WHERE user_id=$1 AND lesson_id=$2', [req.user.id, lesson.id]);
      seen = !!rows[0]?.seen;
    }
    res.json({ lesson: lessonRow(lesson), materials: materials.map(materialRow), seen });
  }));

  app.patch('/api/lessons/:id', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    const current = await getLessonForUser(req.params.id, req.user);
    const title = req.body.title === undefined ? current.title : clean(req.body.title, 180);
    if (!title) throw new HttpError(400, 'Informe o título da aula.');
    const description = req.body.description === undefined ? current.description : clean(req.body.description, 2000);
    const position = req.body.position === undefined ? current.position : intPosition(req.body.position, current.position);
    const published = req.body.published === undefined ? current.published : bool(req.body.published);
    await query('UPDATE lessons SET title=$1, description=$2, position=$3, published=$4, updated_at=NOW() WHERE id=$5',
      [title, description, position, published, current.id]);
    const { rows } = await query('SELECT l.*, (SELECT COUNT(*) FROM materials m WHERE m.lesson_id=l.id) AS material_count FROM lessons l WHERE id=$1', [current.id]);
    res.json({ lesson: lessonRow(rows[0]) });
  }));

  app.delete('/api/lessons/:id', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    await getLessonForUser(req.params.id, req.user);
    await query('DELETE FROM lessons WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- Materials ----------
  app.post('/api/lessons/:id/materials', requireAuth, requireTeacher, uuidParam, upload.single('file'), asyncHandler(async (req, res) => {
    await getLessonForUser(req.params.id, req.user);
    const type = clean(req.body.type, 10);
    if (!['slide', 'text', 'audio', 'link'].includes(type)) throw new HttpError(400, 'Tipo de material inválido.');
    const title = clean(req.body.title, 180);
    if (!title) throw new HttpError(400, 'Informe o título do material.');
    let body = '', url = '', fileName = null, mime = null, fileSize = null, data = null;
    if (type === 'text') {
      body = clean(req.body.body, 100000);
      if (!body) throw new HttpError(400, 'Escreva o conteúdo do texto.');
    } else if (type === 'link') {
      url = validateUrl(req.body.url);
    } else {
      const info = validateUpload(type, req.file);
      fileName = info.name; mime = info.mime; fileSize = req.file.size; data = req.file.buffer;
    }
    const { rows: posRows } = await query('SELECT COALESCE(MAX(position),0)+1 AS next FROM materials WHERE lesson_id=$1', [req.params.id]);
    const materialId = id();
    await query(
      `INSERT INTO materials (id,lesson_id,type,title,body,url,file_name,mime_type,file_size,data,position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [materialId, req.params.id, type, title, body, url, fileName, mime, fileSize, data, intPosition(req.body.position, posRows[0].next)]
    );
    const { rows } = await query('SELECT * FROM materials WHERE id=$1', [materialId]);
    res.status(201).json({ material: materialRow(rows[0]) });
  }));

  app.patch('/api/materials/:id', requireAuth, requireTeacher, uuidParam, upload.single('file'), asyncHandler(async (req, res) => {
    const current = await getMaterialForUser(req.params.id, req.user);
    const title = req.body.title === undefined ? current.title : clean(req.body.title, 180);
    if (!title) throw new HttpError(400, 'Informe o título do material.');
    let body = current.body, url = current.url, fileName = current.file_name, mime = current.mime_type, fileSize = current.file_size, data = null;
    let replaceFile = false;
    if (current.type === 'text') body = req.body.body === undefined ? current.body : clean(req.body.body, 100000);
    if (current.type === 'link') url = req.body.url === undefined ? current.url : validateUrl(req.body.url);
    if (req.file && req.file.size > 0 && ['slide', 'audio'].includes(current.type)) {
      const info = validateUpload(current.type, req.file);
      fileName = info.name; mime = info.mime; fileSize = req.file.size; data = req.file.buffer; replaceFile = true;
    }
    const position = req.body.position === undefined ? current.position : intPosition(req.body.position, current.position);
    if (replaceFile) {
      await query('UPDATE materials SET title=$1, body=$2, url=$3, file_name=$4, mime_type=$5, file_size=$6, data=$7, position=$8 WHERE id=$9',
        [title, body, url, fileName, mime, fileSize, data, position, current.id]);
    } else {
      await query('UPDATE materials SET title=$1, body=$2, url=$3, position=$4 WHERE id=$5', [title, body, url, position, current.id]);
    }
    const { rows } = await query('SELECT * FROM materials WHERE id=$1', [current.id]);
    res.json({ material: materialRow(rows[0]) });
  }));

  app.delete('/api/materials/:id', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    await getMaterialForUser(req.params.id, req.user);
    await query('DELETE FROM materials WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  app.post('/api/materials/:id/ticket', requireAuth, uuidParam, asyncHandler(async (req, res) => {
    const material = await getMaterialForUser(req.params.id, req.user);
    if (!material.file_name) throw new HttpError(400, 'Este material não possui arquivo.');
    const token = newToken();
    const expires = new Date(Date.now() + TICKET_MINUTES * 60000);
    await query('INSERT INTO media_tickets (token_hash,user_id,material_id,expires_at) VALUES ($1,$2,$3,$4)',
      [sha256(token), req.user.id, material.id, expires]);
    res.json({ url: `/media/${token}`, expiresAt: expires.toISOString() });
  }));

  app.get('/media/:token', asyncHandler(async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, 'Arquivo não encontrado.');
    const { rows } = await query(
      `SELECT m.file_name, m.mime_type, m.data, m.type, l.published, u.active AS user_active, u.role
       FROM media_tickets t
       JOIN materials m ON m.id=t.material_id
       JOIN lessons l ON l.id=m.lesson_id
       JOIN users u ON u.id=t.user_id
       WHERE t.token_hash=$1 AND t.expires_at > NOW()`, [sha256(token)]
    );
    const row = rows[0];
    if (!row || !row.user_active || (row.role === 'student' && !row.published) || !row.data) throw new HttpError(404, 'Arquivo não encontrado ou link expirado.');
    const buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    const mime = row.mime_type || 'application/octet-stream';
    const inline = row.type === 'audio' || mime === 'application/pdf';
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        let start = match[1] ? Number(match[1]) : NaN;
        let end = match[2] ? Number(match[2]) : NaN;
        if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, buffer.length - end); end = buffer.length - 1; }
        else if (!Number.isNaN(start) && Number.isNaN(end)) { end = buffer.length - 1; }
        if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end && start < buffer.length) {
          end = Math.min(end, buffer.length - 1);
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
          res.setHeader('Content-Length', end - start + 1);
          return res.end(buffer.subarray(start, end + 1));
        }
        res.status(416);
        res.setHeader('Content-Range', `bytes */${buffer.length}`);
        return res.end();
      }
    }
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }));

  // ---------- Progress ----------
  app.post('/api/lessons/:id/progress', requireAuth, requireStudent, uuidParam, asyncHandler(async (req, res) => {
    const lesson = await getLessonForUser(req.params.id, req.user);
    const seen = bool(req.body.seen);
    await query(
      `INSERT INTO lesson_progress (user_id,lesson_id,seen,updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id,lesson_id) DO UPDATE SET seen=EXCLUDED.seen, updated_at=NOW()`,
      [req.user.id, lesson.id, seen]
    );
    res.json({ lessonId: lesson.id, seen });
  }));

  app.get('/api/progress', requireAuth, requireTeacher, asyncHandler(async (req, res) => {
    const { rows: students } = await query("SELECT id,name,email,active FROM users WHERE role='student' ORDER BY name");
    const { rows: lessons } = await query('SELECT id,title,position,published FROM lessons WHERE published=TRUE ORDER BY position, created_at');
    const { rows: cells } = await query(
      `SELECT p.user_id, p.lesson_id, p.seen, p.updated_at FROM lesson_progress p
       JOIN users u ON u.id=p.user_id JOIN lessons l ON l.id=p.lesson_id
       WHERE u.role='student' AND l.published=TRUE`
    );
    const map = new Map(cells.map(c => [`${c.user_id}:${c.lesson_id}`, c]));
    const matrix = students.map(s => {
      const items = lessons.map(l => {
        const c = map.get(`${s.id}:${l.id}`);
        return { lessonId: l.id, seen: !!c?.seen, updatedAt: c?.updated_at || null };
      });
      return { student: s, items, seenCount: items.filter(i => i.seen).length };
    });
    res.json({ students, lessons, matrix });
  }));

  // ---------- Students ----------
  app.get('/api/students', requireAuth, requireTeacher, asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id,u.name,u.email,u.active,u.created_at,
              (SELECT COUNT(*) FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=u.id AND p.seen=TRUE AND l.published=TRUE) AS seen_count,
              (SELECT COUNT(*) FROM lessons WHERE published=TRUE) AS total_lessons
       FROM users u WHERE u.role='student' ORDER BY u.name`
    );
    res.json({ students: rows.map(r => ({ id: r.id, name: r.name, email: r.email, active: r.active, createdAt: r.created_at, seenCount: Number(r.seen_count), totalLessons: Number(r.total_lessons) })) });
  }));

  app.post('/api/students', requireAuth, requireTeacher, asyncHandler(async (req, res) => {
    const user = await createUser({ name: req.body.name, email: req.body.email, password: validatePassword(req.body.password), role: 'student' });
    res.status(201).json({ student: publicUser(user) });
  }));

  app.patch('/api/students/:id', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='student'", [req.params.id]);
    const student = rows[0];
    if (!student) throw new HttpError(404, 'Aluno não encontrado.');
    const name = req.body.name === undefined ? student.name : validateName(req.body.name);
    const email = req.body.email === undefined ? student.email : validateEmail(normalizeEmail(req.body.email));
    const active = req.body.active === undefined ? student.active : bool(req.body.active);
    await query('UPDATE users SET name=$1,email=$2,active=$3,updated_at=NOW() WHERE id=$4', [name, email, active, student.id]);
    if (!active) await query('DELETE FROM sessions WHERE user_id=$1', [student.id]);
    const { rows: updated } = await query('SELECT * FROM users WHERE id=$1', [student.id]);
    res.json({ student: publicUser(updated[0]) });
  }));

  app.post('/api/students/:id/reset-password', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT id FROM users WHERE id=$1 AND role='student'", [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Aluno não encontrado.');
    const password = validatePassword(req.body.password);
    await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [await hashPassword(password), req.params.id]);
    await query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  app.delete('/api/students/:id', requireAuth, requireTeacher, uuidParam, asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT id FROM users WHERE id=$1 AND role='student'", [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Aluno não encontrado.');
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- Teacher overview ----------
  app.get('/api/teacher/overview', requireAuth, requireTeacher, asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE role='student' AND active=TRUE) AS students,
        (SELECT COUNT(*) FROM lessons) AS lessons,
        (SELECT COUNT(*) FROM lessons WHERE published=TRUE) AS published_lessons,
        (SELECT COUNT(*) FROM materials) AS materials,
        (SELECT COUNT(*) FROM lesson_progress p JOIN lessons l ON l.id=p.lesson_id JOIN users u ON u.id=p.user_id WHERE p.seen=TRUE AND l.published=TRUE AND u.role='student' AND u.active=TRUE) AS seen_count`
    );
    const r = rows[0];
    const totalPossible = Number(r.students) * Number(r.published_lessons);
    res.json({
      students: Number(r.students), lessons: Number(r.lessons), publishedLessons: Number(r.published_lessons),
      materials: Number(r.materials), seenCount: Number(r.seen_count),
      completionRate: totalPossible ? Math.round((Number(r.seen_count) / totalPossible) * 100) : 0
    });
  }));

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1h' : 0 }));
  app.get(/^\/(?!api\/|media\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Arquivo muito grande. Limite: ${MAX_UPLOAD_MB} MB.` : 'Falha no upload do arquivo.';
      return res.status(400).json({ error: msg });
    }
    if (err?.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    const status = err.status || 500;
    if (status >= 500) console.error('[erro]', err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message });
  });
  return app;
}

export async function startServer(port = Number(process.env.PORT || 3000)) {
  await initDatabase();
  await cleanupExpired();
  await seedTeacherFromEnv();
  await seedDemo();
  const app = createApp();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`${APP_NAME} ouvindo em http://0.0.0.0:${port} | banco: ${databaseKind()}${isDemo ? ' (DEMO)' : ''}`);
  });
  const cleanupTimer = setInterval(() => { cleanupExpired().catch((err) => console.error('[cleanup]', err.message)); }, 60 * 60 * 1000);
  cleanupTimer.unref();
  const shutdown = async () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error('Falha ao iniciar:', err.message);
    process.exit(1);
  });
}
