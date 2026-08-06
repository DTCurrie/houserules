# Renderer Performance Reference

Techniques for keeping a Three.js scene inside its frame budget. This assumes the extension
patterns in `three.md` and adds the numbers and mechanisms behind why they matter.

## Compressed textures: the real KTX2 win

KTX2 with Basis Universal is not a free upload. Loading a KTX2 texture **transcodes** it at
load time to a GPU-native format: BC on desktop, ASTC or ETC2 on mobile. That transcode step
runs on load and is fast, but it is a real CPU-side step.

The win is what happens after the transcode. The texture **stays compressed in VRAM**,
typically **4x to 8x less texture memory** than an uncompressed equivalent. A PNG or JPG
texture, by contrast, ends up fully uncompressed in VRAM once the GPU unpacks it. On a scene
with many large textures, that memory difference is what keeps you off the mobile GPU's
texture-memory ceiling. three.js ships a KTX2 loader for this format.

## Stop allocating inside the frame loop

Creating a `Vector3`, `Matrix4`, `Color`, or any other object inside `requestAnimationFrame`
or an update tick produces garbage. The collector reclaims it eventually, but the pause shows
up as a stutter, not as a slower average frame time. That makes it harder to spot in a
profiler that only reports averages.

Hoist every temporary you use in a hot path to module scope and mutate it in place, the same
pattern `three.md` already shows for `Vector3` and `Object3D`. Apply it to anything created
inside a loop that runs every frame, not only to vectors.

## Fewer, larger draw calls

Each draw call is a separate submission from the CPU to the GPU, and the CPU-side overhead
per call adds up long before the GPU itself is the bottleneck. Reduce the count in two ways.

Use `InstancedMesh` when many objects share one geometry and one material, and `BatchedMesh`
when they share a material but not a geometry. Merge static geometry that shares a material
so it draws in one call instead of many. The mechanism is real, fewer submissions per frame,
but no verified multiplier exists for the speedup, so treat any number you see attached to
"instancing" or "batching" as unverified until you measure it in your own scene.

## Move work off the main thread

The main thread is not just your render loop. It is shared with the DOM, the UI layer, and
input handling, so anything you move off it buys back input responsiveness as well as frame
rate.

`OffscreenCanvas` lets you render on a worker thread and is safe to recommend today, at
roughly **95% global support** (Chrome 69+, Edge 79+, Firefox 105+, Safari 16.4+). Use
ordinary Web Workers for physics, pathfinding, and other heavy simulation work that does not
need direct DOM access.

## WebGPU, with a fallback

WebGPU reached **Baseline in January 2026**, at roughly **82 to 85 percent** global support.
Safari shipped it stably in **26.0** (September 2025). Firefox shipped it in **141+** on
Windows and **145+** on macOS.

**Firefox on Linux was still pending WebGPU support through 2026.** Ship a WebGL fallback
alongside any WebGPU renderer path. Targeting WebGPU alone leaves that combination with a
blank canvas.

## Measure before you optimize

None of the above is worth doing speculatively. Profile first and look at frame timing,
draw-call count, and texture memory before changing code. The bottleneck is often not where
it feels like it is, and a change that fixes a profiler-confirmed problem is worth far more
than one applied on a hunch.
