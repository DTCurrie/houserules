import { accessSync, constants } from 'node:fs';

import type { CheckResult, Finding } from '@houserules/api';

/**
 * Where a local Chrome usually is. Kept in step with `CHROME_CANDIDATES` in
 * `payload/scripts/lib/cdp-session.mts`, which is the copy that actually launches it. Two lists
 * is one more than ideal, but the payload may not import from `src/` and the CLI may not import
 * from the payload, so neither can hold the other's copy.
 */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports whether the rendered design checks can run on this machine.
 *
 * A WARN and never an ERROR. The rendered tier is optional, and every other design check works
 * without it, so a machine with no Chrome is a reduced install rather than a broken one. houserules
 * discovers a browser and never installs one.
 */
export function checkChromeAvailable(): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const configured = process.env.CHROME_PATH;

  if (configured && isExecutable(configured)) {
    readouts.push(
      `design: rendered checks will use CHROME_PATH (${configured})`,
    );
    return { findings, readouts };
  }

  const found = CHROME_CANDIDATES.find(isExecutable);
  if (found) {
    readouts.push(`design: rendered checks will use ${found}`);
    return { findings, readouts };
  }

  findings.push({
    level: 'WARN',
    msg: 'design: no Chrome or Chromium found, so `design.mjs render` cannot run. Install one, or set CHROME_PATH. Every other design check works without it.',
  });
  return { findings, readouts };
}
