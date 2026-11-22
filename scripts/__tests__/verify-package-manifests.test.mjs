import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findMissingFields } from '../verify-package-manifests.mjs';

function completeManifest() {
  return {
    name: '@houserules/example',
    version: '1.0.0',
    license: 'MIT',
    author: 'Example Author',
    description: 'An example package.',
    repository: { type: 'git', url: 'https://github.com/example/example.git' },
    publishConfig: { access: 'public' },
  };
}

describe('findMissingFields', () => {
  it('reports nothing for a manifest that carries every field', () => {
    assert.deepEqual(findMissingFields(completeManifest()), []);
  });

  it('names each missing top-level field', () => {
    const manifest = completeManifest();
    delete manifest.license;
    delete manifest.repository;

    assert.deepEqual(findMissingFields(manifest), [
      'package.json is missing "license"',
      'package.json is missing "repository"',
    ]);
  });

  it('flags a publishConfig without access', () => {
    const manifest = { ...completeManifest(), publishConfig: {} };

    assert.deepEqual(findMissingFields(manifest), [
      'package.json is missing "publishConfig.access"',
    ]);
  });
});
