
  // 1. Zero-delay Ping (IPC Baseline)
  export function fastPing() {
    return 1;
  }

  // 2. Real-World JSON Payload (~2 KB plain object transformation)
  export function jsonPayload(data: any) {
    return {
      success: true,
      id: data.id,
      email: data.email,
      roles: data.roles,
      processedAt: Date.now(),
      digest: data.name + ":" + data.id,
    };
  }

  // 3. Micro-Compute Task (~0.05-0.1ms math/hashing like JWT verify or state machine)
  export function microCompute(seed: number) {
    let acc = 0x811c9dc5;
    for (let i = 0; i < 1500; i++) {
      acc ^= (i * 31) ^ seed;
      acc = Math.imul(acc, 0x01000193);
    }
    return acc;
  }
  