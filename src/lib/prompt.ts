import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '../../prompts');

const cache = new Map<string, string>();

export function loadPrompt(filename: string): string {
  if (!cache.has(filename)) {
    cache.set(filename, readFileSync(join(PROMPTS_DIR, filename), 'utf-8'));
  }
  return cache.get(filename)!;
}
