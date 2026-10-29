/* CTaDI application form — renders from /api/form and posts to /api/submit.
   No framework, no build step. All content comes from the server so the form
   definition lives in exactly one place (form.json). */
(() => {
  'use strict';

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  };

  const state = { form: null, answers: {} };

  async function boot() {
    let form;
    try {
      const res = await fetch('/api/form');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      form = await res.json();
    } catch (err) {
      document.getElementById('intro-text').textContent =
        'Sorry — the application form could not be loaded. Please refresh the page.';
      console.error(err);
      return;
    }
    state.form = form;

    document.getElementById('intro-text').textContent = form.intro;
    document.getElementById('consent-label').textContent = form.consent.label;

    renderIdentity(form);
    renderSection('a', form.section_a.questions);
    document.getElementById('section-a-title').textContent = form.section_a.title;
    document.getElementById('section-a-subtitle').textContent = form.section_a.subtitle;
    document.getElementById('section-b-title').textContent = form.section_b.title;
    document.getElementById('section-b-subtitle').textContent = form.section_b.subtitle;
    document.getElementById('section-c-title').textContent = form.availability.title;
    renderSection('c', form.availability.questions, 'section-c-questions');

    document.getElementById('application-form').addEventListener('submit', onSubmit);
  }

  function renderIdentity(form) {
    const host = document.getElementById('identity-fields');
    for (const f of form.identity.fields) {
      const wrap = el('div', { class: 'field' });
      const id = `id_${f.id}`;
      wrap.appendChild(el('label', { class: 'q', for: id, text: f.label + (f.required ? '' : ' (optional)') }));

      let input;
      if (f.type === 'select') {
        input = el('select', { id, name: f.id, required: f.required ? 'required' : null });
        input.appendChild(el('option', { value: '', text: 'Please choose…' }));
        for (const opt of f.options) input.appendChild(el('option', { value: opt.value, text: opt.label }));
        input.addEventListener('change', () => onRoleChange(input.value));
      } else {
        input = el('input', {
          id,
          name: f.id,
          type: f.type === 'email' ? 'email' : 'text',
          autocomplete: f.id === 'email' ? 'email' : f.id === 'full_name' ? 'name' : 'off',
          required: f.required ? 'required' : null,
          maxlength: f.max_chars || null,
        });
      }
      wrap.appendChild(input);
      host.appendChild(wrap);
    }
  }

  function onRoleChange(role) {
    const host = document.getElementById('section-b-questions');
    host.textContent = '';
    const block = state.form.section_b.roles[role];
    if (!block) {
      host.appendChild(el('p', { class: 'muted', text: 'Choose a role above to see the questions for your craft.' }));
      return;
    }
    renderQuestions(host, block.questions);
  }

  function renderSection(letter, questions, hostId = 'section-a-questions') {
    renderQuestions(document.getElementById(hostId), questions);
  }

  function renderQuestions(host, questions) {
    for (const q of questions) {
      const wrap = el('div', { class: 'field' });
      wrap.appendChild(el('span', { class: 'tag', text: `Section ${q.section || ''} · ${q.id}`.replace(' · ', '') }));
      wrap.appendChild(el('label', { class: 'q', for: `a_${q.id}`, text: q.label }));
      if (q.hint) wrap.appendChild(el('span', { class: 'hint', text: q.hint }));

      const ta = el('textarea', { id: `a_${q.id}`, name: q.id, rows: '6' });
      if (q.required) ta.setAttribute('required', 'required');
      if (q.type === 'proficiency') ta.setAttribute('placeholder', 'e.g. 3 — because in my last project I…');
      ta.addEventListener('input', () => {
        state.answers[q.id] = ta.value;
        counter.textContent = `${ta.value.length} characters`;
      });
      wrap.appendChild(ta);

      const counter = el('div', { class: 'counter', text: '0 characters' });
      wrap.appendChild(counter);
      host.appendChild(wrap);
    }
  }

  function collect() {
    const form = state.form;
    const identity = {};
    for (const f of form.identity.fields) {
      const node = document.getElementById(`id_${f.id}`);
      identity[f.id] = node ? node.value.trim() : '';
    }
    const answers = {};
    const qs = [
      ...form.section_a.questions,
      ...(form.section_b.roles[identity.role]?.questions ?? []),
      ...form.availability.questions,
    ];
    for (const q of qs) {
      const node = document.getElementById(`a_${q.id}`);
      answers[q.id] = node ? node.value.trim() : '';
    }
    return { identity, answers, consent: document.getElementById('consent').checked };
  }

  function showErrors(errors) {
    const box = document.getElementById('form-errors');
    box.textContent = '';
    box.appendChild(el('strong', { text: 'Please check the following:' }));
    const ul = el('ul');
    for (const e of errors) ul.appendChild(el('li', { text: e }));
    box.appendChild(ul);
    box.classList.remove('hidden');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clientValidate(payload) {
    const errors = [];
    for (const f of state.form.identity.fields) {
      if (f.required && !payload.identity[f.id]) errors.push(`${f.label} is required.`);
    }
    if (payload.identity.email && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(payload.identity.email)) {
      errors.push('Please enter a valid email address.');
    }
    const role = state.form.section_b.roles[payload.identity.role];
    const qs = [
      ...state.form.section_a.questions,
      ...(role?.questions ?? []),
      ...state.form.availability.questions,
    ];
    for (const q of qs) {
      if (q.required && !payload.answers[q.id]) errors.push(`"${q.label}" is required.`);
    }
    if (!payload.consent) errors.push('Please accept the consent statement.');
    return errors;
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const payload = collect();
    const errors = clientValidate(payload);
    if (errors.length) return showErrors(errors);

    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showErrors(data.errors || [data.error || 'Something went wrong. Please try again.']);
        btn.disabled = false;
        btn.textContent = 'Submit application';
        return;
      }
      showSuccess(data);
    } catch (err) {
      showErrors(['Network error — please check your connection and try again.']);
      btn.disabled = false;
      btn.textContent = 'Submit application';
      console.error(err);
    }
  }

  function showSuccess(data) {
    const statusUrl = new URL(data.status_url, window.location.origin).href;
    document.getElementById('application-form').classList.add('hidden');
    document.getElementById('intro-card').classList.add('hidden');
    const card = document.getElementById('success-card');
    card.textContent = '';
    card.appendChild(el('h1', { text: 'Application received' }));
    card.appendChild(el('p', {
      text: 'Thank you. We have your application. Keep this private status link — it is how you will see your decision and, if you are approved, your community invitation.',
    }));
    const box = el('div', { class: 'link-box' });
    box.appendChild(el('a', { href: statusUrl, text: statusUrl }));
    card.appendChild(box);
    card.appendChild(el('p', { class: 'small muted', text: 'Bookmark it or email it to yourself now; it is not shown again automatically.' }));
    const copy = el('button', { type: 'button', text: 'Copy status link' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(statusUrl);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Select and copy the link above';
      }
    });
    card.appendChild(copy);
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  boot();
})();
