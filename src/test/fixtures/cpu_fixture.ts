
      export function heavyCompute(iterations: number) {
        let sum = 0;
        for (let i = 0; i < iterations; i++) {
          sum += Math.sqrt(i) * Math.sin(i);
        }
        return sum;
      }
      