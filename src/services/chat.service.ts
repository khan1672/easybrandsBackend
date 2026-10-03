import type { Catalog } from '../db/catalog.js';
import { chatTools, describeProducts, runSearchProducts, type ChatProduct } from './chatTools.js';

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
  apiKey: string;
  baseUrl: string;
  model: string;
  maxToolSteps: number;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are the shopping assistant for the EasyBrands catalogue of Pakistani clothing.

Ground every claim in the catalogue:
- Call search_products before naming any product, price, brand or stock status.
- Only ever mention products that appeared in a search_products result. Never
  invent a product, brand, price, discount, URL or availability.
- If a search returns nothing, say so plainly and offer to relax a filter.
- If a price is "not published", say the price is unavailable rather than
  guessing. Never convert an unavailable price to zero.

How to help:
- Read demand from what the shopper actually asked for: occasion, weather,
  budget, colour, style, formality. Infer the category and filters from it.
- Recommend a short, specific shortlist (3-6 items) and say briefly why each
  one fits their request.
- Give a real price range from the results, in PKR.
- Mention size guidance only as a general note; this catalogue has no reliable
  per-product size data.

Be concise and warm. Use plain sentences, not bullet-point essays. Prices are
Pakistani Rupees (PKR).`;

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/** Streams a reply, resolving when the model has finished. */
export type EventSink = (event: ChatEvent) => void;

interface StreamedChoice {
  contentDeltas: string[];
  toolCalls: ToolCallAccumulator[];
}

/**
 * Calls the chat completions API with streaming enabled and forwards text
 * deltas to the client as they arrive.
 *
 * A tool call is assembled from its streamed fragments and executed against the
 * catalogue; the result is appended to the conversation and the model is called
 * again. Looping is bounded by `maxToolSteps` so a confused model cannot spend
 * unbounded money on one message.
 */
async function streamOnce(
  options: ChatOptions,
  messages: unknown[],
  onDelta: (text: string) => void,
): Promise<StreamedChoice> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      tools: chatTools,
      tool_choice: 'auto',
      temperature: 0.4,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Chat provider error ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  const contentDeltas: string[] = [];
  const toolCalls: ToolCallAccumulator[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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

      let parsed: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content !== '') {
        contentDeltas.push(delta.content);
        onDelta(delta.content);
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = (toolCalls[index] ??= { id: '', name: '', args: '' });
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
      }
    }
  }

  return { contentDeltas, toolCalls: toolCalls.filter(Boolean) };
}

/**
 * Runs the full turn: model, tool calls, and a final grounded answer.
 *
 * Every product the client receives comes from `search_products` rather than
 * from the model's text, so the cards shown are always real catalogue rows.
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

  const messages: unknown[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmed.map(m => ({ role: m.role, content: m.content })),
  ];

  const seen = new Set<string>();

  try {
    for (let step = 0; step < options.maxToolSteps; step += 1) {
      const streamed = await streamOnce(options, messages, text =>
        emit({ type: 'delta', text }),
      );

      if (streamed.toolCalls.length === 0) {
        emit({ type: 'done' });
        return;
      }

      messages.push({
        role: 'assistant',
        content: streamed.contentDeltas.join('') || null,
        tool_calls: streamed.toolCalls.map((call, index) => ({
          id: call.id || `call_${step}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: call.args || '{}' },
        })),
      });

      for (const call of streamed.toolCalls) {
        if (call.name !== 'search_products') {
          messages.push({
            role: 'tool',
            tool_call_id: call.id || `call_${step}`,
            content: `Unknown tool: ${call.name}`,
          });
          continue;
        }

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.args || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }

        const products = await runSearchProducts(catalog, args);
        const id = call.id || `call_${step}`;
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: describeProducts(products),
        });

        // Send each product to the client once, for the suggestion cards.
        for (const product of products) {
          if (seen.has(product.id)) continue;
          seen.add(product.id);
          emit({ type: 'products', products: [product] });
        }
      }
    }

    // Budget spent: close the turn rather than looping again.
    emit({
      type: 'error',
      message: 'The assistant took too many lookups for that request. Try a narrower question.',
    });
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
