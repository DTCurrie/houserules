import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canShareCarton, handlingCents } from '../src/hazards.mjs';

test('two classes from one group pay both handling fees', () => {
  assert.equal(handlingCents(['H1', 'H3']), 3390);
});

test('a repeated hazard class is charged once', () => {
  assert.equal(handlingCents(['H2', 'H2', 'H6']), 2195);
});

test('a neutral class adds its fee to a mixed load', () => {
  assert.equal(handlingCents(['H4', 'H5', 'H1']), 3795);
});

test('classes in one segregation group share a carton', () => {
  assert.equal(canShareCarton('H1', 'H3'), true);
});

test('classes in different segregation groups ship apart', () => {
  assert.equal(canShareCarton('H2', 'H5'), false);
});

test('a neutral class shares a carton with any group', () => {
  assert.equal(canShareCarton('H4', 'H5'), true);
});
