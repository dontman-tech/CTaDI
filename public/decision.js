/* Decision page: takes the ?token= from the admin email and posts it.
   The page never sees the decision itself — the token carries it and is
   verified server-side, so an edited URL cannot change the outcome. */
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';
  const card = document.getElementById('decision-card');

  function render(heading, message, cls) {
    card.textContent = '';
    const h = document.createElement('h1');
    h.textContent = heading;
    card.appendChild(h);
    const p = document.createElement('p');
    p.textContent = message;
    card.appendChild(p);
    if (cls) {
      const n = document.createElement('div');
      n.className = `notice ${cls}`;
      n.textContent = message;
      card.textContent = '';
      card.appendChild(h);
      card.appendChild(n);
    }
    const home = document.createElement('a');
    home.className = 'btn';
    home.href = '/';
    home.textContent = 'Back to the portal';
    card.appendChild(home);
  }

  if (!token) {
    render('Review link', 'This link is missing its review token. Please use the buttons in the email you received.');
    return;
  }

  fetch('/api/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        render('Could not record the decision', data.error || 'The link may have expired. Open the admin dashboard to review this application.', 'error');
        return;
      }
      if (data.decision === 'approved') {
        render(
          'Approved',
          data.already_decided
            ? 'This application was already approved. The applicant can see the community link on their status page.'
            : 'The application has been approved. The applicant can now see the community link on their status page.',
          'ok',
        );
      } else {
        render(
          'Rejected',
          data.already_decided
            ? 'This application had already been rejected.'
            : 'The application has been rejected. The applicant will see a polite closing message on their status page.',
          'ok',
        );
      }
    })
    .catch(() => render('Network error', 'We could not reach the server. Please try the link again.', 'error'));
})();
