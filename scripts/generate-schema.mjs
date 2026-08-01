#!/usr/bin/env node
// Regenerates schema/kit.config.schema.json from the zod schema in src/core/config.ts.
// Run via `pnpm run schema` (build first — it reads dist/). test/config-schema.test.ts
// fails if the committed file falls out of sync.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildJsonSchema } from '../dist/core/config.js';

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
