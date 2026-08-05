---
paths:
  - '**/*.jsx'
  - '**/*.tsx'
---

# Accessibility — React

Framework-specific guidance for React and JSX. See `accessibility.md` for the rules on
semantics, names, keyboard, focus, forms, color, motion, and structure that this guide
assumes.

## Rule — follow without deliberation

- **Use `htmlFor`, not `for`, and `className`, not `class`.** JSX reserves the plain HTML
  attribute names for JavaScript keywords.
- **Keep the dashes in `aria-*` attributes.** Every other DOM attribute is camelCased in
  JSX, but `aria-*` and `data-*` pass through unchanged. Writing `ariaLabel` silently drops
  the attribute instead of erroring.
- **`key` is not focus identity.** Reordering a keyed list moves DOM nodes, and focus stays
  on the node, not the item it used to represent. Test focus behavior after a reorder, not
  just after a mount.
- **Move focus from an effect, not from render.** Focusing during render fires before the
  target node exists in the committed DOM. Set a ref, then focus it in a `useEffect` that
  runs after the relevant state change.
- **Pass `ref` to a child component as a plain prop.** React 19 dropped the `forwardRef`
  wrapper, so a parent that needs to focus a child's input declares `ref` in the child's
  props and forwards it. Do not reach for `forwardRef` in new code.
- **Wire a portal's focus trap and `aria-*` attributes explicitly.** A portal renders its
  DOM outside its parent in the tree, so nothing about the parent's markup or focus
  management carries over. A modal rendered through a portal needs both written by hand.
- **Treat `dangerouslySetInnerHTML` as unchecked.** It bypasses JSX entirely, so no linter
  or type checker inspects the markup it inserts for accessibility problems.
- **Expect focus to fall to `<body>` after a conditional unmount.** Removing a focused node
  from the tree does not move focus anywhere useful. Move it deliberately before or as part
  of the removal.
- **Do not expect a `Fragment` to carry a role or a landmark.** A fragment renders no
  element, so `role` or `aria-*` on it does nothing. Use a real element instead.
- **Install `eslint-plugin-jsx-a11y`.** It catches the mechanical half of this file, the
  missing `alt`, the redundant role, the `<div onClick>` with no keyboard handler. It does
  not catch anything needing runtime or visual judgement, such as color contrast, the actual
  tab order, or whether an `alt` string is a meaningful description.

## Examples

**Bad — HTML attribute names in JSX:**

```tsx
<label for="email">Email</label>
<input id="email" class="field" ariaLabel="Email address" />
```

**Good — JSX attribute names, dashes kept on `aria-*`:**

```tsx
<label htmlFor="email">Email</label>
<input id="email" className="field" aria-label="Email address" />
```

**Bad — focusing during render:**

```tsx
function Dialog({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  if (open) ref.current?.focus();
  return <div ref={ref} tabIndex={-1} role="dialog" />;
}
```

**Good — focusing from an effect after commit:**

```tsx
function Dialog({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  return <div ref={ref} tabIndex={-1} role="dialog" />;
}
```
