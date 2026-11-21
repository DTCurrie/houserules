// Fixture for the profile test: one function burns CPU, the other is cheap.
function knownHotSpin(iterations) {
  let total = 0;
  for (let i = 0; i < iterations; i++) {
    total += Math.sqrt(i) * Math.sin(i);
  }
  return total;
}

function cheapWork() {
  return 1 + 1;
}

const HOT_SPIN_ITERATIONS = 1_500_000;

cheapWork();
globalThis.sink = knownHotSpin(HOT_SPIN_ITERATIONS);
