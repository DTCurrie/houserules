# Phase 2: http-api

**Status:** IN PROGRESS · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src/routes`

## Objective

Widgets are served over HTTP. Done when `node --test src/routes.test.mjs` exits 0 and `GET /widgets/1`
returns the stored widget.

## Steps

- [ ] Add the read routes. Acceptance: the routes test fetches one widget and the list.
- [ ] Add the write routes. Acceptance: a POST then a GET returns the posted widget.

## Slices

| id  | owns                                                | depends | wave | status  |
| --- | --------------------------------------------------- | ------- | ---- | ------- |
| 2a  | `src/routes-read.mjs`, `src/routes-read.test.mjs`   | —       | 1    | DONE    |
| 2b  | `src/routes-write.mjs`, `src/routes-write.test.mjs` | 2a      | 2    | WAITING |
