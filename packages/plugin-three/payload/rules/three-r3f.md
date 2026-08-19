---
paths:
  - '**/three/**/*.tsx'
  - '**/three/**/*.jsx'
---

# Three.js — React Three Fiber

Assumes `three.md`. This is the React binding residue only, not a restatement of the base rule.

## Handing an object to the scene graph

Use `<primitive object={obj} />` to hand a pre-built object from the pure Three.js layer to the
scene graph, the React equivalent of Threlte's `<T is={obj} />`:

```tsx
<primitive object={obj} />
```

An object the pure layer built stays that object. React places it, it does not recreate it.

## Frame loop and renderer access

Use `useFrame` for a per-frame callback, and `useThree` to reach the renderer, camera, or scene:

```tsx
function Scene() {
  const { camera, gl } = useThree();

  useFrame((state, delta) => {
    // ...
  });

  return null;
}
```

## Memoize geometry and material

Build geometry and material with `useMemo`, keyed on the inputs that should trigger a rebuild.
Without it, a re-render allocates new GPU resources on every pass:

```tsx
const geometry = useMemo(() => new BufferGeometry(), []);
```

## Dispose what you allocate

`useMemo`-built geometry and material are not disposed automatically. Dispose them in a cleanup
effect when the component unmounts:

```tsx
useEffect(() => {
  return () => {
    geometry.dispose();
    material.dispose();
  };
}, [geometry, material]);
```
