import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Env {
  port: number;
  host: string;
  dataFile: string;
  atlas: 'auto' | 'off';
  mongoUri: string;
  mongoDb: string;
  mongoCollection: string;
  requestLog: boolean;
  /**
   * Hops in front of us that may set x-forwarded-for. Must be right behind a
   * proxy (1 on Vercel, 0 for a direct `node dist/server.js`), otherwise
   * Express reports every caller as the proxy itself and the chat rate limit
   * collapses into one shared bucket keyed by an IP nobody has.
   */
  trustProxy: number;
  /** Server-side only. Never exposed to the mobile client. */
  geminiApiKey: string;
  geminiBaseUrl: string;
  chatModel: string;
  /** Requests per window, per client, for the paid chat endpoint. */
  chatRateLimit: number;
  chatRateWindowMs: number;
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringFrom(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export default function loadEnv(): Env {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const body = fs.readFileSync(envFile, 'utf8');
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  }

  const port = Number.parseInt(stringFrom(process.env.PORT, '8787'), 10);
  const dataFile = path.resolve(
    projectRoot,
    stringFrom(process.env.DATA_FILE, '../data/raw_products.jsonl'),
  );

  // VERCEL is set by the platform, so a deploy gets the right default without
  // needing an env var configured; running locally stays direct (0).
  const trustProxyDefault = process.env.VERCEL ? 1 : 0;
  const trustProxy = Number.parseInt(stringFrom(process.env.TRUST_PROXY, String(trustProxyDefault)), 10);

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    host: stringFrom(process.env.HOST, '127.0.0.1'),
    dataFile,
    trustProxy: Number.isFinite(trustProxy) && trustProxy >= 0 ? trustProxy : 0,
    atlas: stringFrom(process.env.ATLAS, '') === 'auto' ? 'auto' : 'off',
    mongoUri: stringFrom(process.env.MONGO_URI, ''),
    mongoDb: stringFrom(process.env.MONGO_DB, 'easybrands'),
    mongoCollection: stringFrom(process.env.MONGO_COLLECTION, 'products'),
    requestLog: stringFrom(process.env.REQUEST_LOG, 'true') !== 'false',
    geminiApiKey: stringFrom(process.env.GEMINI_API_KEY, ''),
    geminiBaseUrl: stringFrom(
      process.env.GEMINI_BASE_URL,
      'https://generativelanguage.googleapis.com/v1beta',
    ),
    chatModel: stringFrom(process.env.CHAT_MODEL, 'gemini-3.8-flash'),
    chatRateLimit: positiveInt(process.env.CHAT_RATE_LIMIT, 20),
    chatRateWindowMs: positiveInt(process.env.CHAT_RATE_WINDOW_MS, 60_000),
  };
}
