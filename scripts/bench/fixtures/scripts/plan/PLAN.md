# PLAN: widget-service

**Created:** 2026-11-01 · **Status:** see [ROADMAP.md](ROADMAP.md)

## Goal

Serve widgets over HTTP from a small durable store, so the dashboard stops reading the database
directly.

## Approach

- Build the storage layer first, with its own tests.
- Put the HTTP layer on top once the storage contract is fixed.

## Phases

1. **storage-layer**: the widget store → [phase-1-storage-layer.md](phase-1-storage-layer.md)
2. **http-api**: the routes → [phase-2-http-api.md](phase-2-http-api.md)

## Key files & interfaces

- `src/store.mjs`: the widget store.
- `src/routes.mjs`: the HTTP routes.
