import http from 'node:http';
import { loadConfig, env } from './lib/config.js';
import { handleApi, serveStatic } from './routes/api.js';
import { getStore } from './store/index.js';
import { providerChain } from './llm/providers.js';
import { sendHtml, sendText } from './lib/http.js';

/** Pages rendered server-side so there is no build step and no framework. */
function statusPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CTaDI — application status</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap narrow">
  <header class="brand"><a href="/">CTaDI</a></header>
  <section id="status-card" class="card" aria-live="polite">
    <p class="muted">Looking up your application…</p>
  </section>
  <p class="muted small">Bookmark this page — it is how you will see your status and, if approved, your community link.</p>
</main>
<script src="/status.js"></script></body></html>`;
}

function decisionPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CTaDI — review decision</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap narrow">
  <header class="brand"><a href="/">CTaDI</a></header>
  <section id="decision-card" class="card" aria-live="polite">
    <p class="muted">Recording your decision…</p>
  </section>
</main>
<script src="/decision.js"></script></body></html>`;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (handled !== false) return;
        return sendText(res, 404, 'Not found');
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return sendHtml(res, 200, statusPage());
      }
      if (req.method === 'GET' && url.pathname === '/decision') {
        return sendHtml(res, 200, decisionPage());
      }

      if (req.method === 'GET' && serveStatic(req, res, url)) return;
      return sendText(res, 404, 'Not found');
    } catch (err) {
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
      else res.end();
    }
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cfg = loadConfig();
  const port = Number(env('PORT', 3000));
  const server = createServer();
  server.listen(port, () => {
    const providers = providerChain();
    console.log(`\nCTaDI onboarding portal listening on http://localhost:${port}`);
    console.log(`  storage driver : ${getStore().driver}`);
    console.log(`  email driver   : ${env('EMAIL_DRIVER', 'console')}`);
    console.log(`  threshold      : ${cfg.scoring.shortlist_threshold}`);
    const chain = providers.length
      ? providers.map((p) => `${p.name}(${p.model})`).join(' -> ')
      : 'NONE CONFIGURED — set GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY';
    console.log(`  llm providers  : ${chain}`);
    console.log(`  admin email    : ${env('ADMIN_EMAIL', '(not set)')}\n`);
  });
  const shutdown = () => {
    server.close(async () => {
      await getStore().close?.();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
