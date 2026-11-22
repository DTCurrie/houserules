// The eval runner's unit cases live beside their modules, one file per module, and register
// their suites on import. Every case spawns only a stub `claude`, never the real CLI.
import '../eval/__tests__/fixture.cases.mjs';
import '../eval/__tests__/child.cases.mjs';
import '../eval/__tests__/meter.cases.mjs';
import '../eval/__tests__/preflight.cases.mjs';
import '../eval/__tests__/predicates.cases.mjs';
import '../eval/__tests__/run.cases.mjs';
import '../eval/__tests__/fixture-arm.cases.mjs';
