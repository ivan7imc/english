import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_MODE = 'true';
process.env.DEMO_DB_PATH = ':memory:';
process.env.SEED_DEMO = 'false';
process.env.NODE_ENV = 'test';
process.env.SETUP_KEY = 'test-setup-key';

const { initDatabase, closeDatabase, query } = await import('../db.js');
const { createApp } = await import('../server.js');

let server;
let base;

async function req(path, { method = 'GET', token, body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test('English Hub API', async (t) => {
  await initDatabase();
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  let teacherToken = '';
  let studentToken = '';
  let lessonId = '';
  let draftLessonId = '';
  let slideMaterialId = '';

  await t.test('health e bootstrap', async () => {
    const health = await req('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    const boot = await req('/api/bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.data.needsSetup, true);
    assert.equal(boot.data.setupAllowed, true);
  });

  await t.test('setup do professor exige chave em produção-like e cria conta', async () => {
    const bad = await req('/api/setup', { method: 'POST', body: { name: 'Prof', email: 'prof@test.com', password: 'Senha123!', setupKey: 'errada' } });
    assert.equal(bad.status, 403);
    const ok = await req('/api/setup', { method: 'POST', body: { name: 'Prof', email: 'prof@test.com', password: 'Senha123!', setupKey: 'test-setup-key' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.role, 'teacher');
    teacherToken = ok.data.token;
  });

  await t.test('bootstrap depois do setup: sem setup pendente e setup liberado', async () => {
    const boot = await req('/api/bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.data.needsSetup, false);
    assert.equal(boot.data.setupAllowed, true);
  });

  await t.test('login e sessão', async () => {
    const bad = await req('/api/login', { method: 'POST', body: { email: 'prof@test.com', password: 'errada' } });
    assert.equal(bad.status, 401);
    const ok = await req('/api/login', { method: 'POST', body: { email: 'prof@test.com', password: 'Senha123!' } });
    assert.equal(ok.status, 200);
    teacherToken = ok.data.token;
    const me = await req('/api/me', { token: teacherToken });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, 'prof@test.com');
  });

  await t.test('professor cria aula publicada e rascunho', async () => {
    const pub = await req('/api/lessons', { method: 'POST', token: teacherToken, body: { title: 'Lesson 1', description: 'Greetings', published: true, position: 1 } });
    assert.equal(pub.status, 201);
    lessonId = pub.data.lesson.id;
    const draft = await req('/api/lessons', { method: 'POST', token: teacherToken, body: { title: 'Draft', published: false } });
    assert.equal(draft.status, 201);
    draftLessonId = draft.data.lesson.id;
  });

  await t.test('professor adiciona texto, link e slide', async () => {
    const text = await req(`/api/lessons/${lessonId}/materials`, { method: 'POST', token: teacherToken, body: { type: 'text', title: 'Notes', body: 'Hello!' } });
    assert.equal(text.status, 201);
    const link = await req(`/api/lessons/${lessonId}/materials`, { method: 'POST', token: teacherToken, body: { type: 'link', title: 'BBC', url: 'https://example.com' } });
    assert.equal(link.status, 201);

    const fd = new FormData();
    fd.set('type', 'slide');
    fd.set('title', 'Slides');
    fd.set('file', new Blob(['%PDF-1.4 fake pdf'], { type: 'application/pdf' }), 'slides.pdf');
    const slide = await req(`/api/lessons/${lessonId}/materials`, { method: 'POST', token: teacherToken, body: fd });
    assert.equal(slide.status, 201);
    slideMaterialId = slide.data.material.id;
    assert.equal(slide.data.material.hasFile, true);
  });

  await t.test('professor cria aluno', async () => {
    const created = await req('/api/students', { method: 'POST', token: teacherToken, body: { name: 'Ana', email: 'ana@test.com', password: 'Aluno123!' } });
    assert.equal(created.status, 201);
    const login = await req('/api/login', { method: 'POST', body: { email: 'ana@test.com', password: 'Aluno123!' } });
    assert.equal(login.status, 200);
    studentToken = login.data.token;
  });

  await t.test('aluno só vê aulas publicadas e não acessa rotas de professor', async () => {
    const list = await req('/api/lessons', { token: studentToken });
    assert.equal(list.status, 200);
    assert.equal(list.data.lessons.length, 1);
    assert.equal(list.data.lessons[0].id, lessonId);
    const draft = await req(`/api/lessons/${draftLessonId}`, { token: studentToken });
    assert.equal(draft.status, 404);
    const forbidden = await req('/api/students', { token: studentToken });
    assert.equal(forbidden.status, 403);
  });

  await t.test('aluno marca visto/não visto e professor vê progresso', async () => {
    const seen = await req(`/api/lessons/${lessonId}/progress`, { method: 'POST', token: studentToken, body: { seen: true } });
    assert.equal(seen.status, 200);
    assert.equal(seen.data.seen, true);
    const progress = await req('/api/progress', { token: teacherToken });
    assert.equal(progress.status, 200);
    assert.equal(progress.data.matrix[0].seenCount, 1);
    const unseen = await req(`/api/lessons/${lessonId}/progress`, { method: 'POST', token: studentToken, body: { seen: false } });
    assert.equal(unseen.data.seen, false);
  });

  await t.test('ticket de mídia protege arquivo e suporta range', async () => {
    const noAuth = await req(`/api/materials/${slideMaterialId}/ticket`, { method: 'POST' });
    assert.equal(noAuth.status, 401);
    const ticket = await req(`/api/materials/${slideMaterialId}/ticket`, { method: 'POST', token: studentToken });
    assert.equal(ticket.status, 200);
    const file = await fetch(base + ticket.data.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    const range = await fetch(base + ticket.data.url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal((await range.text()).length, 4);
  });

  await t.test('logout invalida sessão', async () => {
    const out = await req('/api/logout', { method: 'POST', token: studentToken });
    assert.equal(out.status, 200);
    const me = await req('/api/me', { token: studentToken });
    assert.equal(me.status, 401);
  });

  await closeDatabase();
  server.close();
});
