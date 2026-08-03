---
description: Design principles behind the code-cleanliness rule. Simplicity, duplication, and structure, with sources.
---

# Design Principles

This doc is pull-only. Read it when making an abstraction or structure decision, not on
every turn. The resident rule is `code-cleanliness.md`. This is where its reasoning lives,
so read it before deciding whether to extract, split, or leave something duplicated.

## Simplicity

### KISS

Keep the implementation as simple as the requirements allow. Signs of a violation, usable
as a checklist:

- An interface created before a second implementation exists.
- An abstraction layer added "just in case".
- Excessive optional parameters.
- Deeply nested conditionals.
- Needing to understand several classes to understand one component.
- More boilerplate than business logic.

Techniques: prioritize readability over machine optimization, let abstractions emerge from
real repetition, prefer composition over inheritance, keep functions to one nameable task,
use standard constructs over invented ones.

KISS can push toward duplication and away from extensibility, which puts it in direct
tension with DRY below. The resolution is the simplest sufficient code that meets all
actual requirements. Duplication is cheaper than the wrong abstraction, so when the two
pull in opposite directions, let KISS win until a third occurrence proves the abstraction
is real.

Source: https://algomaster.io/learn/lld/kiss

### YAGNI

Do not build a capability the software does not yet need to support. Fowler names four
costs a presumptive feature carries:

- **Build.** Time spent analyzing and testing something nobody uses yet.
- **Delay.** The feature users actually needed sooner ships later.
- **Carry.** The added complexity slows every other feature for the life of the codebase.
- **Repair.** By the time the feature is needed, it no longer matches how the code works.

The caveat is the load-bearing part, and most summaries drop it. Fowler: "Yagni only
applies to capabilities built into the software to support a presumptive feature, it does
not apply to effort to make the software easier to modify." Refactoring and self-testing
code are not YAGNI violations. They are what makes YAGNI safe. Skipping them is not
following YAGNI, it is inverting it.

Source: https://martinfowler.com/bliki/Yagni.html

## Duplication

### DRY

The original statement, from Hunt and Thomas: "Every piece of knowledge must have a
single, unambiguous, authoritative representation within a system." The word is
**knowledge**, not code text. Two functions that read alike but encode two independent
business rules are not a DRY violation, and merging them couples rules that should be
free to change separately.

Documented limits: premature abstraction produces rigid code, engineers stay invested in
an abstraction past the point it still fits (sunk cost), and the rule of three says
abstract once duplication has actually appeared, not in anticipation of it.

Source: https://en.wikipedia.org/wiki/Don%27t_repeat_yourself

### The rule of three

Solve it plainly the first time. Tolerate the duplication the second time. Refactor into
an abstraction on the third. An early abstraction is a guess about requirements you do not
yet know, and a guess that gets hardened into code is expensive to undo.

Sources: https://understandlegacycode.com/blog/refactoring-rule-of-three/ ·
https://www.vladimirzdrazil.com/posts/aha-principle/

### The wrong abstraction

Sandi Metz: "Duplication is far cheaper than the wrong abstraction." Her decay sequence
is worth reproducing in full because it is recognizable in a diff:

1. Someone sees duplication.
2. They extract it into a named abstraction.
3. They replace the duplicates with calls to it.
4. Time passes.
5. A new requirement is _almost_ compatible with the abstraction.
6. Someone adds a parameter and a conditional to make it fit.
7. Repeat until the abstraction is incomprehensible.
8. You inherit it.

The remedy: inline the abstraction back into each caller, work out what each caller
actually needs from the parameters it was passing, then delete the rest. Metz again:
"When the abstraction is wrong, the fastest way forward is back."

Source: https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction

## Structure

SOLID is usually stated in class terms. This kit installs into repos that may have no
classes at all, so each principle below keeps its canonical name, for greppability, and
gets a restatement at module and function level.

### SRP — Single Responsibility Principle

A module has one and only one reason to change. At function level: a function does one
job and is named for that job. Smell it prevents: a change to one concern forcing an
unrelated part of the same file or function to be re-tested.

Source: https://www.digitalocean.com/community/conceptual-articles/s-o-l-i-d-the-first-five-principles-of-object-oriented-design

### OCP — Open/Closed Principle

A module is open for extension but closed for modification. At function level: adding a
new case should mean adding code, not editing every existing branch. Smell it prevents:
an `if`/`else` or `switch` chain that grows a new branch every time a type is added.

Source: https://realpython.com/solid-principles-python/

### LSP — Liskov Substitution Principle

Anything that stands in for another implementation of the same contract must be safely
substitutable for it. At function level: two functions implementing the same interface
must accept the same inputs and honor the same failure modes. Smell it prevents: a
substitute that narrows a return type or throws where the original did not, breaking
every caller that trusted the contract.

Source: https://www.digitalocean.com/community/conceptual-articles/s-o-l-i-d-the-first-five-principles-of-object-oriented-design

### ISP — Interface Segregation Principle

No consumer should be forced to depend on parts of an interface it does not use. At
function level: a function's parameters should be exactly what it needs, not a shared
options bag built for every caller. Smell it prevents: a config object where most fields
are irrelevant to most call sites, so every caller has to know the fields it can ignore.

Source: https://realpython.com/solid-principles-python/

### DIP — Dependency Inversion Principle

Depend on abstractions, not on concrete implementations. High-level modules must not
depend on low-level ones. At function level: a function that needs a capability takes it
as a parameter or an injected dependency, rather than importing one specific
implementation directly. Smell it prevents: a core module that cannot be tested or reused
without dragging in an unrelated concrete dependency, such as a specific database client
or filesystem.

Source: https://www.digitalocean.com/community/conceptual-articles/s-o-l-i-d-the-first-five-principles-of-object-oriented-design
