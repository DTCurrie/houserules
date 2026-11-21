# Phase 1: storage-layer

**Status:** DONE · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src/store`
**Closes:** #101

## Objective

The widget store reads and writes widgets by id. Done when `node --test src/store.test.mjs` exits 0
and a stored widget reads back unchanged.

## Steps

- [x] Define the widget record. Acceptance: the store test round-trips one widget.
- [x] Persist records to a file. Acceptance: a second process reads what the first wrote.

## Slices

| id  | owns                                      | depends | wave | status |
| --- | ----------------------------------------- | ------- | ---- | ------ |
| 1a  | `src/store.mjs`, `src/store.test.mjs`     | —       | 1    | DONE   |
| 1b  | `src/persist.mjs`, `src/persist.test.mjs` | —       | 1    | DONE   |
