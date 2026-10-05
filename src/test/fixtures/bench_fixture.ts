
  export function runCompute(iterations: number) {
    let acc = 0;
    for (let i = 0; i < iterations; i++) {
      acc += Math.sqrt(i) * Math.sin(i) ^ (i % 1024);
    }
    return acc;
  }

  export function fastPing() {
    return 1;
  }

  export function ioSimulation(delayMs: number) {
    return new Promise((resolve) => setTimeout(() => resolve(1), delayMs));
  }
  