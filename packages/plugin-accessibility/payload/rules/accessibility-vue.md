---
paths:
  - '**/*.vue'
---

# Accessibility — Vue

Vue-specific residue on top of `accessibility.md`, which this guide assumes. It covers only
what Vue's templating and reactivity change about the accessibility tree.

## Rule — follow without deliberation

- **`v-if` removes the element, `v-show` hides it and keeps it.** `v-if` drops the node from
  the DOM, so a screen reader stops seeing it and focus that was on it falls back to
  `<body>`. `v-show` sets `display: none`, which also hides the node from assistive
  technology but leaves it mounted. Picking the wrong one produces a control that is
  invisible but still focusable, or focus that disappears mid-interaction.
- **Move focus yourself after a Vue Router navigation.** A route change does not move focus
  or announce anything on its own, so the screen reader stays silent unless the new view's
  heading or main region is focused deliberately.
- **`v-html` bypasses accessibility checking entirely.** The injected markup skips both
  Vue's templating and any static analysis, so name decisions and semantics inside it are
  unverified.
- **Wait for `nextTick` before moving focus, and reach the element with `useTemplateRef`.**
  The DOM has not caught up with a reactive change yet when the handler runs, so focusing
  immediately can target a stale or unmounted element.
- **A bound `false` still renders the attribute.** `:aria-hidden="false"` prints
  `aria-hidden="false"` in the DOM, which is not the same as omitting the attribute. Omit
  the binding, or bind the whole attribute conditionally, when you mean "not set."
- **`<template>` renders no element and cannot carry a role.** A landmark or `role` attribute
  placed on a `<template>` wrapper is dropped, since only its children reach the DOM.
- **A teleported element carries no accessibility wiring with it.** `<Teleport to="body">`
  moves the node elsewhere in the tree, so a modal needs its focus trap and `aria-*` set on
  the element itself.
- **A scoped slot or dynamic component can change what element renders.** A role assumed at
  the call site does not survive if the slot content or `<component :is>` swaps it out.
- **Install `eslint-plugin-vuejs-accessibility`.** It catches missing labels, invalid ARIA
  attributes, and interactive elements without keyboard handlers in templates. It does not
  catch contrast, focus order, or whether alt text is meaningful, so those still need a
  manual pass.

## Examples

**Bad — `v-show` hides a dialog but leaves it in the tab order:**

```vue
<template>
  <div v-show="open" role="dialog" aria-modal="true">
    <button @click="open = false">Close</button>
  </div>
</template>
```

**Good — `v-if` removes it from the tree and from the tab order when closed:**

```vue
<template>
  <div v-if="open" role="dialog" aria-modal="true">
    <button @click="open = false">Close</button>
  </div>
</template>
```

**Bad — focus called before the DOM updates:**

```vue
<script setup>
import { ref, useTemplateRef } from 'vue';

const show = ref(false);
const input = useTemplateRef('input');

function reveal() {
  show.value = true;
  input.value.focus();
}
</script>
```

**Good — `nextTick` waits for the element to exist:**

```vue
<script setup>
import { nextTick, ref, useTemplateRef } from 'vue';

const show = ref(false);
const input = useTemplateRef('input');

async function reveal() {
  show.value = true;
  await nextTick();
  input.value?.focus();
}
</script>
```
