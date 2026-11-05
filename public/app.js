/* English Hub — frontend sem dependências externas. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const app = $('#app');
  const modal = $('#modal');
  const modalContent = $('#modal-content');
  const toastEl = $('#toast');

  // localStorage pode lançar (modo privado, storage bloqueado em webview) — nunca deixe isso quebrar a tela.
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* sem storage */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch { /* sem storage */ } }
  };
  const parseStored = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

  const state = {
    token: store.get('eh_token') || '',
    user: parseStored(store.get('eh_user')),
    bootstrap: null,
    tab: 'lessons',
    lessons: [],
    overview: null,
    students: [],
    progress: null,
    currentLesson: null,
    materials: [],
    lessonSeen: false,
    filter: 'all',
    busy: false
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (v) => v ? new Date(v).toLocaleDateString('pt-BR') : '—';
  const typeName = { slide: 'Slides', text: 'Texto', audio: 'Áudio', link: 'Link' };
  const typeIcon = { slide: '📊', text: '📝', audio: '🎧', link: '🔗' };

  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', isError);
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 3800);
  }

  // Erro temporário: servidor acordando (plano gratuito do Render) ou rede instável.
  class TransientError extends Error {}

  async function api(path, { method = 'GET', body, headers = {}, timeout = 25000 } = {}) {
    const opts = { method, headers: { ...headers } };
    if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(path, { ...opts, signal: controller.signal });
    } catch {
      throw new TransientError('Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.');
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text().catch(() => '');
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = null; } }

    if (res.status === 401 && !['/api/login', '/api/setup'].includes(path)) {
      clearSession();
      renderAuth();
      throw new Error(data?.error || 'Sessão expirada. Entre novamente.');
    }
    // Enquanto a instância acorda, o Render responde 502/503 com uma página HTML
    // (não JSON). Sem este tratamento a tela de login quebrava com "Erro 502".
    if (!res.ok || !data) {
      if ([502, 503, 504].includes(res.status) || (!data && res.ok)) {
        throw new TransientError('O servidor está acordando. Aguarde alguns segundos — isso só acontece na primeira visita.');
      }
      if (res.status === 429) throw new Error(data?.error || 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
      throw new Error(data?.error || `Erro ${res.status} ao acessar o servidor.`);
    }
    return data;
  }

  async function apiWithRetry(path, options = {}, { attempts = 4, onRetry } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await api(path, options);
      } catch (err) {
        lastError = err;
        if (!(err instanceof TransientError) || attempt === attempts - 1) throw err;
        if (onRetry) onRetry(attempt + 1, attempts);
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function setSession(data) {
    state.token = data.token;
    state.user = data.user;
    store.set('eh_token', data.token);
    store.set('eh_user', JSON.stringify(data.user));
  }
  function clearSession() {
    state.token = '';
    state.user = null;
    store.remove('eh_token');
    store.remove('eh_user');
  }

  function openModal(html) {
    modalContent.innerHTML = html;
    modal.hidden = false;
    const first = modalContent.querySelector('input, select, textarea, button');
    if (first) first.focus();
  }
  function closeModal() {
    modal.hidden = true;
    modalContent.innerHTML = '';
  }

  function shell(content) {
    const u = state.user;
    return `
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand"><span class="brand-mark">E</span><span>${esc(state.bootstrap?.appName || 'English Hub')}</span></div>
          <div class="userbox">
            <span class="user-name">${esc(u.name)}</span>
            <span class="role-pill">${u.role === 'teacher' ? 'Professor' : 'Aluno'}</span>
            <button class="btn secondary small" data-action="change-password">Alterar senha</button>
            <button class="btn ghost small" data-action="logout">Sair</button>
          </div>
        </div>
      </header>
      <main class="container">${content}</main>`;
  }

  function renderAuth(message = '') {
    const b = state.bootstrap || { appName: 'English Hub', demo: false, needsSetup: false };
    const isSetup = b.needsSetup;
    // needsSetup + sem SETUP_KEY em produção: o formulário nunca funcionaria,
    // então mostramos a instrução em vez de deixar o usuário levar um 403.
    const setupBlocked = isSetup && b.setupAllowed === false;
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="card auth-card">
          <div class="brand"><span class="brand-mark">E</span><span>${esc(b.appName)}</span></div>
          <h1>${isSetup ? 'Configurar professor' : 'Entrar'}</h1>
          <p class="muted">${isSetup ? 'Crie a conta inicial do professor para começar.' : 'Acesse suas aulas de inglês.'}</p>
          ${b.demo ? `<div class="notice">Modo demonstração: use <strong>professor@demo.com / Professor123!</strong> ou <strong>aluno@demo.com / Aluno123!</strong>.
            <div class="btn-row" style="margin-top:10px">
              <button class="btn small secondary" data-action="demo-fill" data-email="professor@demo.com" data-password="Professor123!">Preencher professor</button>
              <button class="btn small secondary" data-action="demo-fill" data-email="aluno@demo.com" data-password="Aluno123!">Preencher aluno</button>
            </div></div>` : ''}
          ${setupBlocked ? `<div class="notice warn">
            <strong>Configuração inicial bloqueada.</strong> Nenhum professor foi cadastrado e o servidor está sem <code>SETUP_KEY</code>.
            Defina <code>SETUP_KEY</code> (ou <code>TEACHER_EMAIL</code> / <code>TEACHER_PASSWORD</code>) nas variáveis de ambiente e reinicie o serviço.
          </div>` : `<form id="${isSetup ? 'setup-form' : 'login-form'}">
            ${isSetup ? `<div class="field"><label for="name">Nome</label><input id="name" name="name" required minlength="2" maxlength="120" autocomplete="name"></div>` : ''}
            <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" required autocomplete="username" autocapitalize="none" spellcheck="false" autofocus></div>
            <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" required minlength="8" autocomplete="${isSetup ? 'new-password' : 'current-password'}"></div>
            ${isSetup ? `<div class="field"><label for="setupKey">Chave de configuração <span class="muted">(opcional)</span></label><input id="setupKey" name="setupKey" type="password" autocomplete="off"></div>` : ''}
            <button class="btn" type="submit" id="auth-submit" style="width:100%">${isSetup ? 'Criar professor e entrar' : 'Entrar'}</button>
            <p class="error" id="auth-error" hidden></p>
          </form>`}
          ${message ? `<p class="error">${esc(message)}</p>` : ''}
        </div>
      </div>`;
  }

  async function loadTeacher() {
    const [overview, lessons] = await Promise.all([api('/api/teacher/overview'), api('/api/lessons')]);
    state.overview = overview;
    state.lessons = lessons.lessons;
  }
  async function loadStudent() {
    const { lessons } = await api('/api/lessons');
    state.lessons = lessons;
  }
  async function loadStudents() {
    const { students } = await api('/api/students');
    state.students = students;
  }
  async function loadProgress() {
    state.progress = await api('/api/progress');
  }

  function statCard(value, label) {
    return `<div class="card stat"><span class="value">${esc(value)}</span><span class="label">${esc(label)}</span></div>`;
  }

  function teacherTabs() {
    const tabs = [['lessons', 'Aulas'], ['students', 'Alunos'], ['progress', 'Progresso']];
    return `<div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-action="nav-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
  }

  function renderTeacher() {
    let body = '';
    if (state.currentLesson) body = renderLessonDetail(true);
    else if (state.tab === 'lessons') body = renderTeacherLessons();
    else if (state.tab === 'students') body = renderStudents();
    else if (state.tab === 'progress') body = renderProgress();
    app.innerHTML = shell(`${teacherTabs()}${body}`);
    if (state.currentLesson) hydrateFiles();
  }

  function renderTeacherLessons() {
    const o = state.overview || {};
    return `
      <div class="grid cols-4">
        ${statCard(o.students ?? 0, 'Alunos ativos')}
        ${statCard(o.publishedLessons ?? 0, 'Aulas publicadas')}
        ${statCard(o.materials ?? 0, 'Materiais')}
        ${statCard(`${o.completionRate ?? 0}%`, 'Conclusão geral')}
      </div>
      <div class="section-head">
        <h1>Aulas</h1>
        <button class="btn" data-action="new-lesson">+ Nova aula</button>
      </div>
      ${state.lessons.length ? `<div class="grid cols-2">${state.lessons.map(lessonCardTeacher).join('')}</div>` : `<div class="card empty">Nenhuma aula criada ainda. Clique em <strong>+ Nova aula</strong>.</div>`}`;
  }

  function lessonCardTeacher(l) {
    return `
      <article class="card lesson-card">
        <div class="lesson-top">
          <div>
            <h2 class="lesson-title">${esc(l.title)}</h2>
            <p class="lesson-desc">${esc(l.description || 'Sem descrição.')}</p>
          </div>
          <span class="badge ${l.published ? 'green' : 'amber'}">${l.published ? 'Publicada' : 'Rascunho'}</span>
        </div>
        <div class="meta">
          <span>${l.materialCount || 0} material(is)</span>
          <span>•</span>
          <span>${l.seenCount || 0} aluno(s) viram</span>
          <span>•</span>
          <span>Ordem ${l.position}</span>
        </div>
        <div class="btn-row">
          <button class="btn small" data-action="open-lesson" data-id="${l.id}">Abrir / materiais</button>
          <button class="btn small secondary" data-action="edit-lesson" data-id="${l.id}">Editar</button>
          <button class="btn small secondary" data-action="toggle-publish" data-id="${l.id}">${l.published ? 'Despublicar' : 'Publicar'}</button>
          <button class="btn small danger" data-action="delete-lesson" data-id="${l.id}">Excluir</button>
        </div>
      </article>`;
  }

  function renderStudents() {
    return `
      <div class="section-head">
        <h1>Alunos</h1>
        <button class="btn" data-action="new-student">+ Novo aluno</button>
      </div>
      ${state.students.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Status</th><th>Progresso</th><th>Ações</th></tr></thead>
        <tbody>${state.students.map(s => `
          <tr>
            <td><strong>${esc(s.name)}</strong><div class="small muted">Desde ${fmtDate(s.createdAt)}</div></td>
            <td>${esc(s.email)}</td>
            <td><span class="badge ${s.active ? 'green' : 'gray'}">${s.active ? 'Ativo' : 'Inativo'}</span></td>
            <td>${s.seenCount}/${s.totalLessons} aulas vistas</td>
            <td><div class="btn-row">
              <button class="btn small secondary" data-action="edit-student" data-id="${s.id}">Editar</button>
              <button class="btn small secondary" data-action="reset-student" data-id="${s.id}">Senha</button>
              <button class="btn small danger" data-action="delete-student" data-id="${s.id}">Excluir</button>
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="card empty">Nenhum aluno cadastrado.</div>`}`;
  }

  function renderProgress() {
    const p = state.progress;
    if (!p) return '<div class="skeleton">Carregando progresso…</div>';
    if (!p.lessons.length) return '<div class="card empty">Publique aulas para acompanhar o progresso.</div>';
    return `
      <div class="section-head">
        <h1>Progresso por aula</h1>
        <button class="btn secondary" data-action="export-csv">Exportar CSV</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Aluno</th>${p.lessons.map(l => `<th>${esc(l.title)}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${p.matrix.map(row => `
          <tr>
            <td><strong>${esc(row.student.name)}</strong><div class="small muted">${esc(row.student.email)}</div></td>
            ${row.items.map(i => `<td>${i.seen ? '<span class="badge green">Visto</span>' : '<span class="badge gray">Não visto</span>'}</td>`).join('')}
            <td><strong>${row.seenCount}/${p.lessons.length}</strong></td>
          </tr>`).join('')}
        </tbody></table></div>`;
  }

  function renderStudent() {
    if (state.currentLesson) {
      app.innerHTML = shell(renderLessonDetail(false));
      hydrateFiles();
      return;
    }
    const total = state.lessons.length;
    const seen = state.lessons.filter(l => l.seen).length;
    const pct = total ? Math.round((seen / total) * 100) : 0;
    const filtered = state.lessons.filter(l => state.filter === 'all' ? true : state.filter === 'seen' ? l.seen : !l.seen);
    app.innerHTML = shell(`
      <div class="card">
        <div class="spread">
          <div>
            <h1 style="margin:0">Olá, ${esc(state.user.name.split(' ')[0])}!</h1>
            <p class="muted" style="margin:6px 0 0">Seu progresso nas aulas publicadas.</p>
          </div>
          <span class="badge blue">${seen}/${total} vistas</span>
        </div>
        <div class="progress-bar" style="margin-top:14px"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="section-head">
        <h2>Aulas</h2>
        <div class="btn-row">
          <button class="tab ${state.filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">Todas</button>
          <button class="tab ${state.filter === 'pending' ? 'active' : ''}" data-action="filter" data-filter="pending">Não vistas</button>
          <button class="tab ${state.filter === 'seen' ? 'active' : ''}" data-action="filter" data-filter="seen">Vistas</button>
        </div>
      </div>
      ${filtered.length ? `<div class="grid cols-2">${filtered.map(lessonCardStudent).join('')}</div>` : `<div class="card empty">Nenhuma aula nesta visualização.</div>`}`);
  }

  function lessonCardStudent(l) {
    return `
      <article class="card lesson-card">
        <div class="lesson-top">
          <div>
            <h2 class="lesson-title">${esc(l.title)}</h2>
            <p class="lesson-desc">${esc(l.description || '')}</p>
          </div>
          <span class="badge ${l.seen ? 'green' : 'gray'}">${l.seen ? 'Visto' : 'Não visto'}</span>
        </div>
        <div class="meta"><span>${l.materialCount || 0} material(is)</span></div>
        <div class="btn-row">
          <button class="btn small" data-action="open-lesson" data-id="${l.id}">${l.seen ? 'Rever aula' : 'Acessar aula'}</button>
          <button class="btn small secondary" data-action="toggle-seen" data-id="${l.id}">${l.seen ? 'Marcar não visto' : 'Marcar visto'}</button>
        </div>
      </article>`;
  }

  function renderLessonDetail(isTeacher) {
    const l = state.currentLesson;
    return `
      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn secondary small" data-action="back-lessons">← Voltar</button>
        ${isTeacher ? `<button class="btn small" data-action="add-material">+ Adicionar material</button>
        <button class="btn small secondary" data-action="edit-lesson" data-id="${l.id}">Editar aula</button>
        <button class="btn small secondary" data-action="toggle-publish" data-id="${l.id}">${l.published ? 'Despublicar' : 'Publicar'}</button>` : ''}
      </div>
      <div class="card">
        <div class="spread">
          <div>
            <h1 style="margin:0">${esc(l.title)}</h1>
            <p class="muted" style="margin:6px 0 0">${esc(l.description || '')}</p>
          </div>
          ${isTeacher ? `<span class="badge ${l.published ? 'green' : 'amber'}">${l.published ? 'Publicada' : 'Rascunho'}</span>` : `<button class="btn ${state.lessonSeen ? 'secondary' : 'success'}" data-action="toggle-seen" data-id="${l.id}">${state.lessonSeen ? 'Marcar como não visto' : 'Marcar como visto'}</button>`}
        </div>
      </div>
      <div class="section-head"><h2>Materiais</h2></div>
      ${state.materials.length ? state.materials.map(m => materialBlock(m, isTeacher)).join('') : `<div class="card empty">Nenhum material nesta aula ainda.</div>`}
      ${!isTeacher && state.materials.length ? `<div class="card" style="margin-top:18px;text-align:center">
        <button class="btn ${state.lessonSeen ? 'secondary' : 'success'}" data-action="toggle-seen" data-id="${l.id}">${state.lessonSeen ? 'Marcar como não visto' : 'Concluir aula (marcar visto)'}</button>
      </div>` : ''}`;
  }

  function materialBlock(m, isTeacher) {
    let content = '';
    if (m.type === 'text') content = `<p class="material-body">${esc(m.body)}</p>`;
    else if (m.type === 'link') content = `<p style="margin:10px 0 0"><a class="btn small" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Abrir link ↗</a></p>`;
    else content = `<div data-file-material="${m.id}" data-type="${m.type}" data-mime="${esc(m.mimeType || '')}"><p class="muted small">Carregando arquivo…</p></div>`;
    return `
      <section class="material">
        <div class="material-head">
          <div>
            <span class="badge blue">${typeIcon[m.type]} ${typeName[m.type]}</span>
            <h3 class="material-title" style="margin-top:8px">${esc(m.title)}</h3>
            ${m.fileName ? `<div class="small muted">${esc(m.fileName)} ${m.fileSize ? `(${(m.fileSize / 1024 / 1024).toFixed(2)} MB)` : ''}</div>` : ''}
          </div>
          ${isTeacher ? `<div class="btn-row">
            <button class="btn small secondary" data-action="edit-material" data-id="${m.id}">Editar</button>
            <button class="btn small danger" data-action="delete-material" data-id="${m.id}">Excluir</button>
          </div>` : ''}
        </div>
        ${content}
      </section>`;
  }

  async function hydrateFiles() {
    const nodes = $$('[data-file-material]');
    await Promise.all(nodes.map(async (node) => {
      const id = node.dataset.fileMaterial;
      try {
        const { url } = await api(`/api/materials/${id}/ticket`, { method: 'POST' });
        const mime = node.dataset.mime || '';
        if (node.dataset.type === 'audio') {
          node.innerHTML = `<audio controls preload="metadata" src="${esc(url)}"></audio>`;
        } else if (mime === 'application/pdf') {
          node.innerHTML = `<iframe class="file-frame" src="${esc(url)}" title="Visualização de PDF"></iframe>
            <div class="btn-row" style="margin-top:10px"><a class="btn small secondary" href="${esc(url)}" target="_blank" rel="noopener">Abrir PDF</a></div>`;
        } else {
          node.innerHTML = `<div class="btn-row" style="margin-top:10px"><a class="btn small" href="${esc(url)}" download>Baixar arquivo</a></div>`;
        }
      } catch (err) {
        node.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    }));
  }

  async function openLesson(id) {
    const data = await api(`/api/lessons/${id}`);
    state.currentLesson = data.lesson;
    state.materials = data.materials;
    state.lessonSeen = !!data.seen;
    render();
  }

  function render() {
    if (!state.user) return renderAuth();
    if (state.user.role === 'teacher') renderTeacher();
    else renderStudent();
  }

  // ---------- Modais / formulários ----------
  function lessonForm(l = {}) {
    openModal(`
      <h2 id="modal-title">${l.id ? 'Editar aula' : 'Nova aula'}</h2>
      <form id="lesson-form" data-id="${l.id || ''}">
        <div class="field"><label>Título</label><input name="title" required maxlength="180" value="${esc(l.title || '')}"></div>
        <div class="field"><label>Descrição</label><textarea name="description" maxlength="2000">${esc(l.description || '')}</textarea></div>
        <div class="field"><label>Ordem</label><input name="position" type="number" min="0" value="${l.position ?? state.lessons.length + 1}"></div>
        <label class="checkbox"><input name="published" type="checkbox" ${l.published ? 'checked' : ''}> Publicada para alunos</label>
        <div class="btn-row" style="margin-top:18px"><button class="btn" type="submit">Salvar</button><button class="btn secondary" type="button" data-close-modal>Cancelar</button></div>
      </form>`);
  }

  function materialForm(m = null) {
    const isEdit = !!m;
    const type = m?.type || 'text';
    openModal(`
      <h2 id="modal-title">${isEdit ? 'Editar material' : 'Adicionar material'}</h2>
      <form id="material-form" data-id="${m?.id || ''}" data-type="${type}">
        ${!isEdit ? `<div class="field"><label>Tipo</label><select name="type" id="material-type">
          <option value="text">Texto</option><option value="slide">Slides (PDF/PPT)</option><option value="audio">Áudio</option><option value="link">Link</option>
        </select></div>` : `<p><span class="badge blue">${typeIcon[type]} ${typeName[type]}</span></p>`}
        <div class="field"><label>Título</label><input name="title" required maxlength="180" value="${esc(m?.title || '')}"></div>
        <div data-fields="text" ${type !== 'text' ? 'hidden' : ''}><div class="field"><label>Texto</label><textarea name="body" rows="8">${esc(m?.body || '')}</textarea></div></div>
        <div data-fields="link" ${type !== 'link' ? 'hidden' : ''}><div class="field"><label>URL</label><input name="url" type="url" placeholder="https://..." value="${esc(m?.url || '')}"></div></div>
        <div data-fields="file" ${['slide', 'audio'].includes(type) ? '' : 'hidden'}>
          <div class="field"><label>Arquivo ${isEdit ? '(deixe vazio para manter o atual)' : ''}</label>
          <input name="file" type="file" accept="${type === 'audio' ? '.mp3,.wav,.ogg,.m4a,.aac,.webm,.flac,audio/*' : '.pdf,.ppt,.pptx,.odp'}" ${!isEdit && ['slide','audio'].includes(type) ? 'required' : ''}></div>
          <p class="small muted">Limite: ${state.bootstrap?.maxUploadMB || 15} MB. ${type === 'slide' ? 'PDF é exibido no navegador; PPT/PPTX/ODP para download.' : 'MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC.'}</p>
        </div>
        <div class="btn-row" style="margin-top:18px"><button class="btn" type="submit">Salvar</button><button class="btn secondary" type="button" data-close-modal>Cancelar</button></div>
      </form>`);
    const sel = $('#material-type');
    if (sel) sel.addEventListener('change', () => {
      const t = sel.value;
      $('[data-fields="text"]').hidden = t !== 'text';
      $('[data-fields="link"]').hidden = t !== 'link';
      $('[data-fields="file"]').hidden = !['slide', 'audio'].includes(t);
      const file = $('input[name="file"]');
      file.required = ['slide', 'audio'].includes(t);
      file.accept = t === 'audio' ? '.mp3,.wav,.ogg,.m4a,.aac,.webm,.flac,audio/*' : '.pdf,.ppt,.pptx,.odp';
    });
  }

  function studentForm(s = null) {
    openModal(`
      <h2 id="modal-title">${s ? 'Editar aluno' : 'Novo aluno'}</h2>
      <form id="student-form" data-id="${s?.id || ''}">
        <div class="field"><label>Nome</label><input name="name" required minlength="2" maxlength="120" value="${esc(s?.name || '')}"></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" required value="${esc(s?.email || '')}"></div>
        ${!s ? `<div class="field"><label>Senha inicial</label><input name="password" type="password" required minlength="8"></div>` : `<label class="checkbox"><input name="active" type="checkbox" ${s.active ? 'checked' : ''}> Aluno ativo</label>`}
        <div class="btn-row" style="margin-top:18px"><button class="btn" type="submit">Salvar</button><button class="btn secondary" type="button" data-close-modal>Cancelar</button></div>
      </form>`);
  }

  function resetPasswordForm(s) {
    openModal(`
      <h2 id="modal-title">Redefinir senha — ${esc(s.name)}</h2>
      <form id="reset-form" data-id="${s.id}">
        <div class="field"><label>Nova senha</label><input name="password" type="password" required minlength="8"></div>
        <div class="btn-row"><button class="btn" type="submit">Redefinir</button><button class="btn secondary" type="button" data-close-modal>Cancelar</button></div>
      </form>`);
  }

  function changePasswordForm() {
    openModal(`
      <h2 id="modal-title">Alterar senha</h2>
      <form id="password-form">
        <div class="field"><label>Senha atual</label><input name="currentPassword" type="password" required autocomplete="current-password"></div>
        <div class="field"><label>Nova senha</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="btn-row"><button class="btn" type="submit">Salvar</button><button class="btn secondary" type="button" data-close-modal>Cancelar</button></div>
      </form>`);
  }

  function exportCsv() {
    const p = state.progress;
    if (!p) return;
    const header = ['Aluno', 'E-mail', ...p.lessons.map(l => l.title), 'Total'];
    const rows = p.matrix.map(r => [r.student.name, r.student.email, ...r.items.map(i => i.seen ? 'Visto' : 'Não visto'), `${r.seenCount}/${p.lessons.length}`]);
    const csv = [header, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'progresso-english-hub.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Eventos ----------
  document.addEventListener('click', async (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn || e.target === modal) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || state.busy) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    try {
      if (action === 'reload') {
        location.reload();
      } else if (action === 'retry-boot') {
        await init();
      } else if (action === 'demo-fill') {
        $('#email').value = el.dataset.email;
        $('#password').value = el.dataset.password;
      } else if (action === 'logout') {
        try { await api('/api/logout', { method: 'POST' }); } catch { /* ignora */ }
        clearSession();
        state.currentLesson = null;
        try {
          state.bootstrap = await apiWithRetry('/api/bootstrap', {}, { attempts: 3 });
        } catch { /* mantém o bootstrap anterior */ }
        renderAuth();
      } else if (action === 'nav-tab') {
        state.tab = el.dataset.tab;
        state.currentLesson = null;
        if (state.tab === 'students') await loadStudents();
        if (state.tab === 'progress') await loadProgress();
        if (state.tab === 'lessons') await loadTeacher();
        renderTeacher();
      } else if (action === 'filter') {
        state.filter = el.dataset.filter;
        renderStudent();
      } else if (action === 'open-lesson') {
        await openLesson(id);
      } else if (action === 'back-lessons') {
        state.currentLesson = null;
        if (state.user.role === 'teacher') await loadTeacher(); else await loadStudent();
        render();
      } else if (action === 'new-lesson') {
        lessonForm();
      } else if (action === 'edit-lesson') {
        const l = state.lessons.find(x => x.id === id) || state.currentLesson;
        lessonForm(l);
      } else if (action === 'delete-lesson') {
        if (!confirm('Excluir esta aula e todos os materiais?')) return;
        await api(`/api/lessons/${id}`, { method: 'DELETE' });
        toast('Aula excluída.');
        state.currentLesson = null;
        await loadTeacher();
        renderTeacher();
      } else if (action === 'toggle-publish') {
        const l = state.lessons.find(x => x.id === id) || state.currentLesson;
        await api(`/api/lessons/${id}`, { method: 'PATCH', body: { published: !l.published } });
        toast('Status da aula atualizado.');
        if (state.currentLesson?.id === id) await openLesson(id);
        await loadTeacher();
        renderTeacher();
      } else if (action === 'toggle-seen') {
        const target = state.currentLesson?.id === id ? state.lessonSeen : state.lessons.find(l => l.id === id)?.seen;
        const data = await api(`/api/lessons/${id}/progress`, { method: 'POST', body: { seen: !target } });
        toast(data.seen ? 'Aula marcada como vista.' : 'Aula marcada como não vista.');
        const l = state.lessons.find(x => x.id === id);
        if (l) l.seen = data.seen;
        if (state.currentLesson?.id === id) state.lessonSeen = data.seen;
        render();
      } else if (action === 'add-material') {
        materialForm();
      } else if (action === 'edit-material') {
        materialForm(state.materials.find(m => m.id === id));
      } else if (action === 'delete-material') {
        if (!confirm('Excluir este material?')) return;
        await api(`/api/materials/${id}`, { method: 'DELETE' });
        toast('Material excluído.');
        await openLesson(state.currentLesson.id);
      } else if (action === 'new-student') {
        studentForm();
      } else if (action === 'edit-student') {
        studentForm(state.students.find(s => s.id === id));
      } else if (action === 'reset-student') {
        resetPasswordForm(state.students.find(s => s.id === id));
      } else if (action === 'delete-student') {
        if (!confirm('Excluir este aluno? O progresso também será removido.')) return;
        await api(`/api/students/${id}`, { method: 'DELETE' });
        toast('Aluno excluído.');
        await loadStudents();
        renderTeacher();
      } else if (action === 'change-password') {
        changePasswordForm();
      } else if (action === 'export-csv') {
        exportCsv();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    const fd = new FormData(form);
    const obj = Object.fromEntries(fd.entries());
    const isAuthForm = form.id === 'login-form' || form.id === 'setup-form';
    const submitBtn = isAuthForm ? form.querySelector('#auth-submit') : null;
    const submitLabel = submitBtn ? submitBtn.textContent : '';
    try {
      state.busy = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = form.id === 'login-form' ? 'Entrando…' : 'Criando conta…';
      }
      if (form.id === 'login-form') {
        const data = await api('/api/login', { method: 'POST', body: { email: obj.email, password: obj.password } });
        setSession(data);
        state.currentLesson = null;
        if (data.user.role === 'teacher') await loadTeacher(); else await loadStudent();
        render();
      } else if (form.id === 'setup-form') {
        const data = await api('/api/setup', { method: 'POST', body: obj });
        setSession(data);
        state.bootstrap.needsSetup = false;
        await loadTeacher();
        render();
      } else if (form.id === 'lesson-form') {
        const id = form.dataset.id;
        const body = { title: obj.title, description: obj.description, position: Number(obj.position || 0), published: !!fd.get('published') };
        if (id) await api(`/api/lessons/${id}`, { method: 'PATCH', body });
        else await api('/api/lessons', { method: 'POST', body });
        closeModal();
        toast('Aula salva.');
        if (state.currentLesson) await openLesson(state.currentLesson.id);
        await loadTeacher();
        renderTeacher();
      } else if (form.id === 'material-form') {
        const id = form.dataset.id;
        const fileInput = form.querySelector('input[name="file"]');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) fd.delete('file');
        if (id) {
          await api(`/api/materials/${id}`, { method: 'PATCH', body: fd });
        } else {
          await api(`/api/lessons/${state.currentLesson.id}/materials`, { method: 'POST', body: fd });
        }
        closeModal();
        toast('Material salvo.');
        await openLesson(state.currentLesson.id);
      } else if (form.id === 'student-form') {
        const id = form.dataset.id;
        if (id) {
          await api(`/api/students/${id}`, { method: 'PATCH', body: { name: obj.name, email: obj.email, active: !!fd.get('active') } });
        } else {
          await api('/api/students', { method: 'POST', body: obj });
        }
        closeModal();
        toast('Aluno salvo.');
        await loadStudents();
        renderTeacher();
      } else if (form.id === 'reset-form') {
        await api(`/api/students/${form.dataset.id}/reset-password`, { method: 'POST', body: { password: obj.password } });
        closeModal();
        toast('Senha redefinida.');
      } else if (form.id === 'password-form') {
        await api('/api/change-password', { method: 'POST', body: obj });
        closeModal();
        toast('Senha alterada.');
      }
    } catch (err) {
      if (isAuthForm) {
        const errEl = $('#auth-error');
        if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
        else toast(err.message, true);
      } else toast(err.message, true);
    } finally {
      state.busy = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    }
  });

  document.addEventListener('input', (e) => {
    const errEl = $('#auth-error');
    if (errEl && !errEl.hidden && e.target.closest('#login-form, #setup-form')) errEl.hidden = true;
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  function bootStatus(message) {
    const el = document.getElementById('boot-status');
    if (el) el.textContent = message;
  }

  function renderBootSkeleton() {
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="card auth-card auth-loading">
          <div class="brand"><span class="brand-mark">E</span><span>English Hub</span></div>
          <h1>Carregando…</h1>
          <p class="muted" id="boot-status">Conectando ao servidor…</p>
          <div class="spinner" aria-hidden="true"></div>
        </div>
      </div>`;
  }

  function renderBootError(message) {
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="card auth-card">
          <div class="brand"><span class="brand-mark">E</span><span>English Hub</span></div>
          <h1>Não foi possível carregar</h1>
          <p class="error">${esc(message)}</p>
          <p class="muted small">Se o site ficou um tempo sem uso, o servidor gratuito pode levar até um minuto para responder. Tente novamente em instantes.</p>
          <button class="btn" data-action="retry-boot" style="width:100%">Tentar novamente</button>
        </div>
      </div>`;
  }

  async function init() {
    if (!document.getElementById('boot-status')) renderBootSkeleton();
    bootStatus('Conectando ao servidor…');
    try {
      state.bootstrap = await apiWithRetry('/api/bootstrap', {}, {
        attempts: 5,
        onRetry: (attempt) => bootStatus(attempt >= 2
          ? 'O servidor está acordando… isso pode levar até um minuto na primeira visita.'
          : 'Reconectando…')
      });
      if (state.token) {
        try {
          const { user } = await api('/api/me');
          state.user = user;
          store.set('eh_user', JSON.stringify(user));
          if (user.role === 'teacher') await loadTeacher(); else await loadStudent();
          return render();
        } catch (err) {
          // Só descarta a sessão quando o servidor confirma que ela não vale mais.
          if (err instanceof TransientError) throw err;
          clearSession();
        }
      }
      renderAuth();
    } catch (err) {
      renderBootError(err.message);
    }
  }

  init();
})();
