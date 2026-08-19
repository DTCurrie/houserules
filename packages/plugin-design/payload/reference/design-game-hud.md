# Design Game HUD

How to build the interface layer around a real-time canvas: menus, health bars, inventories,
and the score display that sits on top of gameplay. `design-layout.md` covers grid grouping
and target sizing, which apply here unchanged. This doc covers the decisions specific to a
screen with a game running underneath it.

## Two rendering systems, one screen

A game UI is two rendering systems sharing a viewport. The canvas draws frames as fast as it
can, with no accessibility tree, no text selection, and no native focus or input handling.
The DOM does all of that for free. The boundary between them is a design decision, not an
implementation detail, and getting it wrong costs the player capabilities the browser would
otherwise give away.

Never draw text, menus, or standard buttons inside the canvas. A button drawn as pixels has
no accessibility tree, so a screen reader cannot see it. It has no text selection and no
native focus ring, so keyboard navigation has nothing to attach to. It does not reflow when
the viewport changes, so it has to be repositioned by hand at every breakpoint. Drawing it in
canvas means reimplementing typography, hit testing, and layout that the browser already
does well. Put the HUD in the DOM and reserve the canvas for gameplay.

## The layer cake

Stack an absolutely positioned DOM overlay above the canvas, and set `pointer-events: none`
on the overlay itself:

```css
.hud-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hud-overlay button,
.hud-overlay [role='button'],
.hud-overlay a {
  pointer-events: auto;
}
```

The overlay has to cover the full viewport so its children can be positioned anywhere on
screen, but a full-bleed element with default pointer events sits between every click and the
canvas underneath it. `pointer-events: none` on the overlay makes it transparent to input, and
restoring `pointer-events: auto` on only the interactive children lets a button still receive
clicks without the empty space around it swallowing input meant for the game.

## Perimeter anchoring

Persistent HUD data belongs at the edges of the viewport, not the center. The center is where
the player is looking during play, and any element placed there competes with the action for
attention. Health, ammo, score, and minimap read fine from the periphery because they are
checked, not stared at.

Group related HUD elements the way `design-layout.md`'s grouping section describes, and size
each group by how often the player needs it, the same rule that section gives for any grid.
That guidance is not specific to games and is not repeated here.

## Readability over a moving background

A page background is usually static. A game background is not, and the HUD sits on top of it
every single frame. That turns a readability choice into a performance choice in a way it
never is on a static page.

`backdrop-filter: blur()` is one option for keeping text legible over unpredictable content,
but its cost is per-pixel and rises sharply with the blur radius, then multiplies again by
the number of blurred elements on screen. Keep any blur radius roughly under 20px, and expect
a mobile device to handle only about 3 to 5 simultaneously blurred surfaces before the frame
budget suffers. A HUD that recomputes that cost every frame is a worse place to spend it than
a one-off blur on a static panel.

The cheaper alternatives cost far less because they are not recomputed live: a semi-opaque
solid or gradient backing behind the text, or a text shadow or outline baked into the glyph
rendering. Reach for `backdrop-filter` only after a solid backing has failed to read well
against the content it sits over.

## Viewport sizing

Size the HUD's outer container with `svh` or `dvh`, not `100vh`. Both reached Baseline Widely
Available in June 2025 and account for the mobile browser's address bar showing and hiding in
pure CSS, with no JavaScript involved.

Neither unit reacts to the on-screen keyboard, because the keyboard is not part of the
browser chrome those units track. That is the one job left for
`window.visualViewport`: detecting when a software keyboard opens so a text input or chat box
can reposition itself above it. Use CSS viewport units for browser chrome and
`visualViewport` only for the keyboard.

## Feedback timing

Keep press and hover feedback under 100ms. That threshold is where a response reads as
perceptually instantaneous, so the outcome feels caused by the player rather than by the
machine catching up. It traces to Miller and Nielsen's response-time limits. Past that
threshold the player starts to notice the gap between input and reaction.

The Doherty threshold puts sustained flow at roughly 400ms. A HUD element that updates slower
than that, such as a delayed damage number or a laggy cooldown ring, starts to break the
sense that the interface is keeping pace with the game rather than trailing it.

## Input

Pointer Lock captures the mouse for free-look camera control, hiding the cursor and reporting
relative movement instead of absolute position. It is not Baseline and is reported not to
work in some widely-used browsers, so ship it with a fallback input path rather than as the
only way to control the camera.

`OffscreenCanvas` moves canvas rendering to a worker thread, keeping the main thread free for
DOM updates and input handling. It is safe to rely on, at roughly 95% global support across
Chrome 69+, Firefox 105+, and Safari 16.4+.

Gamepad support varies by device and browser in ways that are not settled here. Design the
input layer so a gamepad can drive the same actions as pointer and keyboard, without
committing to a specific support level for the API itself.
