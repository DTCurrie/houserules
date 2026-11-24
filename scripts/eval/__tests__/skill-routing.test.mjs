import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import {
  assemblePlugin,
  payloadSkills,
} from '../fixtures/skill-routing/make-plugin.mjs';

// Keys `claude plugin eval init --bare` writes: prompt.md frontmatter and a grader's frontmatter.
const PROMPT_KEYS = ['max_turns', 'allowed_tools'];
const GRADER_KEYS = ['type', 'weight'];
const GRADER_TYPES = [
  'llm',
  'tool_used',
  'regex',
  'tool_order',
  'file_exists',
  'baseline',
];

/** Flat `key: value` frontmatter, enough for these cases. Returns `{ meta, body }`. */
function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  assert.ok(match, 'frontmatter block');
  const meta = {};
  for (const line of match[1].split('\n')) {
    const keyValue = /^([a-z_]+):\s*(.*)$/.exec(line);
    assert.ok(keyValue, `frontmatter line "${line}"`);
    meta[keyValue[1]] = keyValue[2];
  }
  return { meta, body: match[2] };
}

/** `/pattern/` as written in a grader's `input_match`, without its delimiters. */
function stripRegexSlashes(literal) {
  return literal.slice('/'.length, -'/'.length);
}

describe('skill-routing eval suite', () => {
  let plugin;
  before(() => {
    plugin = assemblePlugin(
      join(mkdtempSync(join(tmpdir(), 'hr-skill-routing-test-')), 'plugin'),
    );
  });

  it('assembles a plugin with a manifest and every payload skill', () => {
    const manifest = JSON.parse(
      readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'houserules-skill-routing');
    const skills = payloadSkills();
    assert.ok(skills.length > 0);
    for (const { name } of skills) {
      assert.ok(
        existsSync(join(plugin, 'skills', name, 'SKILL.md')),
        `${name} copied`,
      );
    }
  });

  it('has exactly one case per payload skill', () => {
    const skills = payloadSkills().map((skill) => skill.name);
    assert.equal(new Set(skills).size, skills.length, 'skill names are unique');
    const cases = readdirSync(join(plugin, 'evals')).sort();
    assert.deepEqual(cases, skills);
  });

  it('every case parses with the keys the init template carries', () => {
    for (const { name } of payloadSkills()) {
      const dir = join(plugin, 'evals', name);
      const prompt = parseFrontmatter(
        readFileSync(join(dir, 'prompt.md'), 'utf8'),
      );
      for (const key of PROMPT_KEYS)
        assert.ok(key in prompt.meta, `${name}: prompt.md ${key}`);
      assert.ok(prompt.body.trim().length > 0, `${name}: prompt body`);
      assert.ok(
        !prompt.body.includes(name),
        `${name}: prompt must not name the skill`,
      );

      const graders = readdirSync(join(dir, 'graders')).filter((f) =>
        f.endsWith('.md'),
      );
      assert.ok(graders.length >= 1, `${name}: at least one grader`);
      for (const file of graders) {
        const { meta } = parseFrontmatter(
          readFileSync(join(dir, 'graders', file), 'utf8'),
        );
        assert.ok(
          GRADER_TYPES.includes(meta.type),
          `${name}/${file}: type ${meta.type}`,
        );
        if (meta.type === 'llm') {
          for (const key of GRADER_KEYS)
            assert.ok(key in meta, `${name}/${file}: ${key}`);
        }
      }
    }
  });

  it('every case has a Skill grader whose input_match names its own skill', () => {
    for (const { name } of payloadSkills()) {
      const text = readFileSync(
        join(plugin, 'evals', name, 'graders', 'skill-fired.md'),
        'utf8',
      );
      const { meta } = parseFrontmatter(text);
      assert.equal(meta.type, 'tool_used');
      assert.equal(meta.tool, 'Skill');
      const pattern = new RegExp(stripRegexSlashes(meta.input_match));
      assert.ok(
        pattern.test(`{"skill": "${name}"}`),
        `${name}: matches own call`,
      );
      assert.ok(
        pattern.test(`{"skill":"houserules-skill-routing:${name}"}`),
        `${name}: namespaced`,
      );
      assert.ok(
        !pattern.test('{"skill": "other-skill"}'),
        `${name}: rejects another skill`,
      );
    }
  });
});
