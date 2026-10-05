// core_runtime/subsystem.ts
import type { SubsystemDefinition, WorkloadType } from "./types";

/**
 * Subsystem builder with sensible defaults and fail-fast validation.
 */
export function defineSubsystem<
  THandlers extends Record<string, (...args: any[]) => any>,
>(config: {
  name: string;
  entrypoint: string | URL;
  workload: WorkloadType;
  env?: Record<string, string>;
  replicas?: number;
  timeoutMs?: number;
}): SubsystemDefinition {
  // The name becomes the graph id (`graph-<name>`), so keep it predictable.
  if (!/^[A-Za-z0-9_-]+$/.test(config.name)) {
    throw new Error(
      `Invalid subsystem name "${config.name}": use letters, digits, '_' or '-'.`,
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 0)
  ) {
    throw new RangeError(
      `Subsystem "${config.name}": timeoutMs must be >= 0 (0 disables).`,
    );
  }

  return {
    name: config.name,
    entrypoint:
      config.entrypoint instanceof URL
        ? config.entrypoint.href
        : config.entrypoint,
    workload: config.workload,
    env: config.env,
    replicas: config.replicas,
    timeoutMs: config.timeoutMs,
  };
}
