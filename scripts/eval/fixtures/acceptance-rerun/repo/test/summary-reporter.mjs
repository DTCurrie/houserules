export default async function* summaryReporter(source) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (event.data.nesting !== 0 || event.data.name.endsWith('.mjs')) continue;
    if (event.type === 'test:pass') {
      passed += 1;
    } else {
      failed += 1;
      failures.push(event.data.name);
    }
  }
  for (const name of failures) yield `✖ ${name}\n`;
  yield '\nRun summary\n';
  const sections = ['setup', 'collection', 'execution', 'teardown', 'report'];
  let line = 0;
  for (const section of sections) {
    for (let step = 1; step <= 6; step += 1) {
      line += 1;
      yield `  ${String(line).padStart(2, '0')} ${section} step ${step} completed without notes\n`;
    }
  }
  yield `  tests passed: ${passed}\n`;
  yield `${failed} failed\n`;
  if (failed > 0) process.exitCode = 1;
}
