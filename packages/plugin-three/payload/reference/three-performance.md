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

Choose UASTC compression for quality-critical texture maps such as normals, and ETC1S for
size-critical maps such as base color. The two trade compressed size against quality
differently, so the choice is per-map rather than per-project.

Downsize a texture to the resolution the object occupies on screen. A
4096-pixel-square texture costs four times the VRAM of a 2048-pixel-square one, and a texture
sized for a hero object is rarely the right size for something seen from across the scene.

## Stop allocating inside the frame loop

Creating a `Vector3`, `Matrix4`, `Color`, or any other object inside `requestAnimationFrame`
or an update tick produces garbage. The collector reclaims it eventually, but the pause shows
up as a stutter, not as a slower average frame time. That makes it harder to spot in a
profiler that only reports averages.

Hoist every temporary you use in a hot path to module scope and mutate it in place, the same
pattern `three.md` already shows for `Vector3` and `Object3D`. Apply it to anything created
inside a loop that runs every frame, not only to vectors.

## Order per-frame work deliberately

In a Threlte app, put per-frame work in `useTask`'s named stages rather than a single
undifferentiated callback. Stage ordering is what prevents a physics update and a camera
update from disagreeing by one frame, which shows up as jitter that looks like a timing bug
rather than an ordering one.

## Fewer, larger draw calls

Each draw call is a separate submission from the CPU to the GPU, and the CPU-side overhead
per call adds up long before the GPU itself is the bottleneck. Reduce the count in several
ways.

Use `InstancedMesh` when many objects share one geometry and one material, and `BatchedMesh`
when they share a material but not a geometry. Merge static geometry that never moves
independently with `BufferGeometryUtils.mergeGeometries`, so it draws in one call instead of
many. The mechanism is real, fewer submissions per frame, but no verified multiplier exists
for the speedup, so treat any number you see attached to "instancing" or "batching" as
unverified until you measure it in your own scene.

Share materials aggressively across meshes. Each unique material can trigger its own shader
compilation, and duplicated materials, two meshes each holding their own copy of an
otherwise identical material, are a common accidental cost.

Use LOD to swap mesh detail by distance from the camera, so distant geometry costs less to
draw without looking obviously simplified up close.

Treat the widely circulated heuristic of roughly 100 draw calls per frame as a prompt to
investigate rather than a hard threshold. The real ceiling depends on device class, so a
count near it is a reason to profile, not a number to chase down for its own sake.

## Frustum culling depends on a correct bounding volume

Three.js culls objects outside the camera frustum automatically, using each mesh's bounding
sphere. Recompute that bounding sphere after modifying a mesh's vertices. A stale or
oversized bounding volume silently defeats the culling, since the mesh reads as still inside
the frustum, or still large enough to matter, when it no longer is.

## Bake what does not move

Baked lighting is the highest-leverage optimization available for a fixed scene, and it is a
content decision rather than a code one. It is dramatically cheaper than dynamic lighting at
render time, and dramatically less flexible, since the result is fixed at bake time and does
not respond to anything that moves at runtime.

## Document the scene's units

Three.js is unitless by convention, while a physics engine such as Rapier assumes meters.
Document a scene's unit and coordinate conventions explicitly wherever they are established.
A mismatch between the two is a recurring source of bugs, and it is cheap to state up front
and expensive to discover later.

## Move work off the main thread

The main thread is not just your render loop. It is shared with the DOM, the UI layer, and
input handling, so anything you move off it buys back input responsiveness as well as frame
rate.

`OffscreenCanvas` lets you render on a worker thread and is safe to recommend today, at
roughly **95% global support** (Chrome 69+, Edge 79+, Firefox 105+, Safari 16.4+). Use
ordinary Web Workers for physics, pathfinding, and other heavy simulation work that does not
need direct DOM access.

## WebGPU, with a fallback

WebGPU has not reached a Baseline classification, since a major browser still lacks stable
support on some platforms. Safari shipped it stably in **26.0** (September 2025). Firefox
added it in two steps on macOS: version **145** enabled it on Apple Silicon running macOS
Tahoe, and version **147** (released January 13, 2026) extended it to Apple Silicon on
older macOS versions.

**Firefox does not support WebGPU on Intel Macs or on Linux.** Ship a WebGL fallback
alongside any WebGPU renderer path. Targeting WebGPU alone leaves those combinations with a
blank canvas.

`WebGPURenderer` falls back to WebGL2 automatically when WebGPU is unavailable, and TSL
compiles one shader codebase to both WGSL and GLSL, so the fallback does not require a second
shader implementation.

Expect WebGPU's real-world gain to concentrate in high-draw-call and compute-heavy scenes,
where it reduces CPU binding overhead. It helps far less with texture-upload-bound or
shader-compilation-bound work. Read a uniform large-multiplier claim for WebGPU over WebGL
skeptically, since the gain depends heavily on which of those a given scene is bound by.

## Measure before you optimize

None of the above is worth doing speculatively. Profile first and look at frame timing,
draw-call count, and texture memory before changing code. The bottleneck is often not where
it feels like it is, and a change that fixes a profiler-confirmed problem is worth far more
than one applied on a hunch.

Log and assert on `renderer.info`'s draw-call, triangle, geometry, texture, and program
counts as the primary in-app performance instrument. It costs nothing to read and reflects
exactly what the renderer is doing this frame.

CPU-side timing alone can miss the thing it is meant to measure, since GPU work is
asynchronous. Use `EXT_disjoint_timer_query_webgl2` on WebGL or WebGPU timestamp queries to
measure actual GPU time per pass.

Measure performance on the target device class, not the development machine. A desktop with
a discrete GPU is the most common measurement error in this domain, and it hides problems
that only appear on the hardware users actually have.

Read published Three.js-versus-framework and WebGPU-versus-WebGL benchmark numbers as
directional at best. Most circulating figures come from agency marketing with undisclosed
methodology, so treat a specific multiplier from one of those sources as a claim to verify in
your own scene, not a number to plan around.
