import type { Request, Response } from 'express';
import type { Catalog } from '../db/catalog.js';
import type { ChatMessage } from '../services/chat.service.js';
import { runChat, type ChatEvent } from '../services/chat.service.js';
import type { Env } from '../config/env.js';

const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY = 20;

function parseMessages(body: unknown): ChatMessage[] | null {
  if (!body || typeof body !== 'object') return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  const parsed: ChatMessage[] = [];
  for (const entry of messages.slice(-MAX_HISTORY)) {
    if (!entry || typeof entry !== 'object') continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (trimmed === '') continue;
    parsed.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS) });
  }
  return parsed;
}

export function chat(env: Env, catalog: Catalog) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!env.geminiApiKey) {
      res.status(503).json({
        error: 'Chat is not configured. Set GEMINI_API_KEY on the API server.',
        code: 'chat_not_configured',
      });
      return;
    }

    const messages = parseMessages(req.body);
    if (!messages || messages.length === 0) {
      res.status(400).json({ error: 'messages must be a non-empty array' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat streaming entirely.
      'x-accel-buffering': 'no',
    });

    const emit = (event: ChatEvent): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Stop generating as soon as the client goes away, so an abandoned reply
    // does not keep billing. Listen on the response, not the request: the
    // request emits "close" as soon as express.json() has drained the body.
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      await runChat(
        catalog,
        messages,
        {
          apiKey: env.geminiApiKey,
          baseUrl: env.geminiBaseUrl,
          model: env.chatModel,
          signal: controller.signal,
        },
        emit,
      );
    } finally {
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  };
}

export default { chat };
