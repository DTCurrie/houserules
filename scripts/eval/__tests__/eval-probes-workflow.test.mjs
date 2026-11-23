import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'eval-probes.yml',
);

const TRANSCRIPT_CONDITION = 'inputs.upload-transcripts';
const TRANSCRIPT_STEP_COUNT = 4;

/**
 * The text of one job under `jobs:`, from its two-space key line to the next job's.
 *
 * @param {string} workflow
 * @param {string} name
 */
function jobText(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`job ${name} not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/**
 * Each step of a job as its own text block, split on the six-space `- ` list items.
 *
 * @param {string} job
 */
function stepsOf(job) {
  const blocks = [];
  for (const line of job.split('\n')) {
    if (/^ {6}- /.test(line)) blocks.push([line]);
    else if (blocks.length > 0) blocks.at(-1).push(line);
  }
  return blocks.map((block) => block.join('\n'));
}

/** @param {string} step */
function conditionOf(step) {
  const match = /^ {6}(?:- | {2})if: (.*)$/m.exec(step);
  return match ? match[1] : '';
}

/** @param {string} step */
function nameOf(step) {
  const match = /name: (.*)$/m.exec(step);
  return match ? match[1] : step.split('\n')[0];
}

/** @param {string} step */
function handlesTranscripts(step) {
  return (
    step.includes('scrub.mjs') ||
    step.includes('gpg ') ||
    step.includes('tar ') ||
    (step.includes('upload-artifact') && step.includes('transcripts'))
  );
}

const armSteps = stepsOf(jobText(readFileSync(WORKFLOW, 'utf8'), 'arm'));
const transcriptSteps = armSteps.filter(handlesTranscripts);

describe('eval-probes workflow arm job', () => {
  it('finds the scrub, archive, encrypt, and upload transcript steps', () => {
    assert.deepEqual(transcriptSteps.map(nameOf), [
      'Scrub transcripts',
      'Archive transcripts',
      'Encrypt transcripts',
      'Upload encrypted transcripts',
    ]);
  });

  it('runs every transcript step only when upload-transcripts and paid are set', () => {
    const unguarded = transcriptSteps
      .filter((step) => {
        const condition = conditionOf(step);
        return (
          !condition.includes(TRANSCRIPT_CONDITION) ||
          !condition.includes('inputs.paid')
        );
      })
      .map(nameOf);

    assert.equal(transcriptSteps.length, TRANSCRIPT_STEP_COUNT);
    assert.deepEqual(unguarded, []);
  });

  it('uploads only the encrypted file, kept for one day', () => {
    const upload = transcriptSteps.find((step) =>
      step.includes('upload-artifact'),
    );

    assert.match(upload ?? '', /path: \$\{\{ runner\.temp \}\}\/\S+\.gpg$/m);
    assert.match(upload ?? '', /retention-days: 1$/m);
  });

  it('uploads the result record without the upload-transcripts condition', () => {
    const recordUpload = armSteps.find(
      (step) =>
        step.includes('upload-artifact') && step.includes('name: result-'),
    );

    assert.equal(
      conditionOf(recordUpload ?? ''),
      "steps.run.outputs.exit != ''",
    );
  });
});
