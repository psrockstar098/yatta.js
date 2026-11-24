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
  // scheduleSubsystem used to silently treat 0/negative replicas as 1
  // (Math.max(1, wanted)); fail fast instead so a typo'd replica count
  // is a config error, not a silently different fleet.
  if (
    config.replicas !== undefined &&
    (!Number.isInteger(config.replicas) || config.replicas < 1)
  ) {
    throw new RangeError(
      `Subsystem "${config.name}": replicas must be an integer >= 1, got ${config.replicas}.`,
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
