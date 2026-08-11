#!/usr/bin/env node
/**
 * Regenerates schema/kit.config.schema.json from the zod schema in `@agent-kit/api/internal`.
 *
 * Usage: `pnpm run schema`. Build first, since @agent-kit/api must be built.
 * `src/core/__test__/config.test.ts` fails if the committed file falls out of sync.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildJsonSchema } from '@agent-kit/api/internal';

const target = new URL('../schema/kit.config.schema.json', import.meta.url);
const path = fileURLToPath(target);

// Formatted here so the write lands prettier-canonical and `pnpm format` is a no-op.
const options = (await resolveConfig(path)) ?? {};
const text = await format(JSON.stringify(buildJsonSchema()), {
  ...options,
  parser: 'json',
});

writeFileSync(target, text);
console.log(`Wrote ${path}`);
