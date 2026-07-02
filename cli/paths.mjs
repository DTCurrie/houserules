// Where the kit's own files live (claude-kit CLI).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function payloadPath(...segments) {
  return join(KIT_ROOT, 'payload', ...segments);
}
