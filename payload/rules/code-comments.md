---
paths:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.mts'
  - '**/*.js'
  - '**/*.jsx'
  - '**/*.mjs'
  - '**/*.cjs'
  - '**/*.svelte'
  - '**/*.svelte.ts'
  - '**/*.svelte.js'
---

# Code Comments

These principles are language-agnostic. They hold for every language in the repo, and the examples
below are illustrative rather than language-specific. This rule decides **whether** a comment should
exist. For how the sentence inside it should read, see `prose-voice.md` if that rule is installed.

## Rule — follow without deliberation

- **Default to no comment.** Self-explanatory code does not need narration. If a reader can
  understand the intent by reading the code, do not add a comment.
- **Only comment for two reasons:**
  1. **Divergence from convention.** The code intentionally departs from the repo's normal patterns,
     a language idiom, or an obvious implementation. Explain _why_ the divergence is necessary, such
     as a bug workaround, a perf constraint, an external API quirk, or a reactivity requirement.
  2. **Non-obvious domain logic.** The code encodes a business rule, invariant, or domain concept
     that a new reader would not infer from the code itself. Briefly catalog the rule so future
     readers can find and trust it.
- **Hard cap: 200 characters per comment.** If you cannot explain it in 200 characters, the comment
  is documenting too much. Split it, link to a doc or ticket, or rewrite the code to be clearer.
- **Never narrate the code.** No `// increment counter`, `// loop over users`, `// return result`,
  `// import the package`, `// handle error`. These are noise.
- **Never explain the change you just made.** Comments describe the code as it exists, not its diff
  history. Rationale for a change belongs in the commit message or PR description.
- **Prefer naming over commenting.** If a comment is needed to explain what a variable, function, or
  block does, first try renaming it or extracting a function with a descriptive name.

## Examples

**Bad — narrating obvious code:**

```ts
// Get the user from the store
const user = userStore.get();
if (!user) {
  // Return early
  return;
}

// Loop over the parts
for (const part of parts) {
  // Add it to the result
  result.push(part);
}
```

**Bad — explaining the change instead of the code:**

```ts
// Switched to structuredClone because the old spread didn't deep-copy
const copy = structuredClone(config);
```

**Good — divergence from convention, with the reason:**

```ts
// $state.raw: this buffer is replaced wholesale each frame. Deep reactivity would tank render perf.
let points = $state.raw(new Float32Array());
```

**Good — cataloging non-obvious domain logic:**

```ts
// Resource names are case-insensitive but must round-trip with their original
// casing, so we key by the original and compare lowercased.
const key = name.toLowerCase();
```

**Good — no comment needed, the name carries the meaning:**

```ts
const activeParts = filterActiveParts(robot.parts);
```
