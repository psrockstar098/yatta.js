// src/func/env.ts
//
// Environment validation, executed before anything else boots.
//
// Fail-fast is deliberate: a misconfigured server should refuse to start
// rather than boot into a broken state (wrong port, missing signing secret,
// malformed database path).

export type NodeEnv = "production" | "development" | "test";

export interface Env {
  PORT: number;
  /**
   * Token required by `/_yatta/*`.
   *
   * Required in production. The dashboard serves traces, metric names and error
   * messages, and on a public port that is an information disclosure rather than a
   * debug convenience.
   */
  YATTA_OBSERVE_TOKEN?: string;
  /**
   * Bun's per-connection idle timeout, in seconds.
   *
   * Set explicitly because the default is short enough to close an SSE stream that
   * sends nothing for a while. A realtime connection with a heartbeat longer than
   * the default simply disappears, with nothing in the logs to say why.
   */
  IDLE_TIMEOUT_SEC?: number;
  /**
   * Largest request body accepted, in bytes.
   *
   * Also set explicitly. The default is large, and an upload endpoint that reads a
   * body fully into memory turns it into an out-of-memory crash rather than a
   * rejected request.
   */
  MAX_REQUEST_BODY_BYTES?: number;
  NODE_ENV: NodeEnv;
  /** Signing/encryption secret. Always set by the time subsystems mount. */
  STORAGE_SECRET: string;
  /** Optional SQLite file path. Falls back to "Database/app.db". */
  DATABASE_URL?: string;
  /** True when STORAGE_SECRET was generated rather than supplied. */
  isEphemeralSecret: boolean;
}

export class EnvValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const VALID_NODE_ENVS: readonly string[] = [
  "production",
  "development",
  "test",
];

/**
 * Reads an optional positive number from the environment.
 *
 * A malformed value is an issue rather than a silent default: `IDLE_TIMEOUT_SEC=abc`
 * would otherwise become the fallback and look like it had been configured.
 */
function optionalNumber(
  raw: string | undefined,
  name: string,
  issues: string[],
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be a positive whole number, received "${raw}"`);
    return undefined;
  }
  const value = Number(raw);
  if (value <= 0) {
    issues.push(`${name} must be greater than 0, received ${value}`);
    return undefined;
  }
  return value;
}

/** Discriminated result so a valid string value is never mistaken for an error. */
interface Parsed<T> {
  value: T;
  error?: string;
}

function parsePort(raw: string | undefined): Parsed<number> {
  if (raw === undefined || raw === "") return { value: 4000 };

  // Reject "4000abc", "12.5", "0x10" — only plain decimal digits are valid.
  if (!/^\d+$/.test(raw)) {
    return { value: 0, error: `PORT must be a number, received "${raw}"` };
  }

  const port = Number(raw);

  /*
   * 0 is legal and means "any free port".
   *
   * Refusing it meant a test could not bind ephemerally, and hard-coding a port in a
   * test is how two suites collide on a shared machine. It also turned `PORT=0` into
   * a validation error rather than an instruction.
   */
  if (port === 0) return { value: 0 };

  if (port > 65535) {
    return { value: 0, error: `PORT must be between 0 and 65535, received ${port}` };
  }
  return { value: port };
}

function parseNodeEnv(raw: string | undefined): Parsed<NodeEnv> {
  if (raw === undefined || raw === "") return { value: "development" };
  if (!VALID_NODE_ENVS.includes(raw)) {
    return {
      value: "development",
      error: `NODE_ENV must be one of ${VALID_NODE_ENVS.join(", ")}, received "${raw}"`,
    };
  }
  return { value: raw as NodeEnv };
}

interface SecretResult {
  secret: string;
  ephemeral: boolean;
  valid: boolean;
}

function parseSecret(raw: string | undefined): SecretResult {
  if (raw && raw.length > 0) return { secret: raw, ephemeral: false, valid: true };

  // A missing secret is only tolerable outside production: signed URLs or
  // encrypted payloads created with it would silently stop verifying, and
  // every restart would invalidate whatever was already issued.
  if (process.env.NODE_ENV === "production") {
    return { secret: "", ephemeral: false, valid: false };
  }

  return {
    secret: `ephemeral-yatta-dev-secret-${Date.now()}`,
    ephemeral: true,
    valid: true,
  };
}

/**
 * Validates and normalizes process environment variables.
 *
 * @throws {EnvValidationError} if any value is missing or malformed.
 */
export function loadEnv(): Env {
  const issues: string[] = [];

  const port = parsePort(process.env.PORT);
  if (port.error) issues.push(port.error);

  const nodeEnv = parseNodeEnv(process.env.NODE_ENV);
  if (nodeEnv.error) issues.push(nodeEnv.error);

  const secret = parseSecret(process.env.STORAGE_SECRET);
  if (!secret.valid) {
    issues.push("STORAGE_SECRET is required when NODE_ENV=production");
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret && nodeEnv.value === "production") {
    issues.push(
      "AUTH_SECRET is required when NODE_ENV=production. " +
      "Without it, JWTs can be forged and encrypted 2FA secrets decrypted. " +
      "Generate one with: openssl rand -base64 32"
    );
  }

  /*
   * An ephemeral secret in production, or in a cluster, is refused rather than
   * warned about.
   *
   * It is generated per process from a timestamp. In a single process that costs a
   * restart invalidating every signed URL; across a cluster it costs more, because
   * each worker generates a different one and a signed URL minted by worker 1 fails
   * verification on worker 2 — intermittently, depending on which worker serves the
   * request. That is a bad failure to debug, so it does not start.
   */
  const ephemeralInProduction = secret.ephemeral && nodeEnv.value === "production";
  const ephemeralInCluster =
    secret.ephemeral && typeof process.env.CLUSTER_WORKER_ID !== "undefined";

  if (ephemeralInProduction || ephemeralInCluster) {
    issues.push(
      "STORAGE_SECRET was not set, so an ephemeral one was generated. " +
        (ephemeralInCluster
          ? "In a cluster each worker generates a different secret, so signed URLs and " +
            "sessions fail on whichever worker did not mint them. "
          : "Every restart invalidates every signed URL. ") +
        "Set STORAGE_SECRET to a shared random value.",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() === "") {
    issues.push('DATABASE_URL must not be empty when provided');
  }

  /*
   * Read before the throw, not in the return statement below.
   *
   * They were in the return, which runs after `if (issues.length) throw` — so a
   * malformed value pushed its issue into a list nobody looked at again, and
   * `IDLE_TIMEOUT_SEC=abc` was accepted silently. That is the failure the option
   * exists to prevent: a default that looks like it was configured.
   */
  const idleTimeoutSec = optionalNumber(process.env.IDLE_TIMEOUT_SEC, "IDLE_TIMEOUT_SEC", issues);
  const maxRequestBodyBytes = optionalNumber(
    process.env.MAX_REQUEST_BODY_BYTES,
    "MAX_REQUEST_BODY_BYTES",
    issues,
  );

  if (issues.length > 0) throw new EnvValidationError(issues);

  return {
    PORT: port.value,
    // Left undefined rather than defaulted: the caller decides the fallback, and a
    // value silently invented here is a value nobody can find again.
    YATTA_OBSERVE_TOKEN: process.env.YATTA_OBSERVE_TOKEN || undefined,
    IDLE_TIMEOUT_SEC: idleTimeoutSec,
    MAX_REQUEST_BODY_BYTES: maxRequestBodyBytes,
    NODE_ENV: nodeEnv.value,
    STORAGE_SECRET: secret.secret,
    DATABASE_URL: databaseUrl,
    isEphemeralSecret: secret.ephemeral,
  };
}
