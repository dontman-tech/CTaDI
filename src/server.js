import http from 'node:http';
import { env } from './lib/config.js';
import { handleApi, serveStatic } from './routes/api.js';
import { getStore } from './store/index.js';
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
  const port = Number(env('PORT', 3000));
  const server = createServer();
  server.listen(port, async () => {
    const store = await getStore();
    console.log(`\nCTaDI onboarding portal listening on http://localhost:${port}`);
    console.log(`  storage driver : ${store.driver}`);
    console.log(`  email driver   : ${env('EMAIL_DRIVER', 'console')}`);
    console.log(`  admin email    : ${env('ADMIN_EMAIL', '(not set)')}`);
    console.log('  screening      : manual — every application is emailed to the admin\n');
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
