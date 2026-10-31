import type { Catalog } from '../db/catalog.js';
import { describeProducts, runSearchProducts, type ChatProduct } from './chatTools.js';
import { isSmallTalk, parseIntent, type ProductIntent } from './chatIntent.js';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatEvent {
  type: 'delta' | 'products' | 'done' | 'error';
  text?: string;
  products?: ChatProduct[];
  message?: string;
}

export interface ChatOptions {
  /** Server-side only. Never exposed to the mobile client. */
  apiKey: string;
  baseUrl: string;
  model: string;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are the shopping assistant for the EasyBrands catalogue of Pakistani clothing.

You will be given a shopper's message and the catalogue results that were found
for it. Write a short reply that helps them choose.

Rules:
- Only mention products present in the results. Never invent a product, brand,
  price, discount, stock status or link.
- Never state a price that is not in the results. If a price says "not
  published", say the price is unavailable rather than guessing.
- Lead with what they asked for: the price range, and which 2-4 items fit best.
- Give one or two reasons per pick that come from the product name or category.
- Mention size only as a general note; this catalogue has no reliable per-product
  size data.
- If the results are empty, say plainly that nothing matched and suggest
  relaxing the budget or the category.
- Be concise and warm: a few sentences, not an essay. Prices are PKR.`;

/** Streams a reply, resolving when the model has finished. */
export type EventSink = (event: ChatEvent) => void;

/** One part of a Gemini message. */
interface GeminiPart {
  text?: string;
  /** True when the part is the model's private reasoning, not its answer. */
  thought?: boolean;
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiChunk {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] } }[];
}

/** Gemini statuses worth retrying: capacity spikes and rate limits are routine. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const RETRYABLE_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']);

/** How long the provider may stay silent before the catalogue fallback takes over. */
const PROVIDER_DEADLINE_MS = 10_000;

/** Waits, but gives up immediately if the caller (or the deadline) aborts. */
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

interface Deadline {
  signal: AbortSignal;
  clear: () => void;
}

/**
 * An abort signal that fires after `ms`, forwarding the caller's cancellation.
 *
 * Gemini normally answers in a second or two. When it instead accepts the
 * connection and then says nothing, this is what turns the wait into the
 * catalogue fallback rather than a bubble that never resolves.
 */
function createDeadline(parent: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The provider timed out.', 'TimeoutError')),
    ms,
  );
  const forward = (): void => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) forward();
    else parent.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', forward);
    },
  };
}

/**
 * Opens the stream, retrying the statuses Gemini returns while it is busy.
 *
 * Gemini rejects a large share of requests with 429 or 503 under real traffic
 * ("this model is currently experiencing high demand"). Without this a shopper
 * just sees the assistant fail, so a few patient attempts are made before giving
 * up. Retries stop as soon as the client disconnects.
 */
async function fetchWithBackoff(
  url: string,
  body: string,
  options: ChatOptions,
  signal: AbortSignal,
): Promise<Response> {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    let response: Response | null = null;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': options.apiKey,
        },
        body,
        signal,
      });
    } catch (error) {
      lastError = error;
      // Cancellation (the shopper leaving, or the deadline above) is final.
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError' || signal.aborted) throw error;
      if (!RETRYABLE_ERRORS.has((error as { code?: string }).code ?? '')) throw error;
    }

    if (response) {
      if (response.ok) return response;
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === maxAttempts) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Chat provider error ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        );
      }
    }

    // Exponential backoff, ~0.4s / 0.8s / 1.6s, plus jitter to avoid a stampede.
    const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await wait(delay, signal);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Chat provider is busy. Please try again.');
}

/**
 * Asks Gemini to word up results the catalogue already returned.
 *
 * There are no tools here and no second turn: the products are found locally and
 * pasted into the prompt, so the model has one job, which is writing. That is
 * both cheaper and far more predictable than a tool-calling loop, and it removes
 * the failure mode where a thinking model spends its budget and returns nothing.
 */
async function writeReply(
  options: ChatOptions,
  intent: ProductIntent,
  question: string,
  products: ChatProduct[],
  onDelta: (text: string) => void,
): Promise<string> {
  const url = `${options.baseUrl}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              `Shopper's message: ${question}`,
              '',
              intent.priceHint ? `Budget the shopper asked for: ${intent.priceHint}` : '',
              intent.brandHint ? `Brand requested: ${intent.brandHint}` : '',
              intent.categoryHint ? `Category the request fell into: ${intent.categoryHint}` : '',
              '',
              `Catalogue results (${products.length}):`,
              describeProducts(products),
              '',
              'Write the reply now.',
            ]
              .filter(line => line !== '')
              .join('\n'),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      // Deliberately no hidden deliberation. This flow is a catalogue lookup:
      // the wording is already decided, so thinking only adds latency and can
      // spend the budget without producing a reply at all.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const deadline = createDeadline(options.signal, PROVIDER_DEADLINE_MS);

  try {
    const response = await fetchWithBackoff(url, body, options, deadline.signal);
    if (!response.body) {
      throw new Error('Chat provider returned an empty response');
    }

    let text = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed: GeminiChunk;
        try {
          parsed = JSON.parse(payload) as GeminiChunk;
        } catch {
          continue;
        }

        for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
          // `thought` parts are the model's private reasoning and never reach the
          // shopper, or the app renders the monologue.
          if (typeof part.text === 'string' && part.text !== '' && part.thought !== true) {
            if (!started) {
              // The model is answering: the rest of the stream may take as long
              // as it needs.
              started = true;
              deadline.clear();
            }
            text += part.text;
            onDelta(part.text);
          }
        }
      }
    }

    return text;
  } finally {
    deadline.clear();
  }
}

/** Replies that need no catalogue and no model. */
function cannedReply(question: string): string | null {
  const lower = question.trim().toLowerCase();
  if (/^(hi|hey|hello|salaam|assalam|salam)\b/.test(lower)) {
    return 'Hello! Tell me what you are looking for, a budget, or an occasion, and I will pull the matching pieces from the catalogue.';
  }
  if (/^(thanks|thank you|thx|ok|okay|cool|great|bye|goodbye)\b/.test(lower)) {
    return 'Happy to help. Ask me for anything else you are looking for.';
  }
  return null;
}

/**
 * A factual reply that needs no model.
 *
 * The cards are emitted before the model is called, so a provider outage (quota,
 * 429, 5xx) or an empty completion must not turn into an error bubble: the
 * shopper still has the products and this line explains them.
 */
function fallbackReply(products: ChatProduct[], providerFailed: boolean): string {
  const lead = providerFailed ? 'The stylist is busy right now. ' : '';
  if (products.length === 0) {
    return `${lead}I could not find anything matching that in the catalogue. Try widening the budget or the category.`;
  }
  const first = products[0];
  const price =
    first && typeof first.price === 'number' ? `PKR ${first.price}` : 'an unpublished price';
  const title = [first?.brand, first?.name].filter(part => part && part !== '').join(' ');
  const others = products.length - 1;
  return `${lead}${title} at ${price}.${
    others > 0 ? ` Plus ${others} more matching ${others === 1 ? 'piece' : 'pieces'}.` : ''
  } Tap a card for the details.`;
}

/**
 * Answers a shopper, searching the catalogue locally first.
 *
 * The order matters and is the whole point of the design: understand the request
 * without a model, find the products without a model, and only then call Gemini
 * to phrase the answer. A greeting costs nothing and a product question costs one
 * model call instead of a tool-calling round trip.
 */
export async function runChat(
  catalog: Catalog,
  history: ChatMessage[],
  options: ChatOptions,
  emit: EventSink,
): Promise<void> {
  const trimmed = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => m.content.trim() !== '')
    .slice(-10);

  if (trimmed.length === 0) {
    emit({ type: 'error', message: 'empty conversation' });
    return;
  }

  // The newest shopper message is what this turn answers.
  const question = [...trimmed].reverse().find(m => m.role === 'user')?.content ?? '';

  try {
    // Checked before any work: once the client has gone there is nothing to
    // answer, and searching on would spend time and money for nobody.
    if (options.signal?.aborted) {
      emit({ type: 'error', message: 'cancelled' });
      return;
    }

    if (isSmallTalk(question)) {
      const canned = cannedReply(question);
      if (canned) {
        emit({ type: 'delta', text: canned });
        emit({ type: 'done' });
        return;
      }
    }

    const intent = parseIntent(question);
    const products = await runSearchProducts(catalog, intent.args);

    // Cards go out before the text so the shopper sees something immediately.
    const seen = new Set<string>();
    for (const product of products) {
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      emit({ type: 'products', products: [product] });
    }

    let streamed = false;
    let reply: string;
    try {
      reply = await writeReply(options, intent, question, products, text => {
        streamed = true;
        emit({ type: 'delta', text });
      });
    } catch (error) {
      // A cancellation is the user's own doing; the outer handler reports it.
      if ((error as { name?: string }).name === 'AbortError') throw error;
      console.warn(
        '[chat] provider unavailable; sending catalogue fallback:',
        (error as Error).message,
      );
      // If some text already reached the shopper, keep it; otherwise explain
      // the cards that are already on screen instead of showing an error.
      if (!streamed) emit({ type: 'delta', text: fallbackReply(products, true) });
      emit({ type: 'done' });
      return;
    }

    if (reply.trim() === '') {
      // Fall back to a factual summary rather than an empty bubble: the products
      // are already on screen, so the shopper is not left guessing.
      emit({ type: 'delta', text: fallbackReply(products, false) });
    }

    emit({ type: 'done' });
  } catch (error) {
    const message =
      (error as { name?: string }).name === 'AbortError'
        ? 'cancelled'
        : (error as Error).message || 'Chat failed';
    emit({ type: 'error', message });
  }
}

export { SYSTEM_PROMPT };
export default { runChat };