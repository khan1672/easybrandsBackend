/**
 * Vercel serverless entry point.
 *
 * Plain JavaScript on purpose: this file is shipped as-is and imports the
 * compiled output of `npm run build`, so Vercel never has to compile the API
 * layer itself. `"type": "module"` in package.json makes this ESM.
 *
 * Everything Express needs from `node:http` is structurally the same as the
 * Vercel request/response pair, so the app is handed straight to the handler.
 */
import { getApp } from '../dist/handler.js';

let pending = null;

export default async function handler(req, res) {
  pending ??= getApp();
  let app;
  try {
    app = await pending;
  } catch (err) {
    pending = null;
    // Full detail (host names, driver message, cause) goes to the function log.
    // The response gets only a coarse code, which is what makes a bare 503
    // diagnosable without reading logs.
    console.error('[fatal] boot failed', err, err?.cause ?? '(no cause)');
    const code =
      typeof err?.code === 'string' && err.code.length > 0 ? err.code : 'boot_failed';
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(
      JSON.stringify({
        error: 'catalog_unavailable',
        code,
        message: 'The product catalogue could not be loaded. Please retry.',
      }),
    );
    return;
  }
  return app(req, res);
}