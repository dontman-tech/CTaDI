/* Status page: looks up an application by id and renders its state. */
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') ?? '';
  const card = document.getElementById('status-card');

  function render(node) {
    card.textContent = '';
    card.appendChild(node);
  }

  function h1(text) {
    const e = document.createElement('h1');
    e.textContent = text;
    return e;
  }
  function p(text, cls) {
    const e = document.createElement('p');
    e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  if (!id) {
    render(p('No application id was provided. Please use the private status link you received when you applied.'));
    return;
  }

  fetch(`/api/status?id=${encodeURIComponent(id)}`)
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        render(p(data.error || 'We could not find that application.'));
        return;
      }
      const s = data.status;
      const frag = document.createDocumentFragment();
      frag.appendChild(h1(s.heading));
      frag.appendChild(p(s.message));
      if (s.state === 'approved' && s.community_link) {
        const box = document.createElement('div');
        box.className = 'link-box';
        const a = document.createElement('a');
        a.href = s.community_link;
        a.textContent = s.community_link;
        box.appendChild(a);
        frag.appendChild(box);
        const btn = document.createElement('a');
        btn.className = 'btn';
        btn.href = s.community_link;
        btn.textContent = 'Join the CTaDI community';
        frag.appendChild(btn);
      }
      const meta = p(`Role: ${s.role_label} · submitted ${new Date(s.submitted_at).toLocaleString()}`, 'small muted');
      frag.appendChild(meta);
      render(frag);
    })
    .catch(() => render(p('Network error — please try again.')));
})();
