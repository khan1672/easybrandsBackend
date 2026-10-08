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
    console.error('[fatal] boot failed', err);
    if (!res.headersSent) res.statusCode = 503;
    res.end(
      JSON.stringify({
        error: 'catalog_unavailable',
        message: 'The product catalogue could not be loaded. Please retry.',
      }),
    );
    return;
  }
  return app(req, res);
}