/*
 * Admin review dashboard.
 *
 * The token is held in sessionStorage, not localStorage: it should not survive
 * a browser restart, and it is only ever sent in the X-Admin-Token header.
 * Every applicant answer is rendered with textContent, never innerHTML, so a
 * crafted answer cannot inject markup into the reviewer's page.
 */
(() => {
  'use strict';

  const KEY = 'ctadi.admin.token';
  const loginCard = document.getElementById('login-card');
  const listView = document.getElementById('list-view');
  const detailView = document.getElementById('detail-view');
  const listEl = document.getElementById('app-list');
  const listEmpty = document.getElementById('list-empty');
  const listError = document.getElementById('list-error');
  const loginError = document.getElementById('login-error');
  const filterEl = document.getElementById('filter');

  const token = () => sessionStorage.getItem(KEY) ?? '';

  function show(el, visible) {
    el.classList.toggle('hidden', !visible);
  }

  function el(tag, text, className) {
    const e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (className) e.className = className;
    return e;
  }

  async function api(pathname, options = {}) {
    const res = await fetch(pathname, {
      ...options,
      headers: { 'x-admin-token': token(), ...(options.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      sessionStorage.removeItem(KEY);
      renderLogin('That token was not accepted.');
      throw new Error('unauthorised');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function renderLogin(message) {
    show(loginCard, true);
    show(listView, false);
    show(detailView, false);
    if (message) {
      loginError.textContent = message;
      show(loginError, true);
    } else {
      show(loginError, false);
    }
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  // ---- List ---------------------------------------------------------------

  async function renderList() {
    show(loginCard, false);
    show(detailView, false);
    show(listView, true);
    show(listError, false);
    listEl.textContent = '';
    show(listEmpty, false);

    const status = filterEl.value;
    let data;
    try {
      data = await api(`/api/admin/applications${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    } catch (err) {
      if (err.message === 'unauthorised') return;
      listError.textContent = err.message;
      show(listError, true);
      return;
    }

    if (!data.applications.length) {
      show(listEmpty, true);
      return;
    }

    for (const a of data.applications) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#id=${encodeURIComponent(a.id)}`;

      const who = el('div', null, 'who');
      who.appendChild(el('strong', a.full_name));
      who.appendChild(el('span', `${a.role_label} · ${a.email} · ${fmtDate(a.created_at)}`));

      link.appendChild(who);
      link.appendChild(el('span', a.status.replace('_', ' '), `pill ${a.status}`));
      li.appendChild(link);
      listEl.appendChild(li);
    }
  }

  // ---- Detail -------------------------------------------------------------

  function answerBlock(question, text) {
    const wrap = el('div', null, 'answer');
    wrap.appendChild(el('div', `Section ${question.section} · ${question.id}`, 'meta'));
    wrap.appendChild(el('div', question.label, 'q'));
    wrap.appendChild(el('div', text, 'a'));
    return wrap;
  }

  async function renderDetail(id) {
    show(loginCard, false);
    show(listView, false);
    show(detailView, true);
    const body = document.getElementById('detail-body');
    body.textContent = '';
    body.appendChild(el('p', 'Loading…', 'muted'));

    let data;
    try {
      data = await api(`/api/admin/application?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.message === 'unauthorised') return;
      body.textContent = '';
      body.appendChild(el('div', err.message, 'notice error'));
      return;
    }

    const a = data.application;
    body.textContent = '';

    // Header card: who, status, and the decision controls.
    const head = el('div', null, 'card');
    const title = el('h1', a.identity.full_name);
    title.style.fontSize = '23px';
    head.appendChild(title);
    head.appendChild(el('p', `${a.identity.role_label} · applied ${fmtDate(a.submitted_at)}`, 'lede'));

    const table = el('table', null, 'kv');
    const rows = [
      ['Email', a.identity.email],
      ['Based in', a.identity.country || '—'],
      ['Application', a.id],
      ['Status', a.status.replace('_', ' ')],
    ];
    if (a.decided_at) rows.push(['Decided', `${fmtDate(a.decided_at)} (${a.decided_by || 'admin'})`]);
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', k));
      tr.appendChild(el('td', v));
      table.appendChild(tr);
    }
    head.appendChild(table);

    const decideRow = el('div', null, 'decide');
    if (a.status === 'pending_review') {
      const approve = el('button', 'Approve & reveal invite', 'btn');
      approve.type = 'button';
      approve.addEventListener('click', () => submitDecision(a.id, 'approve', decideRow));
      const reject = el('button', 'Reject', 'btn reject');
      reject.type = 'button';
      reject.addEventListener('click', () => submitDecision(a.id, 'reject', decideRow));
      decideRow.appendChild(approve);
      decideRow.appendChild(reject);
    } else {
      const done = el('div', null, 'notice ok');
      done.textContent =
        a.status === 'approved'
          ? `Approved. The applicant can now see the community invite on their status page.`
          : `Rejected. The applicant sees a polite closing message on their status page.`;
      decideRow.appendChild(done);
    }
    head.appendChild(decideRow);
    body.appendChild(head);

    // The full application, in the applicant's own words.
    const app = el('div', null, 'card');
    app.appendChild(el('h2', 'Application'));
    const byId = new Map((a.questions ?? []).map((q) => [q.id, q]));
    for (const [qid, text] of Object.entries(a.answers ?? {})) {
      const q = byId.get(qid) ?? { id: qid, label: qid, section: '?' };
      app.appendChild(answerBlock(q, text));
    }
    body.appendChild(app);
  }

  async function submitDecision(id, decision, container) {
    const buttons = container.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      const res = await api('/api/admin/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      const note = el('div', null, 'notice ok');
      note.textContent =
        res.decision === 'approved'
          ? res.already_decided
            ? 'This application was already approved.'
            : 'Approved. The applicant can now see the community invite on their status page.'
          : res.already_decided
            ? 'This application was already rejected.'
            : 'Rejected. The applicant will see a polite closing message.';
      container.textContent = '';
      container.appendChild(note);
      // Re-render so the Status row above also reflects the decision.
      renderDetail(id);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      if (err.message === 'unauthorised') return;
      const note = el('div', err.message, 'notice error');
      container.appendChild(note);
    }
  }

  // ---- Routing ------------------------------------------------------------

  function route() {
    const m = /(?:^|[#&?])id=([^&]+)/.exec(window.location.hash || '');
    if (m) return renderDetail(decodeURIComponent(m[1]));
    return renderList();
  }

  // ---- Wiring -------------------------------------------------------------

  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = document.getElementById('token').value.trim();
    if (!value) return;
    sessionStorage.setItem(KEY, value);
    route();
  });

  document.getElementById('refresh').addEventListener('click', renderList);
  filterEl.addEventListener('change', renderList);
  document.getElementById('signout').addEventListener('click', () => {
    sessionStorage.removeItem(KEY);
    renderLogin();
  });
  document.getElementById('back').addEventListener('click', () => {
    window.location.hash = '';
    renderList();
  });
  window.addEventListener('hashchange', route);

  if (token()) route();
  else renderLogin();
})();
