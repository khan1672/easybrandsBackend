import { readFile } from 'node:fs/promises';
import type { ProductDoc } from '../types.js';

export interface JsonlResult {
  docs: ProductDoc[];
  lines: number;
  bad: number;
}

export async function loadJsonl(filePath: string): Promise<ProductDoc[]> {
  const out = await loadJsonlLines(filePath);
  return out.docs;
}

export async function loadJsonlLines(filePath: string): Promise<JsonlResult> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const docs: ProductDoc[] = [];
  let bad = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!.trim();
    if (!line) continue;
    try {
      docs.push(JSON.parse(line) as ProductDoc);
    } catch (err) {
      bad += 1;
      if (bad <= 3) console.error(`[jsonl] line ${idx + 1} — ${(err as Error).message}`);
    }
  }
  return { docs, lines: lines.length, bad };
}

export default loadJsonl;
