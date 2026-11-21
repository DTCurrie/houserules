const NAME = String.raw`[A-Za-z_]\w*`;
const SECONDS = String.raw`\d+(?:\.\d+)?`;
const BARE_SLEEP = new RegExp(String.raw`^sleep\s+${SECONDS}$`);
const WAIT_LOOP = new RegExp(
  String.raw`^(?:(${NAME})=\d+\s*;\s*)?while\s+(.+?)\s*;\s*do\s+(.+?)\s*;\s*done$`,
);
const COUNTER_TEST = new RegExp(
  String.raw`^\[\s+(?:"\$(${NAME})"|\$(${NAME}))\s+-lt\s+\d+\s+\]$`,
);
const GREP_TEST = /^grep\s+-qE?(?:\s|$)/;
const INCREMENT = new RegExp(
  String.raw`^(${NAME})=\$\(\(\s*(${NAME})\s*\+\s*1\s*\)\)$`,
);
const AND = '&&';
// Outside quotes, each of these ends a test and starts a command of its own.
const COMMAND_BREAKS = new Set([';', '|', '&', '`', '(', ')']);

/**
 * Returns whether a Bash command is a keepalive: a bare `sleep <n>`, or the wait loop that
 * `packages/cli/payload/agents/phase-orchestrator.md` prescribes. The loop's condition is a
 * counter test, a `grep -q` or `grep -qE` test, or one of each joined by `&&`. Its body is one
 * `sleep <n>`, plus the counter's increment when the condition tests a counter, and a loop that
 * runs any other command is not a keepalive.
 *
 * It never reads `run_in_background`, so each caller checks that itself.
 *
 * @param {string} command A Bash call's `input.command`, trimmed before matching.
 */
export function isKeepaliveCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (BARE_SLEEP.test(trimmed)) return true;
  const loop = WAIT_LOOP.exec(trimmed);
  if (!loop) return false;
  const [, initialized, condition, body] = loop;
  const counter = conditionCounter(condition);
  if (counter === null) return false;
  if (initialized !== undefined && counter !== '' && initialized !== counter) {
    return false;
  }
  return isWaitBody(body, counter);
}

/**
 * The variable a loop condition counts with, `''` when it counts none, or `null` when the
 * condition is not one counter test and one grep test at most.
 */
function conditionCounter(condition) {
  const tests = splitAtAnd(condition);
  if (tests === null) return null;
  const counters = tests.map(counterName).filter((name) => name !== undefined);
  const grepCount = tests.filter((test) => GREP_TEST.test(test)).length;
  const isOneOfEachAtMost =
    counters.length <= 1 &&
    grepCount <= 1 &&
    counters.length + grepCount === tests.length;
  if (!isOneOfEachAtMost) return null;
  return counters[0] ?? '';
}

/** The variable a counter test reads, or `undefined` when `test` is not a counter test. */
function counterName(test) {
  const match = COUNTER_TEST.exec(test);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Splits a loop condition at each `&&` outside quotes. Returns `null` on an unclosed quote or on
 * any other operator outside quotes.
 */
function splitAtAnd(condition) {
  const tests = [];
  let quote = '';
  let start = 0;
  for (let index = 0; index < condition.length; index += 1) {
    const char = condition[index];
    if (char === '\\' && quote !== "'") {
      index += 1;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (condition.startsWith(AND, index)) {
      tests.push(condition.slice(start, index).trim());
      start = index + AND.length;
      index = start - 1;
    } else if (COMMAND_BREAKS.has(char)) {
      return null;
    }
  }
  if (quote) return null;
  tests.push(condition.slice(start).trim());
  return tests;
}

/** Whether a loop body is one `sleep <n>`, plus the increment of `counter` when there is one. */
function isWaitBody(body, counter) {
  const steps = body.split(';').map((step) => step.trim());
  const sleepCount = steps.filter((step) => BARE_SLEEP.test(step)).length;
  const incrementCount = steps.filter((step) =>
    isIncrementOf(step, counter),
  ).length;
  const expectedIncrements = counter === '' ? 0 : 1;
  return (
    sleepCount === 1 &&
    incrementCount === expectedIncrements &&
    steps.length === 1 + expectedIncrements
  );
}

function isIncrementOf(step, counter) {
  const match = INCREMENT.exec(step);
  return match !== null && match[1] === counter && match[2] === counter;
}
