---
paths:
  - '**/*.ts'
  - '**/*.mts'
  - '**/*.cts'
  - '**/*.tsx'
  # A Svelte component's `<script lang="ts">` block is TypeScript, and a `.svelte.ts` module
  # is TypeScript outright, so this rule applies to both. `svelte.md` defers to this file, and
  # a target that did not cover the source would leave that pointer dangling.
  - '**/*.svelte'
  - '**/*.svelte.ts'
---

# TypeScript

Assumes `strict: true`. See the [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
for anything this rule does not cover.

## Rule — follow without deliberation

### Type definitions

- **`interface` for object shapes, since they extend.** `type` for unions and computed types.

```typescript
interface ButtonOptions {
  variant: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';
```

### Never `any`

- **Never type untyped external data as `any`.** Use `unknown` and narrow with a type guard.

```typescript
// BAD
const data: any = JSON.parse(raw);

// GOOD
const data: unknown = JSON.parse(raw);
if (isPayload(data)) {
  console.log(data.name);
}
```

### Where other rules apply

- Whether a comment should exist, and what form it takes: see `code-comments.md` if that rule
  is installed.
- Naming, function size, magic values, and dead code: see `code-cleanliness.md` if that rule is
  installed.
- How the sentence inside a comment reads: see `prose-voice.md` if that rule is installed.
- Formatting and import order: the repo's own linter owns these, not this rule.
