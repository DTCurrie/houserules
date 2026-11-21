import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineFacts, parsePmset } from '../machine.mjs';

test('parsePmset reads AC power', () => {
  const text =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n";
  assert.equal(parsePmset(text), 'ac');
});

test('parsePmset reads battery power', () => {
  const text =
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t63%; discharging; 4:12 remaining present: true\n";
  assert.equal(parsePmset(text), 'battery');
});

test('parsePmset returns unknown for garbage and empty input', () => {
  assert.equal(parsePmset('command not found: pmset'), 'unknown');
  assert.equal(parsePmset(''), 'unknown');
  assert.equal(parsePmset(undefined), 'unknown');
});

test('machineFacts returns every key with a value', () => {
  const facts = machineFacts('abc');
  assert.deepEqual(Object.keys(facts).sort(), [
    'arch',
    'commit',
    'cpu',
    'cpus',
    'node',
    'os',
    'power',
  ]);
  for (const [key, value] of Object.entries(facts)) {
    assert.ok(value !== '' && value !== undefined && value !== null, key);
  }
  assert.equal(facts.commit, 'abc');
  assert.ok(['ac', 'battery', 'unknown'].includes(facts.power));
  assert.equal(
    typeof facts.cpus === 'number' || facts.cpus === 'unknown',
    true,
  );
});
