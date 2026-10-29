import http from 'node:http';
import { loadConfig, env } from './lib/config.js';
import { handleApi, serveStatic } from './routes/api.js';
import { getStore } from './store/index.js';
import { providerChain } from './llm/providers.js';
import { sendText } from './lib/http.js';

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (handled !== false) return;
        return sendText(res, 404, 'Not found');
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
  server.listen(port, async () => {
    const providers = providerChain();
    const store = await getStore();
    console.log(`\nCTaDI onboarding portal listening on http://localhost:${port}`);
    console.log(`  storage driver : ${store.driver}`);
    console.log(`  email driver   : ${env('EMAIL_DRIVER', 'console')}`);
    console.log(`  threshold      : ${cfg.scoring.shortlist_threshold}`);
    const chain = providers.length
      ? providers.map((p) => `${p.name}(${p.model})`).join(' -> ')
      : 'NONE CONFIGURED — set DEEPSEEK_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY)';
    console.log(`  llm providers  : ${chain}`);
    console.log(`  admin email    : ${env('ADMIN_EMAIL', '(not set)')}\n`);
  });
  const shutdown = () => {
    server.close(async () => {
      const store = await getStore();
      await store.close?.();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
