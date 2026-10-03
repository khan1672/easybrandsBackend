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
  /** Server-side only. Never exposed to the mobile client. */
  openaiApiKey: string;
  openaiBaseUrl: string;
  chatModel: string;
  /** Upper bound on tool round-trips per reply, so a loop cannot run away. */
  chatMaxToolSteps: number;
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

  return {
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    host: stringFrom(process.env.HOST, '127.0.0.1'),
    dataFile,
    atlas: stringFrom(process.env.ATLAS, '') === 'auto' ? 'auto' : 'off',
    mongoUri: stringFrom(process.env.MONGO_URI, ''),
    mongoDb: stringFrom(process.env.MONGO_DB, 'easybrands'),
    mongoCollection: stringFrom(process.env.MONGO_COLLECTION, 'products'),
    requestLog: stringFrom(process.env.REQUEST_LOG, 'true') !== 'false',
    openaiApiKey: stringFrom(process.env.OPENAI_API_KEY, ''),
    openaiBaseUrl: stringFrom(process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    chatModel: stringFrom(process.env.CHAT_MODEL, 'gpt-4o-mini'),
    chatMaxToolSteps: positiveInt(process.env.CHAT_MAX_TOOL_STEPS, 4),
    chatRateLimit: positiveInt(process.env.CHAT_RATE_LIMIT, 20),
    chatRateWindowMs: positiveInt(process.env.CHAT_RATE_WINDOW_MS, 60_000),
  };
}
