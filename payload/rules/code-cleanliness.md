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

# Code Cleanliness

This rule decides how the code you write reads: naming, function size, magic values, and
dead code. The principles are language-agnostic. The examples are TypeScript. Deeper
design and structure principles, such as when to introduce an abstraction, live in the
reference doc linked below.

## Rule — follow without deliberation

### Naming

- **Prefer intention-revealing names over short ones.** A name should say what a thing is
  or does, not save keystrokes. No single letters outside a tight loop index.
- **Spell out abbreviations.** An unexplained abbreviation forces every future reader to
  guess what it stands for.
- **Name booleans as predicates.** `isActive`, `hasProduct`, not `active` or `productFlag`.
  A predicate name reads correctly at the call site: `if (isActive)`.
- **Constants are `SCREAMING_SNAKE`, types are `PascalCase`.** These casings are the
  convention readers scan by, so breaking them costs a re-read.
- **Generics get a descriptive `T`-prefixed name, never a bare `T`.** `TRequest`, not `T`.
  A bare letter carries no meaning once a generic function has more than one type
  parameter.
- **Write acronyms as words.** `generateUserUrl`, not `generateUserURL`. Mixed-case
  acronyms break camelCase parsing at a glance.
- **If a comment is needed to explain a name, rename instead.** A name that needs a
  footnote is the wrong name.

### Function size

- **One function, one nameable task.** If you cannot name what a function does in a short
  phrase without "and", it is doing more than one thing.
- **Target under 20 to 30 lines.** Past that a function usually mixes levels of
  abstraction, which is what makes it slow to read.
- **Prefer early return over nested conditionals.** Nesting is what makes a function
  expensive to read, since the reader has to hold every enclosing condition in mind at
  once.
- **Prefer required parameters over optional ones.** A function that takes a bag of
  optional flags is usually two functions, or a discriminated union that makes the valid
  combinations explicit.

### Magic values

- **No unexplained literal in an expression.** A reader hitting `if (retries > 4)` has to
  guess whether 4 is a limit or a typo. Name it, or put it in an `as const` table.
- **Loop bounds and array indices of 0 and 1 are exempt.** `arr[0]`, `i < arr.length`, and
  `for (let i = 0; ...)` are idiomatic and naming them adds noise instead of clarity.

### Dead and speculative code

- **Delete unused exports.** An export nothing imports is dead weight a future reader has
  to rule out as unused before trusting it is unused.
- **Delete unreachable branches.** A branch nothing can hit is a lie about the code's
  behavior.
- **Delete speculative handling for cases the product does not have.** It adds a path to
  test and reason about for no behavior anyone needs. Version control remembers it.

### Where other rules apply

- Whether and how to comment: see `code-comments.md`.
- Formatting and import order: the repo's own linter owns these, not this rule.
- Deeper design principles, such as when duplication should become an abstraction: see
  `../reference/design-principles.md`.

## Examples

**Bad — cryptic name and unexplained abbreviation:**

```ts
function calc(u: User, t: number): number {
  return u.bal - t;
}
```

**Good — intention-revealing names:**

```ts
function calculateRemainingBalance(user: User, withdrawal: number): number {
  return user.balance - withdrawal;
}
```

**Bad — one function doing three things, nested three deep:**

```ts
function processOrder(order: Order) {
  if (order.items.length > 0) {
    if (order.customer) {
      if (order.customer.isVerified) {
        // charge, update inventory, send confirmation email, all inline
      }
    }
  }
}
```

**Good — early return, extracted steps:**

```ts
function processOrder(order: Order) {
  if (order.items.length === 0) return;
  if (!order.customer?.isVerified) return;

  chargeCustomer(order);
  updateInventory(order);
  sendConfirmationEmail(order);
}
```

**Bad — magic values with no explanation:**

```ts
if (retryCount > 4) {
  throw new Error('Too many retries');
}
```

**Good — named constant:**

```ts
const MAX_RETRIES = 4;

if (retryCount > MAX_RETRIES) {
  throw new Error('Too many retries');
}
```

**Bad — dead branch for a case the product does not have:**

```ts
function formatCurrency(amount: number, currency: 'USD' | 'EUR') {
  if (currency === 'USD') return `$${amount}`;
  if (currency === 'EUR') return `€${amount}`;
  // GBP support was never added, but this branch was left "just in case"
  return `£${amount}`;
}
```

**Good — deleted, matching the actual union:**

```ts
function formatCurrency(amount: number, currency: 'USD' | 'EUR') {
  if (currency === 'USD') return `$${amount}`;
  return `€${amount}`;
}
```

</content>
