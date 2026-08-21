---
paths:
  - '**/+page.svelte'
  - '**/+layout.svelte'
  - '**/+page.ts'
  - '**/+page.server.ts'
  - '**/+layout.ts'
  - '**/+layout.server.ts'
  - '**/+server.ts'
  - '**/hooks.server.ts'
  - '**/hooks.client.ts'
---

# SvelteKit

Assumes `svelte.md`. This covers only the residue SvelteKit adds: routing, data loading, and
form actions.

## Routing and File Conventions

- A route directory maps to a URL segment. `+page.svelte` renders it, `+layout.svelte` wraps
  it and every nested route.
- `[param]` for a required dynamic segment, `[[param]]` for an optional one, `[...rest]` for
  a catch-all.
- `(group)` directories organize routes without adding a URL segment, most often to share a
  layout across siblings that otherwise have nothing in common in the path.
- `+server.ts` defines an API endpoint for the segment: export `GET`, `POST`, `PUT`,
  `PATCH`, or `DELETE`, each returning a `Response`.

## Load Functions

- `+page.ts` and `+layout.ts` are **universal**: they run on the server for the initial
  request and in the browser on every client-side navigation after that. Code here must run
  in both environments.
- `+page.server.ts` and `+layout.server.ts` are **server-only**: database access, secrets,
  and anything that must never reach the client belongs here. Put secret-touching code
  under `$lib/server`, or read via `$env/static/private`. The build fails if a client
  bundle imports either.
- A load function returns the data its `+page.svelte` or `+layout.svelte` reads through the
  `data` prop, typed via the generated `PageData` or `LayoutData`.
- Fetch data as high in the layout tree as a route allows, and let child routes read it
  through `data`, rather than each route re-fetching the same resource. Never rely on
  `+layout.server.ts` alone for authorization: layout logic can skip leaf routes. Check
  access in each route's load function or the `handle` hook.
- Use the `fetch` passed into the load function, not the global one. It carries request
  credentials and lets SvelteKit dedupe and inline the request during server rendering.

```typescript
// +page.server.ts
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  const post = await locals.db.getPost(params.slug);
  return { post };
};
```

## Form Actions and Progressive Enhancement

- `+page.server.ts` exports an `actions` object. A form action runs server-side on
  submission, works with JavaScript disabled, and is the default way to accept a write.
- `use:enhance` on the `<form>` progressively enhances the same action with client-side
  navigation and reactive updates, without duplicating the validation or the handler.
- Return `fail(status, data)` for a validation error the form should redisplay, and throw
  `redirect(status, location)` for a completed submission that should navigate away.

```svelte
<script lang="ts">
import { enhance } from '$app/forms';
import type { ActionData } from './$types';

const { form }: { form: ActionData } = $props();
</script>

<form method="POST" use:enhance>
  <input name="email" />
  {#if form?.error}<p>{form.error}</p>{/if}
  <button>Submit</button>
</form>
```

## Error Tracking

- **Wire the shared `handleError` hook to a tracking service.** `hooks.server.ts` exports
  it for errors thrown on the server, `hooks.client.ts` for errors thrown during
  client-side navigation, and SvelteKit calls whichever applies for every unexpected error
  it does not already handle. It is the one place that sees every crash regardless of
  which route or load function threw it. Forward `error`, `event.route.id`, and `status`
  to the service, and return the `App.Error` shape the hook expects, `{ message }` unless
  this app's `app.d.ts` redeclares it.
- **Make sure that service consumes the source maps Vite emits for the production
  build.** A tracker holding only the minified bundle can tell you a crash happened and
  nothing about where in the source it happened. Whether to upload maps to the tracker at
  build time, publish them alongside the bundle, or skip them is a deployment decision
  this rule cannot verify from inside the repo: it depends on the adapter, the host, and
  the tracking vendor's own upload step. Decide it deliberately. Most build tooling omits
  source maps from a production build by default, so skipping this step is the easy
  mistake, and it is what makes the first bullet worth doing at all.

```typescript
// hooks.server.ts
import type { HandleServerError } from '@sveltejs/kit';

export const handleError: HandleServerError = ({
  error,
  event,
  status,
  message,
}) => {
  if (status !== 404) {
    trackError(error, { route: event.route.id, status });
  }
  return { message };
};
```

## Server Versus Universal

- Treat `.server.ts` as a hard boundary, not a naming convention. SvelteKit strips these
  files from the client bundle, so importing one from client code is a build error, and
  that error is the correct outcome. Do not work around it by moving secret-touching code
  into a universal file.
- `hooks.server.ts` runs on every server request. Keep its `handle` function cheap.
  Per-route work belongs in that route's load function or action, not in the hook.

## Checked mechanically

`.claude/scripts/svelte-lint.mjs`, where installed, flags a `+server.ts` export named
something other than `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `fallback`, `OPTIONS`, or `HEAD`,
and a `hooks.server.ts` or `hooks.client.ts` that does not export `handleError`. Run it with
`node .claude/scripts/svelte-lint.mjs <files>`. It has never run against a real corpus, only
paired fixtures, so treat a finding as a starting point and report a false positive rather than
working around it.
