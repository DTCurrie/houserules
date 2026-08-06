# Design Game Visual

How a game's UI stays legible over a moving background and gives the player feedback fast
enough to feel like their own action, not the machine's. `design-visual-principles.md` covers the
checkable thresholds that apply everywhere, including the contrast ratio formula.
`design-performance.md` covers the compositor pipeline that this doc's motion advice depends
on. This doc covers the decisions specific to a HUD sitting on top of gameplay.

## Depth and layering

A page's UI sits on a static background, so a plain color change is enough to separate the
two. A game's UI sits on top of gameplay that never stops moving, so the same static-page
intuition does not transfer. The UI needs a distance cue that reads as "this is a separate
surface floating above the scene," not just a different color.

Reach for one of these to create that separation:

- A backing surface behind the UI element, distinct from anything the background can produce.
- A drop shadow, which reads as the element floating above the scene rather than painted onto
  it.
- A border, which draws a hard edge the moving background cannot cross.
- A blur behind the element, softening the background so the sharper UI on top reads as the
  foreground layer. See `design-performance.md` for the compositor cost of this option before
  reaching for it on every panel.

Treat this as visual isolation from a moving field, not decoration. Skip it and the HUD reads
as part of the scene, and its edges compete with whatever is moving behind them.

## Size framing for peripheral reading

On a page, a reader looks directly at the text they are reading. In a game, a player reads
their health, ammo, or score while their eyes stay on the action, which means the stat is read
in peripheral vision rather than direct focus. Peripheral vision resolves size and contrast far
better than fine detail, so a stat that is legible dead-on can be unreadable a few degrees off
center.

The fix is a size relationship, not a fixed ratio: the primary stat value needs to read as
substantially larger than its label. The label exists to be read once, when the player is
already looking for it. The value exists to be read constantly, without looking away from
anything. No verified multiplier ties peripheral legibility to a specific size ratio, so treat
this as a relationship to apply by eye, not a number to hit.

## Functional color

### Status conventions

Green for positive or healthy, red for danger or damage, amber for warning. These are strong
conventions and players bring the expectation with them from other games.

The obvious limitation: red and green as the only differentiator fails for the most common
form of color vision deficiency, where the two are difficult or impossible to tell apart. Never
let color alone carry a status distinction. Pair it with a shape, an icon, or a number, so the
information still lands for a player who cannot use the color channel at all.

### One accent, reserved for interaction

Pick one accent color and use it exclusively for things the player can interact with: a
button, a selectable item, an active toggle. That reservation is the load-bearing idea in this
section. The moment the same accent shows up on something decorative, a border, an icon that
does nothing, a background flourish, it stops meaning "you can touch this" and starts meaning
nothing. The player learns the color's meaning by how consistently it is used, not by a legend
printed somewhere else.

### 60-30-10 as a starting ratio, not a rule

60-30-10 splits a palette into a dominant neutral background (60%), a structural color for
panels and dividers (30%), and an accent for interactable elements (10%). Use it as a starting
point for balancing a new palette, not as a target to hit exactly.

This is a convention borrowed from interior design, and no source measures whether it produces
better UI outcomes than another split. Treat any specific percentage you land on as a
convenience for getting a first pass balanced, not as a number you owe anyone a justification
for missing.

### Contrast

`design-visual-principles.md` owns the contrast ratio formula and the WCAG thresholds. Read that
first. A HUD over a moving background is the case where a contrast pair calculated once against
a single background color is least predictive of what the player actually sees, since the
background under the HUD keeps changing while the ratio was computed against one frame of it.

## Motion as feedback

### Keep press and hover feedback under 100ms

A player who presses a button and sees the response within 100ms perceives it as instantaneous,
so the outcome feels caused by them rather than by the machine catching up. Past that threshold
the response starts to feel like a reaction to the player's input instead of a direct extension
of it. This traces to Miller and Nielsen's response-time limits: 100ms for the feeling of
instantaneous response, and roughly 400ms (the Doherty threshold) for sustained flow to hold up
under a slower but still acceptable response.

### A focus cue matters more here than on a page

A small scale increase or brightness change on focus tells the player which element is
currently selected. On a page, a mouse cursor already shows where attention is. In a game, the
player may be on a gamepad or a keyboard with no cursor at all, so the focus cue is the only
signal of where the current selection sits. Drop it and navigation without a mouse becomes a
guessing game.

### Direction carries meaning

A notification that enters from the edge of the screen it concerns costs nothing to implement
and tells the player where to look. A warning about an enemy approaching from the left reads
better sliding in from the left edge than fading in at the center.

### Animate transform and opacity

`transform` and `opacity` are the only two properties the browser's compositor can animate on
its own, so they stay smooth even while the game loop is busy on the main thread. See
`design-performance.md` for the full compositor pipeline. That constraint is sharper in a game
than on a page: a page's main thread is idle between interactions, but a game's main thread is
running the game loop continuously, so any animation that forces layout is competing with the
game itself for the same thread on every frame.
