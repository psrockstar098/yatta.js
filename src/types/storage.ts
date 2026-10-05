/**
 * ============================================================================
 *  YATTA STORAGE (v2.0) — High-Performance Storage Operating Layer for Bun
 * ============================================================================
 *
 *  OVERVIEW:
 *  Engineered for Bun's native primitives (`Bun.file`, `Bun.write`, `Bun.S3Client`).
 *  Zero external dependencies. Fully typed, English-like DSL supporting local disk
 *  and AWS/MinIO/Cloudflare R2 S3 storage, RFC 9110 HTTP Range streaming (200, 206, 304, 416),
 *  non-destructive magic-byte content inspection, cryptographic signed URLs,
 *  virtual directory scoping, and path-traversal prevention.
 *
 *  KEY EXPORTS:
 *  - `createStorage(config)`: Factory creating a multi-disk `StorageManager`.
 *  - `Storage`: Ambient global proxy singleton for zero-config setups.
 *  - `StorageManager`: Multi-disk manager (`storage.disk(name)`, `storage.file(key)`, `storage.folder(prefix)`).
 *  - `StorageDisk`: Primary disk interface providing:
 *    - `.upload(key, data, options)`: Atomic upload with staging, capped streams, & magic-byte checks.
 *    - `.download(key)`: Returns `StorageFile` with `.text()`, `.json()`, `.buffer()`, `.stream()`.
 *    - `.serve(req, key)`: RFC 9110 compliant HTTP streaming response (Range & 304 Not Modified).
 *    - `.head(key)`: File metadata inspection without loading contents into memory.
 *    - `.exists(key)`, `.delete(key)`, `.copy(src, dst)`, `.move(src, dst)`.
 *    - `.signedUrl(key, options)`: Time-limited HMAC-SHA256 signed URLs.
 *    - `.list(options)` & `.search(options)`: Directory, prefix, and metadata searches.
 *  - `FileRef`: Fluent builder on `storage.file(key)`: `.put()`, `.write()`, `.read()`, `.serve()`, `.download()`.
 *  - `FolderRef`: Scoped virtual directory on `storage.folder(prefix)`: `.file()`, `.put()`, `.list()`, `.delete()`.
 *  - `PutBuilder`: Fluent upload builder: `.from(data).maxSize("10MB").verifyMagic().hashName().save()`.
 *  - `SignBuilder`: Fluent URL signing builder: `.expiresIn("2h").forUpload().get()`.
 *
 *  MODULE AUGMENTATION:
 *  ```ts
 *  declare module "./storage" {
 *    interface StorageRegister {
 *      disks: "local" | "s3" | "backups";
 *    }
 *  }
 *  ```
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { createStorage } from "./storage";
 *
 *  export const storage = createStorage({
 *    default: "local",
 *    disks: {
 *      local: { driver: "local", baseDir: "./storage/uploads", publicUrl: "/storage/files" },
 *      s3: { driver: "s3", bucket: "my-bucket", endpoint: process.env.S3_ENDPOINT },
 *    },
 *  });
 *
 *  // 1. Fluent file upload
 *  await storage.file("avatars/user_1.png").put(fileBuffer, { contentType: "image/png" });
 *
 *  // 2. Stream RFC 9110 byte-range response in an HTTP route
 *  export default {
 *    fetch: (req) => storage.file("videos/intro.mp4").serve(req),
 *  };
 *  ```
 */

import { S3Client } from "bun";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

// ──────────────────────────────────────────────────────────────────────────
// 0. Errors & Type Registry
// ──────────────────────────────────────────────────────────────────────────

/**
 * Base error class thrown by Yatta Storage operations.
 */
export class StorageError extends Error {
  /**
   * @param message Human-readable error description.
   * @param status Corresponding HTTP status code (defaults to 400).
   */
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Thrown when attempting to access, read, or manipulate a non-existent file key.
 */
export class FileNotFoundError extends StorageError {
  /**
   * @param path The missing file key or relative path.
   */
  constructor(path: string) {
    super(`File not found: "${path}"`, 404);
    this.name = "FileNotFoundError";
  }
}

/**
 * Thrown when a path traversal attempt, null byte injection, or unauthorized access is detected.
 */
export class StorageSecurityError extends StorageError {
  /**
   * @param message Security violation explanation.
   */
  constructor(message = "Path traversal or security violation detected") {
    super(message, 403);
    this.name = "StorageSecurityError";
  }
}

/**
 * Thrown when an HTTP conditional precondition (`If-Match` or `If-None-Match`) fails.
 */
export class PreconditionFailedError extends StorageError {
  /**
   * @param message Precondition failure details.
   */
  constructor(message = "Precondition failed") {
    super(message, 412);
    this.name = "PreconditionFailedError";
  }
}

/**
 * Thrown when an upload target already exists and overwrite policy is set to `"error"`.
 */
export class FileAlreadyExistsError extends StorageError {
  /**
   * @param path Target file key that already exists.
   */
  constructor(path: string) {
    super(`File already exists: "${path}"`, 409);
    this.name = "FileAlreadyExistsError";
  }
}

/**
 * Helper type to flatten complex intersected types for cleaner IDE hover tooltips.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Augment this interface in application code for strict autocomplete across named disks:
 *
 * @example
 * ```ts
 * declare module "./storage" {
 *   interface StorageRegister {
 *     disks: "local" | "s3" | "backups" | "uploads";
 *   }
 * }
 * ```
 */
export interface StorageRegister {}

/**
 * Resolves the union of configured disk names from {@link StorageRegister}, or falls back to generic `string`.
 */
export type RegisteredDisks = StorageRegister extends {
  disks: infer D extends string;
}
  ? D
  : string;

/**
 * Granular storage operations checked during authorization hooks.
 */
export type StorageAction = "read" | "write" | "delete" | "list" | "sign";

/**
 * Context payload passed to {@link StorageAuthorizer} callbacks for access control checks.
 */
export interface StorageAuthContext {
  /** Incoming HTTP request triggering the action. */
  request: Request;
  /** Action being attempted. */
  action: StorageAction;
  /** Target file key or path, if applicable. */
  key?: string;
  /** Target disk identifier. */
  disk?: string;
}

/**
 * Authorization guard function returning `true` to allow or `false` to deny storage actions.
 */
export type StorageAuthorizer = (
  ctx: StorageAuthContext,
) => Promise<boolean> | boolean;

/**
 * Strategy applied when writing to a key that already exists:
 * - `"replace"`: Atomically overwrite existing file (default).
 * - `"error"`: Abort and throw {@link FileAlreadyExistsError}.
 * - `"skip"`: Bypass write and return existing file metadata.
 */
export type OverwritePolicy = "replace" | "error" | "skip";

// ──────────────────────────────────────────────────────────────────────────
// 1. Data Contracts & Driver Configurations
// ──────────────────────────────────────────────────────────────────────────

/**
 * Permitted input types for upload operations.
 * Objects and arrays are automatically serialized to JSON.
 */
export type UploadInput =
  | File
  | Blob
  | Uint8Array
  | ArrayBuffer
  | Buffer
  | ReadableStream<Uint8Array>
  | string
  | Record<string, unknown>
  | unknown[];

/**
 * Human-readable duration string or raw duration in **seconds**.
 *
 * Supported units:
 * - `"s"`: Seconds
 * - `"m"`: Minutes
 * - `"h"`: Hours
 * - `"d"`: Days
 * - `"w"`: Weeks
 *
 * @example `"30s"`, `"15m"`, `"2h"`, `"7d"`, `"1w"`, or `3600`
 */
export type HumanTime = `${number}${"s" | "m" | "h" | "d" | "w"}` | number;

/**
 * Human-readable byte size string or raw size in bytes.
 *
 * Supported units:
 * - `"B"`: Bytes
 * - `"KB"`: Kilobytes (1024 B)
 * - `"MB"`: Megabytes (1024 KB)
 * - `"GB"`: Gigabytes (1024 MB)
 * - `"TB"`: Terabytes (1024 GB)
 *
 * @example `"500B"`, `"64KB"`, `"10MB"`, `"2GB"`, or `1048576`
 */
export type HumanSize = `${number}${"B" | "KB" | "MB" | "GB" | "TB"}` | number;

/**
 * Standard file metadata contract returned by storage operations.
 */
export interface FileMetadata {
  /** Relative storage key (e.g. `"avatars/user.png"`). */
  path: string;
  /** Total file size in bytes. */
  size: number;
  /** Resolved or declared MIME type (e.g. `"image/png"`). */
  contentType: string;
  /** Timestamp when the file was last modified. */
  lastModified: Date;
  /** HTTP entity tag for caching and concurrency control. */
  etag?: string;
  /** Publicly resolvable URL to access the file. */
  url: string;
  /** Optional custom user-defined metadata key-value pairs. */
  metadata?: Record<string, string>;
}

/**
 * Options for configuring upload operations.
 */
export interface UploadOptions {
  /** Explicit MIME type override. Defaults to auto-detection from file extension or content. */
  contentType?: string;
  /** Arbitrary string metadata key-values attached to the file. */
  metadata?: Record<string, string>;
  /** Upper bound size limit (e.g. `"10MB"`, `5242880`). Breaching throws a 413 error. */
  maxSize?: HumanSize;
  /** List of permitted MIME types or wildcards (e.g. `["image/*", "application/pdf"]`). */
  allowedTypes?: string[];
  /** S3 Access Control List setting. */
  acl?: "public-read" | "private";
  /** Perform non-destructive binary header inspection to verify MIME authenticity. */
  verifyMagicBytes?: boolean;
  /** Action taken if destination key exists: `"replace"`, `"error"`, or `"skip"`. */
  ifExists?: OverwritePolicy;
  /** Perform conditional write only if destination ETag matches this value. */
  ifMatch?: string;
  /** Perform conditional write only if destination does not match (e.g. `"*"` to forbid overwrite). */
  ifNoneMatch?: string;
}

/**
 * Options for generating temporary cryptographic signed URLs.
 */
export interface SignedUrlOptions {
  /** Lifetime of the URL before expiring. Defaults to `"1h"`. */
  expiresIn?: HumanTime;
  /** HTTP method permitted by this signed URL (`"GET"` or `"PUT"`). Defaults to `"GET"`. */
  method?: "GET" | "PUT";
  /** Required Content-Type for PUT upload signatures. */
  contentType?: string;
}

/**
 * Options for directory and prefix listings.
 */
export interface ListOptions {
  /** Filter results to keys starting with this prefix. */
  prefix?: string;
  /** Maximum number of files to return (defaults to 1000). */
  limit?: number;
  /** Pagination continuation token. */
  cursor?: string;
}

/**
 * Filter criteria for disk search operations.
 */
export interface SearchOptions {
  /** Search within this prefix / directory path. */
  prefix?: string;
  /** MIME type pattern filter (e.g. `"image/*"`, `"video/mp4"`). */
  type?: string;
  /** Minimum file size threshold (e.g. `"1MB"`). */
  minSize?: HumanSize;
  /** Maximum file size threshold (e.g. `"50MB"`). */
  maxSize?: HumanSize;
  /** Maximum result count limit (defaults to 1000). */
  limit?: number;
}

/**
 * Options for rendering HTTP streaming responses via `.serve()`.
 */
export interface ServeOptions {
  /** HTTP `Cache-Control` header directive (e.g. `"public, max-age=31536000, immutable"`). */
  cacheControl?: string;
  /** HTTP `Content-Disposition` delivery mode (`"inline"` or `"attachment"`). */
  disposition?: "inline" | "attachment";
  /** Custom filename supplied for downloads. Defaults to the key's base filename. */
  downloadName?: string;
  /** Additional custom response headers to merge. */
  headers?: HeadersInit;
}

/**
 * Global disk security and validation constraints.
 */
export interface StorageSecurityConfig {
  /** Global maximum upload size cap. */
  maxUploadSize?: HumanSize;
  /** Whitelisted MIME types or patterns allowed for upload. */
  allowedTypes?: string[];
  /** Globally enforce magic-byte signature validation on uploads. */
  verifyMime?: boolean;
  /** Automatically reject generic `"application/octet-stream"` uploads. */
  rejectUnknownMime?: boolean;
  /** Restrict file access strictly to signed URLs. */
  signedUrls?: boolean;
}

/**
 * Common configuration shared across all storage drivers.
 */
export interface BaseDriverConfig {
  /** Public base URL prefix used to generate public access URLs (e.g. `"/storage/files"`). */
  publicUrl?: string;
}

/**
 * Configuration options for the local filesystem storage driver.
 */
export interface LocalDriverConfig extends BaseDriverConfig {
  /** Storage driver discriminant. */
  driver: "local";
  /** Root directory on the local filesystem where files will be stored. */
  baseDir: string;
  /** Secret key used to sign and verify HMAC URLs for this disk. */
  secret?: string;
}

/**
 * Configuration options for the S3 / Cloudflare R2 / MinIO storage driver.
 */
export interface S3DriverConfig extends BaseDriverConfig {
  /** Storage driver discriminant. */
  driver: "s3";
  /** Target S3 bucket name. */
  bucket: string;
  /** AWS or S3 access key ID. */
  accessKeyId?: string;
  /** AWS or S3 secret access key. */
  secretAccessKey?: string;
  /** Custom endpoint URL for MinIO, Cloudflare R2, or Wasabi (e.g. `https://<account>.r2.cloudflarestorage.com`). */
  endpoint?: string;
  /** AWS region (defaults to `"us-east-1"`). */
  region?: string;
  /** Optional AWS STS session token. */
  sessionToken?: string;
}

/**
 * Union of driver configuration types.
 */
export type DriverConfig = LocalDriverConfig | S3DriverConfig;

/**
 * Multi-disk storage configuration contract.
 */
export interface MultiDiskStorageConfig {
  /** Name of the default disk used when none is specified. */
  default?: string;
  /** Named map of configured storage disks. */
  disks: Record<string, DriverConfig>;
  /** Global security policy applied across all disks. */
  security?: StorageSecurityConfig;
  /** Fallback cryptographic secret for URL signing. */
  secret?: string;
  /** Global authorization guard for request handling. */
  authorize?: StorageAuthorizer;
}

/**
 * Combined configuration accepted by `createStorage`.
 */
export type StorageConfig =
  | DriverConfig
  | (MultiDiskStorageConfig & { driver?: never });

// ──────────────────────────────────────────────────────────────────────────
// 2. Security, Parsers & Cryptography
// ──────────────────────────────────────────────────────────────────────────

let ephemeralDevSecret: string | null = null;
let devSecretWarned = false;

/**
 * Resolves the HMAC signing secret from config, environment variables, or generates
 * an ephemeral development key.
 *
 * @param configuredSecret Optional explicit secret provided in disk configuration.
 * @returns 32+ character signing secret.
 * @throws {StorageSecurityError} If running in production and no secure secret is configured.
 */
export function resolveSigningSecret(configuredSecret?: string): string {
  if (configuredSecret && configuredSecret.trim().length > 0) {
    return configuredSecret;
  }
  if (
    process.env.STORAGE_SECRET &&
    process.env.STORAGE_SECRET.trim().length > 0
  ) {
    return process.env.STORAGE_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw new StorageSecurityError(
      "A cryptographically secure signing secret is required in production. Configure 'secret' in storage config or set the 'STORAGE_SECRET' environment variable.",
    );
  }
  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString("hex");
  }
  if (!devSecretWarned) {
    console.warn(
      "\x1b[33m[YATTA Storage Warning]\x1b[0m No secret provided. Generated an ephemeral in-memory secret for development. Signed URLs will be invalidated upon restart.",
    );
    devSecretWarned = true;
  }
  return ephemeralDevSecret;
}

/**
 * Parses a human-readable duration string into **seconds**.
 *
 * @param val Duration string (e.g. `"30s"`, `"15m"`, `"1h"`, `"7d"`) or numeric seconds.
 * @returns Duration in seconds (defaults to 3600 if undefined or invalid).
 *
 * @example
 * ```ts
 * parseDuration("1h");  // 3600
 * parseDuration("30m"); // 1800
 * parseDuration(120);   // 120
 * ```
 */
export function parseDuration(val?: HumanTime): number {
  if (val === undefined) return 3600;
  if (typeof val === "number") return val;

  // Decimals are allowed by the HumanTime type ("1.5h"), and rejecting them
  // here silently substituted the default: "1.5h" became 1 hour, not 90 minutes.
  const match = val.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (!match) return 3600;

  const count = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();

  switch (unit) {
    case "s":
      return count;
    case "m":
      return count * 60;
    case "h":
      return count * 3600;
    case "d":
      return count * 86400;
    case "w":
      return count * 604800;
    default:
      return 3600;
  }
}

/**
 * Parses a human-readable size string into raw **bytes**.
 *
 * @param val Human size string (e.g. `"10MB"`, `"500KB"`, `"2GB"`) or numeric bytes.
 * @returns Number of bytes (defaults to 104,857,600 / 100MB if undefined).
 *
 * @example
 * ```ts
 * parseSize("1KB");  // 1024
 * parseSize("5MB");  // 5242880
 * parseSize("1GB");  // 1073741824
 * ```
 */
export function parseSize(val?: HumanSize): number {
  if (val === undefined) return 100 * 1024 * 1024; // Default: 100MB
  if (typeof val === "number") return val;

  // Decimals are allowed by the HumanSize type ("0.5MB"). Rejecting them fell
  // through to the 100MB default, so "0.5MB" became 100MB rather than 512KB —
  // a configured cap quietly 200x larger than asked for.
  const match = val.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 100 * 1024 * 1024;

  const count = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();

  switch (unit) {
    case "B":
      return count;
    case "KB":
      return count * 1024;
    case "MB":
      return count * 1024 * 1024;
    case "GB":
      return count * 1024 * 1024 * 1024;
    case "TB":
      return count * 1024 * 1024 * 1024 * 1024;
    default:
      return 100 * 1024 * 1024;
  }
}

/**
 * Sanitizes a storage key, preventing directory traversal attacks (`../`),
 * stripping leading slashes, and rejecting null bytes (`\0`).
 *
 * @param key Raw key input.
 * @returns Clean posix path.
 * @throws {StorageSecurityError} If key contains null bytes or path traversal escapes.
 */
export function sanitizeKey(key: string): string {
  if (!key || typeof key !== "string") {
    throw new StorageSecurityError("File key must be a non-empty string");
  }
  if (key.includes("\0")) {
    throw new StorageSecurityError("Null bytes in file key are prohibited");
  }

  const normalized = path.posix.normalize(key.replace(/\\/g, "/"));
  const cleaned = normalized.replace(/^\/+/, "");

  if (
    !cleaned ||
    cleaned === "." ||
    cleaned === ".." ||
    cleaned.startsWith("../") ||
    cleaned.includes("/../") ||
    cleaned.endsWith("/..")
  ) {
    throw new StorageSecurityError(`Path traversal attempt detected: "${key}"`);
  }
  return cleaned;
}

/**
 * Escapes HTML control characters to prevent XSS in the embedded explorer UI.
 *
 * @param str Unsafe input string.
 * @returns HTML-safe escaped string.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Compares two strings in constant time to prevent side-channel timing attacks on signatures.
 *
 * @param a First string.
 * @param b Second string.
 * @returns `true` if strings are identical; otherwise `false`.
 */
export function safeConstantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Infers an appropriate MIME type from a filename extension.
 *
 * @param filename File name or key.
 * @returns Inferred MIME type, or `"application/octet-stream"` as fallback.
 */
export function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
  };
  return mimes[ext] ?? "application/octet-stream";
}

/**
 * Evaluates whether a MIME type matches a pattern (supports exact and wildcards like `image/*` or `*`).
 *
 * @param type Actual MIME type (e.g. `"image/png"`).
 * @param pattern Filter pattern (e.g. `"image/*"`, `"*\/*"`).
 * @returns `true` if matched; otherwise `false`.
 */
export function matchMime(type: string, pattern: string): boolean {
  const mime = baseMime(type);
  const pat = baseMime(pattern);
  if (pat === "*/*" || pat === "*") return true;
  if (pat.endsWith("/*")) {
    return mime.startsWith(`${pat.slice(0, -2)}/`);
  }
  return mime === pat;
}

/**
 * Deep magic byte inspection across common file formats (JPEG, PNG, GIF, WEBP, PDF, ZIP, MP4, WebM, MP3, OGG).
 *
 * @param buffer Byte slice from the file header.
 * @param declaredMime Declared MIME type to verify against.
 * @returns `true` if valid or non-verifiable format; `false` on signature mismatch.
 */
/**
 * A 416 response.
 *
 * Carries its own `text/plain` rather than the file's Content-Type: the body is
 * a sentence about the range, not the file, and a client that trusted the
 * header would try to decode it as a video.
 */
function rangeNotSatisfiable(headers: Headers): Response {
  const out = new Headers(headers);
  out.delete("Content-Length");
  out.delete("Last-Modified");
  out.delete("ETag");
  out.set("Content-Type", "text/plain; charset=utf-8");
  return new Response("Requested Range Not Satisfiable", { status: 416, headers: out });
}

export function verifyMagicBytes(
  buffer: Uint8Array,
  declaredMime: string,
): boolean {
  declaredMime = baseMime(declaredMime);
  // A header shorter than 4 bytes cannot prove a signed format, so only
  // formats we have no signature for are waved through.
  if (buffer.length < 4) return !SIGNED_MIMES.has(declaredMime);

  // JPEG: FF D8 FF
  if (declaredMime === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  // PNG: 89 50 4E 47
  if (declaredMime === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  // GIF: 47 49 46 38 (GIF8)
  if (declaredMime === "image/gif") {
    return (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    );
  }
  // WEBP: RIFF....WEBP
  if (declaredMime === "image/webp") {
    // Needs all 12 bytes to read RIFF + WEBP. Returning true for a short buffer
    // waved through anything claiming to be a WebP.
    if (buffer.length < 12) return false;
    const isRiff =
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46;
    const isWebp =
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50;
    return isRiff && isWebp;
  }
  // PDF: 25 50 44 46 (%PDF)
  if (declaredMime === "application/pdf") {
    return (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    );
  }
  // ZIP: 50 4B 03 04
  if (declaredMime === "application/zip") {
    return (
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04
    );
  }
  // MP4: [4 bytes length] 'ftyp'
  if (declaredMime === "video/mp4") {
    // Needs 8 bytes to reach 'ftyp'; shorter cannot be verified.
    if (buffer.length < 8) return false;
    return (
      buffer[4] === 0x66 &&
      buffer[5] === 0x74 &&
      buffer[6] === 0x79 &&
      buffer[7] === 0x70
    );
  }
  // WebM: 1A 45 DF A3 (EBML)
  if (declaredMime === "video/webm") {
    return (
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    );
  }
  // MP3: ID3 or sync frame
  if (declaredMime === "audio/mpeg") {
    const isId3 =
      buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
    const isFrame = buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
    return isId3 || isFrame;
  }
  // OGG: 4F 67 67 53 (OggS)
  if (declaredMime === "audio/ogg") {
    return (
      buffer[0] === 0x4f &&
      buffer[1] === 0x67 &&
      buffer[2] === 0x67 &&
      buffer[3] === 0x53
    );
  }

  return true;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Reserved sidecar key used by the local driver to persist an explicit Content-Type. */
const CONTENT_TYPE_KEY = "__contentType";

const SIGNED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
]);

/** Strips parameters (`; charset=utf-8`) and normalises case: `"Text/HTML; x=y"` → `"text/html"`. */
export function baseMime(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

/** `true` for plain objects / arrays, which are serialised to JSON on upload. */
function isJsonPayload(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !(data instanceof Blob) &&
    !(data instanceof ReadableStream) &&
    !(data instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(data)
  );
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function normalizeEtag(tag: string): string {
  return tag
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
}

/** Evaluates an `If-Match` / `If-None-Match` style list (`"*"`, `"a"`, `W/"a", "b"`). */
function etagListMatches(list: string, etag?: string): boolean {
  const target = etag ? normalizeEtag(etag) : undefined;
  return list.split(",").some((raw) => {
    const t = normalizeEtag(raw);
    return t === "*" || (target !== undefined && t === target);
  });
}

function localEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

/**
 * `fs.mkdir` that reports a name collision as a StorageError.
 *
 * Uploading `full.txt/child.txt` when `full.txt` is a file made mkdir throw a
 * raw EEXIST. It is not a StorageError, so handleRequest returned 500 and the
 * stack trace reached the log. It is a conflict with an existing object: 409.
 */
async function ensureDirectory(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: any) {
    if (err?.code === "EEXIST" || err?.code === "ENOTDIR") {
      throw new StorageError(
        `Cannot write inside "${dir.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? dir}": a file already exists at that path`,
        409,
      );
    }
    throw err;
  }
}

async function statFile(p: string) {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st : null;
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}

async function readSidecar(
  fullPath: string,
): Promise<{ contentType?: string; metadata?: Record<string, string> }> {
  const f = Bun.file(`${fullPath}.meta.json`);
  if (!(await f.exists())) return {};
  try {
    const raw = (await f.json()) as Record<string, string>;
    const { [CONTENT_TYPE_KEY]: contentType, ...metadata } = raw;
    return {
      contentType,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  } catch {
    return {};
  }
}

/** Runs `fn` over `items` with bounded concurrency; rethrows the first failure after all settle. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++]!;
        try {
          await fn(item);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  );
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
}

/**
 * Creates a stream transform wrapper that aborts and throws a 413 error if total bytes exceed `maxBytes`.
 */
function createCappedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let bytesCounted = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesCounted += chunk.byteLength;
      if (bytesCounted > maxBytes) {
        controller.error(
          new StorageError(
            `Upload stream exceeded maximum allowed size of ${maxBytes} bytes`,
            413,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return source.pipeThrough(transform);
}

// ──────────────────────────────────────────────────────────────────────────
// 3. StorageFile (RFC 9110 Smart HTTP Response Bridge)
// ──────────────────────────────────────────────────────────────────────────

/**
 * High-performance file handle providing reading, parsing, and RFC 9110 compliant HTTP delivery.
 */
export class StorageFile {
  /**
   * @param path Normalized relative storage key.
   * @param size Total file size in bytes.
   * @param contentType MIME type.
   * @param lastModified File last-modified timestamp.
   * @param streamFactory Factory function returning a full `ReadableStream`.
   * @param sliceFactory Optional factory returning byte-range sliced `ReadableStream` instances.
   * @param etag Optional entity tag.
   * @param metadata Optional custom user metadata.
   */
  constructor(
    readonly path: string,
    readonly size: number,
    readonly contentType: string,
    readonly lastModified: Date,
    private readonly streamFactory: () => ReadableStream<Uint8Array>,
    private readonly sliceFactory?: (
      begin: number,
      end: number,
    ) => ReadableStream<Uint8Array>,
    readonly etag?: string,
    readonly metadata?: Record<string, string>,
  ) {}

  /**
   * Returns a fresh `ReadableStream<Uint8Array>` of the file contents.
   */
  stream(): ReadableStream<Uint8Array> {
    return this.streamFactory();
  }

  /**
   * Reads and resolves the entire file as an `ArrayBuffer`.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Response(this.stream()).arrayBuffer();
  }

  /**
   * Reads and resolves the entire file as a Node.js / Bun `Buffer`.
   */
  async buffer(): Promise<Buffer> {
    const ab = await this.arrayBuffer();
    return Buffer.from(ab);
  }

  /**
   * Reads and decodes the entire file as a UTF-8 text string.
   */
  async text(): Promise<string> {
    return new Response(this.stream()).text();
  }

  /**
   * Reads, decodes, and parses the file contents as JSON.
   *
   * @template T Expected parsed JSON shape.
   */
  async json<T = unknown>(): Promise<T> {
    return new Response(this.stream()).json();
  }

  /**
   * Reads and wraps the file contents as a WHATWG `Blob` with the correct MIME type.
   */
  async blob(): Promise<Blob> {
    return new Response(this.stream(), {
      headers: { "Content-Type": this.contentType },
    }).blob();
  }

  /**
   * Generates a fully compliant WHATWG HTTP `Response` implementing RFC 9110 HTTP streaming.
   *
   * Handles:
   * - `200 OK`: Standard full-body delivery.
   * - `206 Partial Content`: Byte-range requests (`Range: bytes=start-end`, suffix ranges).
   * - `304 Not Modified`: Conditional checks (`If-None-Match`, `If-Modified-Since`).
   * - `416 Range Not Satisfiable`: Out-of-bounds byte ranges.
   * - `HEAD`: Validates metadata and headers without streaming body content.
   *
   * @param requestOrRange Incoming `Request` object, raw `Range` header string, or `null`.
   * @param options Delivery options (cache control, content disposition, download name).
   * @returns Configured WHATWG `Response`.
   */
  serve(
    requestOrRange?: Request | string | null,
    options: ServeOptions = {},
  ): Response {
    const req = requestOrRange instanceof Request ? requestOrRange : null;
    const rangeHeader =
      typeof requestOrRange === "string"
        ? requestOrRange
        : req
          ? req.headers.get("range")
          : null;

    const headers = new Headers(options.headers);
    headers.set("Content-Type", this.contentType);
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");

    const strongEtag =
      this.etag ??
      `"${this.size.toString(16)}-${this.lastModified.getTime().toString(16)}"`;
    headers.set("ETag", strongEtag);
    headers.set("Last-Modified", this.lastModified.toUTCString());

    if (options.cacheControl) {
      headers.set("Cache-Control", options.cacheControl);
    }

    if (options.disposition) {
      const filename = options.downloadName ?? path.posix.basename(this.path);
      // Plain `filename` is an ASCII fallback; `filename*` carries the real name (RFC 8187).
      const ascii = filename
        .replace(/[^\x20-\x7e]/g, "_")
        .replace(/["\\%;]/g, "_");
      const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      headers.set(
        "Content-Disposition",
        `${options.disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      );
    }

    // 1. Conditional 304 Not Modified Checks
    if (req) {
      const ifNoneMatch = req.headers.get("if-none-match");
      if (ifNoneMatch) {
        const matches = ifNoneMatch
          .split(",")
          .map((t) => t.trim())
          .some(
            (t) => t === "*" || t === strongEtag || t === `W/${strongEtag}`,
          );
        if (matches) {
          return new Response(null, { status: 304, headers });
        }
      } else {
        const ifModifiedSince = req.headers.get("if-modified-since");
        if (ifModifiedSince) {
          const clientTime = new Date(ifModifiedSince).getTime();
          // Truncate to second precision per HTTP spec
          if (
            !isNaN(clientTime) &&
            Math.floor(this.lastModified.getTime() / 1000) <=
              Math.floor(clientTime / 1000)
          ) {
            return new Response(null, { status: 304, headers });
          }
        }
      }
    }

    // 2. Method Validation (HEAD Handling)
    const isHead = req?.method === "HEAD";

    // 3. RFC 9110 Range Processing
    // If-Range: only honour the Range when the validator still matches, otherwise
    // a resumed download of a changed file would be stitched together from two versions.
    let honorRange = true;
    const ifRange = req?.headers.get("if-range");
    if (ifRange) {
      const ts = Date.parse(ifRange);
      honorRange =
        ifRange === strongEtag ||
        (!ifRange.startsWith('"') &&
          !ifRange.startsWith("W/") &&
          !isNaN(ts) &&
          Math.floor(ts / 1000) ===
            Math.floor(this.lastModified.getTime() / 1000));
    }

    if (
      honorRange &&
      rangeHeader &&
      rangeHeader.startsWith("bytes=") &&
      this.sliceFactory
    ) {
      const rawSpec = rangeHeader.slice(6).trim();

      // Single, syntactically valid ranges only. Anything else is ignored and the
      // full representation is served (RFC 9110 §14.2).
      if (/^(\d+-\d*|-\d+)$/.test(rawSpec)) {
        let start: number;
        let end: number;

        if (rawSpec.startsWith("-")) {
          // Suffix byte range: e.g. -500 (last 500 bytes)
          const suffixLen = parseInt(rawSpec.slice(1), 10);
          start = Math.max(0, this.size - suffixLen);
          end = this.size - 1;
        } else {
          const [from, to] = rawSpec.split("-");
          // Beyond MAX_SAFE_INTEGER the digits lose precision, so `start` stops
          // meaning what was asked for. `bytes=99999999999999999999-` became
          // 1e20, failed the `start <= end` test below, and was answered with a
          // 200 and the whole body instead of a 416. Compare as BigInt so an
          // absurd offset is correctly recognised as past the end.
          if (BigInt(from!) > BigInt(Number.MAX_SAFE_INTEGER)) {
            headers.set("Content-Range", `bytes */${this.size}`);
            return rangeNotSatisfiable(headers);
          }
          start = parseInt(from!, 10);
          end = to ? parseInt(to, 10) : this.size - 1;
        }

        // Past-the-end is unsatisfiable (416), checked before the syntax test:
        // an offset beyond the file is not "invalid syntax to ignore".
        if (start >= this.size) {
          headers.set("Content-Range", `bytes */${this.size}`);
          return rangeNotSatisfiable(headers);
        }

        // "5-3" is invalid syntax (ignored, per RFC 9110 §14.2); "-0" is
        // unsatisfiable.
        if (rawSpec.startsWith("-") || start <= end) {
          if (rawSpec.startsWith("-") && start >= end) {
            headers.set("Content-Range", `bytes */${this.size}`);
            return rangeNotSatisfiable(headers);
          }

          const clampedEnd = Math.min(end, this.size - 1);
          headers.set(
            "Content-Range",
            `bytes ${start}-${clampedEnd}/${this.size}`,
          );
          headers.set("Content-Length", String(clampedEnd - start + 1));

          return new Response(
            isHead ? null : this.sliceFactory(start, clampedEnd + 1),
            { status: 206, statusText: "Partial Content", headers },
          );
        }
      }
    }

    // 4. Standard 200 Response
    headers.set("Content-Length", String(this.size));
    return new Response(isHead ? null : this.stream(), {
      status: 200,
      headers,
    });
  }

  /**
   * Convenience alias for `.serve(requestOrRange, { headers: init.headers })`.
   *
   * @param requestOrRange Incoming `Request` or range header.
   * @param init Standard `ResponseInit` headers.
   * @returns Configured WHATWG `Response`.
   */
  toResponse(
    requestOrRange?: Request | string | null,
    init: ResponseInit = {},
  ): Response {
    return this.serve(requestOrRange, { headers: init.headers });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Storage Drivers (Local Disk & S3 / R2 / MinIO)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Common driver interface implemented by all storage backends (Local Disk, S3, R2, MinIO).
 */
export interface IStorageDriver {
  /** Uploads and stores a file. */
  upload(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata>;
  /** Downloads and returns a file handle. */
  download(key: string): Promise<StorageFile>;
  /** Retrieves file metadata without downloading the body. */
  head(key: string): Promise<FileMetadata>;
  /** Deletes a single file by key. */
  delete(key: string): Promise<void>;
  /** Deletes multiple files concurrently. */
  deleteMany(keys: string[]): Promise<void>;
  /** Copies a file from source key to destination key. */
  copy(sourceKey: string, destKey: string): Promise<FileMetadata>;
  /** Moves a file from source key to destination key. */
  move(sourceKey: string, destKey: string): Promise<FileMetadata>;
  /** Checks if a file exists. */
  exists(key: string): Promise<boolean>;
  /** Lists files matching optional prefix constraints. */
  list(options?: ListOptions): Promise<FileMetadata[]>;
  /** Generates a time-limited signed URL for temporary access. */
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  /** Generates the public HTTP URL for the file key. */
  publicUrl(key: string): string;
}

/**
 * Storage driver operating directly on the local filesystem using Bun primitives (`Bun.file`, `Bun.write`).
 * Features atomic file staging (`.tmp.<uuid>`) to eliminate partially-written files on crash.
 */
export class LocalStorageDriver implements IStorageDriver {
  /** Resolved root directory path. */
  readonly baseDir: string;
  private secret: string;
  private publicBaseUrl: string;

  /**
   * The `/files/` route the signed endpoint is actually mounted at.
   *
   * `publicUrl` is the *file* route, and the signed route is a sibling under
   * the same mount. Deriving one from the other meant a `publicUrl` that did not
   * end in `/files` produced a signed URL the router could never match.
   */
  private signedRouteBase: string;

  /**
   * @param config Local driver configuration.
   * @param fallbackSecret Optional secret key fallback.
   */
  constructor(config: LocalDriverConfig, fallbackSecret?: string) {
    this.baseDir = path.resolve(config.baseDir);
    this.secret = resolveSigningSecret(config.secret ?? fallbackSecret);
    this.publicBaseUrl = (config.publicUrl ?? "/storage/files").replace(
      /\/+$/,
      "",
    );

    // The router matches `<mount>/files/signed`. Normalise onto that shape, so
    // a publicUrl given as the mount ("/storage") or as the file route
    // ("/storage/files") both produce a URL the router can serve.
    const mount = this.publicBaseUrl.replace(/\/files$/, "");
    this.signedRouteBase = `${mount}/files/signed`;
  }

  private resolvePath(key: string): string {
    const clean = sanitizeKey(key);
    // `.meta.json` sidecars and `.tmp.<uuid>` staging files live in the same namespace
    // as user keys; refuse them so they cannot be read, overwritten or deleted directly.
    if (/\.meta\.json$/i.test(clean) || /\.tmp\.[0-9a-f-]{36}/i.test(clean)) {
      throw new StorageSecurityError(
        `Reserved file name on local disks: "${key}"`,
      );
    }
    const resolved = path.resolve(this.baseDir, clean);

    const rel = path.relative(this.baseDir, resolved);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new StorageSecurityError(
        `Path traversal attempt prevented: "${key}"`,
      );
    }
    return resolved;
  }

  async upload(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const fullPath = this.resolvePath(key);
    await ensureDirectory(path.dirname(fullPath));

    if (options?.metadata && CONTENT_TYPE_KEY in options.metadata) {
      throw new StorageError(`Metadata key "${CONTENT_TYPE_KEY}" is reserved`);
    }

    let finalData: unknown = data;
    let contentType = options?.contentType;

    if (isJsonPayload(data)) {
      finalData = JSON.stringify(data, null, 2);
      contentType = contentType ?? "application/json";
    } else if (data instanceof ReadableStream) {
      finalData = new Response(data);
    }

    // The sidecar keeps user metadata plus an explicit Content-Type when it differs
    // from what the extension implies, so `download()`/`head()` report what was uploaded.
    const sidecar: Record<string, string> = { ...(options?.metadata ?? {}) };
    if (contentType && contentType !== guessContentType(key)) {
      sidecar[CONTENT_TYPE_KEY] = contentType;
    }
    const hasSidecar = Object.keys(sidecar).length > 0;

    const tmpPath = `${fullPath}.tmp.${crypto.randomUUID()}`;
    const tmpMeta = `${tmpPath}.meta.json`;
    const metaPath = `${fullPath}.meta.json`;

    // Atomic Upload Pattern: stage, then rename. The data file is committed first so a
    // failure can never leave new metadata attached to old content; a replacement with
    // no metadata also clears any stale sidecar from the previous version.
    try {
      await Bun.write(tmpPath, finalData as any);
      if (hasSidecar) {
        await Bun.write(tmpMeta, JSON.stringify(sidecar, null, 2));
      }
      await fs.rename(tmpPath, fullPath);
      if (hasSidecar) {
        await fs.rename(tmpMeta, metaPath);
      } else {
        await unlinkQuiet(metaPath);
      }
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      await fs.unlink(tmpMeta).catch(() => {});
      throw err;
    }

    const st = await fs.stat(fullPath);

    return {
      path: sanitizeKey(key),
      size: st.size,
      contentType: contentType ?? guessContentType(key),
      lastModified: st.mtime,
      etag: localEtag(st.size, st.mtimeMs),
      url: this.publicUrl(key),
      metadata: options?.metadata,
    };
  }

  async download(key: string): Promise<StorageFile> {
    const fullPath = this.resolvePath(key);
    const st = await statFile(fullPath);
    if (!st) throw new FileNotFoundError(key);

    const { contentType, metadata } = await readSidecar(fullPath);
    const bFile = Bun.file(fullPath);

    return new StorageFile(
      sanitizeKey(key),
      st.size,
      contentType ?? guessContentType(key),
      st.mtime,
      () => bFile.stream(),
      (start, end) => bFile.slice(start, end).stream(),
      localEtag(st.size, st.mtimeMs),
      metadata,
    );
  }

  async head(key: string): Promise<FileMetadata> {
    const fullPath = this.resolvePath(key);
    const st = await statFile(fullPath);
    if (!st) throw new FileNotFoundError(key);

    const { contentType, metadata } = await readSidecar(fullPath);

    return {
      path: sanitizeKey(key),
      size: st.size,
      contentType: contentType ?? guessContentType(key),
      lastModified: st.mtime,
      etag: localEtag(st.size, st.mtimeMs),
      url: this.publicUrl(key),
      metadata,
    };
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolvePath(key);
    // Missing files are fine (idempotent); permission / IO errors are not swallowed.
    await unlinkQuiet(fullPath);
    await unlinkQuiet(`${fullPath}.meta.json`);
  }

  async deleteMany(keys: string[]): Promise<void> {
    await mapLimit(keys, 32, (k) => this.delete(k));
  }

  async copy(sourceKey: string, destKey: string): Promise<FileMetadata> {
    const srcPath = this.resolvePath(sourceKey);
    const dstPath = this.resolvePath(destKey);

    if (!(await statFile(srcPath))) {
      throw new FileNotFoundError(sourceKey);
    }
    if (srcPath === dstPath) return this.head(destKey);

    await ensureDirectory(path.dirname(dstPath));

    // Stage + rename so readers never observe a half-copied destination.
    const tmp = `${dstPath}.tmp.${crypto.randomUUID()}`;
    try {
      await fs.copyFile(srcPath, tmp);
      await fs.rename(tmp, dstPath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }

    if (await Bun.file(`${srcPath}.meta.json`).exists()) {
      await fs.copyFile(`${srcPath}.meta.json`, `${dstPath}.meta.json`);
    } else {
      await unlinkQuiet(`${dstPath}.meta.json`); // don't inherit a stale sidecar
    }

    return this.head(destKey);
  }

  async move(sourceKey: string, destKey: string): Promise<FileMetadata> {
    const srcPath = this.resolvePath(sourceKey);
    const dstPath = this.resolvePath(destKey);

    if (!(await statFile(srcPath))) {
      throw new FileNotFoundError(sourceKey);
    }
    if (srcPath === dstPath) return this.head(destKey);

    await ensureDirectory(path.dirname(dstPath));
    try {
      await fs.rename(srcPath, dstPath);
    } catch (err: any) {
      // Only a cross-device rename may fall back to copy + delete; anything else is real.
      if (err?.code !== "EXDEV") throw err;
      await this.copy(sourceKey, destKey);
      await this.delete(sourceKey);
      return this.head(destKey);
    }

    if (await Bun.file(`${srcPath}.meta.json`).exists()) {
      await fs.rename(`${srcPath}.meta.json`, `${dstPath}.meta.json`);
    } else {
      await unlinkQuiet(`${dstPath}.meta.json`);
    }

    return this.head(destKey);
  }

  async exists(key: string): Promise<boolean> {
    return (await statFile(this.resolvePath(key))) !== null;
  }

  async list(options?: ListOptions): Promise<FileMetadata[]> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const results: FileMetadata[] = [];
    const limit = options?.limit ?? 1000;
    if (limit <= 0) return results;

    const prefix = options?.prefix ? sanitizeKey(options.prefix) : undefined;
    // Only walk the directory the prefix points into instead of the whole tree.
    const prefixDir =
      prefix && prefix.includes("/")
        ? prefix.slice(0, prefix.lastIndexOf("/"))
        : "";
    const scanRoot = prefixDir
      ? path.join(this.baseDir, prefixDir)
      : this.baseDir;

    const glob = new Bun.Glob("**/*");
    try {
      // dot: true — Bun.Glob skips dotfiles by default, so `.htaccess` and
      // `d/.hidden` uploaded fine but never appeared in list(), and
      // folder("fold").delete() left fold/.b behind.
      for await (const relative of glob.scan({ cwd: scanRoot, dot: true })) {
        const cleanRel =
          (prefixDir ? `${prefixDir}/` : "") + relative.replace(/\\/g, "/");

        if (
          /\.meta\.json$/i.test(cleanRel) ||
          /\.tmp\.[0-9a-f-]{36}/i.test(cleanRel)
        )
          continue;
        if (prefix && !cleanRel.startsWith(prefix)) continue;

        const fullPath = path.join(this.baseDir, cleanRel);
        const st = await statFile(fullPath);
        if (!st) continue; // removed mid-scan, or not a regular file

        const { contentType } = await readSidecar(fullPath);

        results.push({
          path: cleanRel,
          size: st.size,
          contentType: contentType ?? guessContentType(cleanRel),
          lastModified: st.mtime,
          etag: localEtag(st.size, st.mtimeMs),
          url: this.publicUrl(cleanRel),
        });

        if (results.length >= limit) break;
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err; // prefix directory doesn't exist yet
    }

    return results;
  }

  async signedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const cleanKey = sanitizeKey(key);
    const exp =
      Math.floor(Date.now() / 1000) + parseDuration(options?.expiresIn);
    const method = options?.method ?? "GET";
    // A PUT is signed over its Content-Type too. Without it, a URL issued for
    // text/plain accepted image/png, contradicting the documented requirement.
    const contentType = options?.contentType;
    const payload = `${method}:${cleanKey}:${exp}${contentType ? `:${contentType}` : ""}`;
    const sig = crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");

    const ct = contentType ? `&ct=${encodeURIComponent(contentType)}` : "";
    return `${this.signedRouteBase}?path=${encodeURIComponent(cleanKey)}&exp=${exp}&sig=${sig}&method=${method}${ct}`;
  }

  /**
   * Verifies an HMAC signature and expiration timestamp for a local file request.
   *
   * @param key Target file key.
   * @param exp Expiration epoch timestamp (in seconds).
   * @param sig HMAC-SHA256 signature token.
   * @param method Expected HTTP method (`"GET"` or `"PUT"`).
   * @returns `true` if signature matches and is not expired; otherwise `false`.
   */
  verifySignedUrl(
    key: string,
    exp: number,
    sig: string,
    method = "GET",
    contentType?: string,
  ): boolean {
    if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return false;
    let cleanKey: string;
    try {
      cleanKey = sanitizeKey(key);
    } catch {
      return false;
    }
    // Same shape as signedUrl(): an absent contentType signs as absent, so a
    // plain GET token still verifies.
    const payload = `${method}:${cleanKey}:${exp}${contentType ? `:${contentType}` : ""}`;
    const expected = crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");
    return safeConstantTimeEqual(sig, expected);
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${encodeKey(sanitizeKey(key))}`;
  }
}

/**
 * Storage driver connecting directly to AWS S3, Cloudflare R2, or MinIO via `Bun.S3Client`.
 */
export class S3StorageDriver implements IStorageDriver {
  private client: S3Client;
  private bucket: string;
  private customPublicUrl?: string;
  private endpoint?: string;
  private region: string;

  /**
   * @param config S3 driver configuration.
   */
  constructor(config: S3DriverConfig) {
    this.bucket = config.bucket;
    this.customPublicUrl = config.publicUrl?.replace(/\/+$/, "");
    this.endpoint = config.endpoint?.replace(/\/+$/, "");
    this.region = config.region ?? "us-east-1";

    this.client = new S3Client({
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      sessionToken: config.sessionToken,
    });
  }

  async upload(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const cleanKey = sanitizeKey(key);
    const s3file = this.client.file(cleanKey);

    let finalData: unknown = data;
    let contentType = options?.contentType;

    if (
      typeof data === "object" &&
      data !== null &&
      !(data instanceof Blob) &&
      !(data instanceof Uint8Array) &&
      !(data instanceof ArrayBuffer) &&
      !(data instanceof ReadableStream)
    ) {
      finalData = JSON.stringify(data, null, 2);
      contentType = contentType ?? "application/json";
    }

    await s3file.write(finalData as any, {
      type: contentType ?? guessContentType(cleanKey),
      acl: options?.acl,
    });

    const stat = (await this.client.stat(cleanKey).catch(() => null)) as any;

    return {
      path: cleanKey,
      size: stat?.size ?? 0,
      contentType: stat?.type ?? contentType ?? guessContentType(cleanKey),
      lastModified: stat?.lastModified
        ? new Date(stat.lastModified)
        : new Date(),
      etag: stat?.etag,
      url: this.publicUrl(cleanKey),
      metadata: options?.metadata,
    };
  }

  async download(key: string): Promise<StorageFile> {
    const cleanKey = sanitizeKey(key);
    const s3file = this.client.file(cleanKey);

    if (!(await s3file.exists())) {
      throw new FileNotFoundError(cleanKey);
    }

    const stat = (await this.client.stat(cleanKey).catch(() => null)) as any;

    return new StorageFile(
      cleanKey,
      stat?.size ?? s3file.size,
      stat?.type ?? s3file.type ?? guessContentType(cleanKey),
      new Date(stat?.lastModified ?? Date.now()),
      () => s3file.stream(),
      (start, end) => s3file.slice(start, end).stream(),
      stat?.etag,
    );
  }

  async head(key: string): Promise<FileMetadata> {
    const cleanKey = sanitizeKey(key);
    const stat = (await this.client.stat(cleanKey).catch(() => null)) as any;
    if (!stat) throw new FileNotFoundError(cleanKey);

    return {
      path: cleanKey,
      size: stat.size,
      contentType: stat.type || guessContentType(cleanKey),
      lastModified: new Date(stat.lastModified),
      etag: stat.etag,
      url: this.publicUrl(cleanKey),
    };
  }

  async delete(key: string): Promise<void> {
    const cleanKey = sanitizeKey(key);
    await this.client.delete(cleanKey);
  }

  async deleteMany(keys: string[]): Promise<void> {
    await mapLimit(keys, 16, (k) => this.delete(k));
  }

  async copy(sourceKey: string, destKey: string): Promise<FileMetadata> {
    const srcFile = await this.download(sourceKey);
    const stat = await this.head(sourceKey);
    return this.upload(destKey, srcFile.stream(), {
      contentType: stat.contentType,
    });
  }

  async move(sourceKey: string, destKey: string): Promise<FileMetadata> {
    // copy-then-delete onto itself would destroy the object
    if (sanitizeKey(sourceKey) === sanitizeKey(destKey)) {
      return this.head(sourceKey);
    }
    const res = await this.copy(sourceKey, destKey);
    await this.delete(sourceKey);
    return res;
  }

  async exists(key: string): Promise<boolean> {
    const cleanKey = sanitizeKey(key);
    return this.client.file(cleanKey).exists();
  }

  async list(options?: ListOptions): Promise<FileMetadata[]> {
    const limit = options?.limit ?? 1000;
    const results: FileMetadata[] = [];
    let token: string | undefined = options?.cursor;

    // Full pagination loop
    do {
      const pageLimit = Math.min(limit - results.length, 1000);
      const res: any = await this.client.list({
        prefix: options?.prefix,
        maxKeys: pageLimit,
        continuationToken: token,
      } as any);

      const items = res?.contents ?? [];
      for (const item of items) {
        results.push({
          path: item.key,
          size: item.size,
          contentType: guessContentType(item.key),
          lastModified: new Date(item.lastModified),
          etag: item.etag,
          url: this.publicUrl(item.key),
        });
        if (results.length >= limit) break;
      }

      token = res?.isTruncated ? res?.nextContinuationToken : undefined;
    } while (token && results.length < limit);

    return results;
  }

  async signedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const cleanKey = sanitizeKey(key);
    const s3file = this.client.file(cleanKey);

    return s3file.presign({
      expiresIn: parseDuration(options?.expiresIn),
      method: options?.method ?? "GET",
      ...(options?.contentType ? { type: options.contentType } : {}),
    } as any);
  }

  publicUrl(key: string): string {
    const k = encodeKey(sanitizeKey(key));
    if (this.customPublicUrl) return `${this.customPublicUrl}/${k}`;
    // Custom endpoints (R2, MinIO, Wasabi…) are addressed path-style.
    if (this.endpoint) return `${this.endpoint}/${this.bucket}/${k}`;
    if (this.region === "us-east-1") {
      return `https://${this.bucket}.s3.amazonaws.com/${k}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${k}`;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. English Fluent File Reference & Builders
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fluent reference targeting a specific file key on a {@link StorageDisk}.
 * Provides direct upload, download, metadata inspection, and streaming methods.
 */
export class FileRef {
  /**
   * @param key Normalized storage key.
   * @param storage Parent storage disk.
   */
  constructor(
    readonly key: string,
    private storage: StorageDisk,
  ) {}

  /**
   * Writes data to this file key.
   *
   * @param data Upload payload (Buffer, File, Stream, Object, etc.).
   * @param options Upload options (MIME, size cap, overwrite policy).
   */
  async write(
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    return this.storage.upload(this.key, data, options);
  }

  /**
   * Alias for {@link write}.
   */
  async put(data: UploadInput, options?: UploadOptions): Promise<FileMetadata> {
    return this.write(data, options);
  }

  /**
   * Downloads and returns a {@link StorageFile} instance for reading and streaming.
   */
  async read(): Promise<StorageFile> {
    return this.storage.download(this.key);
  }

  /**
   * Alias for {@link read}.
   */
  async get(): Promise<StorageFile> {
    return this.read();
  }

  /**
   * Retrieves file metadata without downloading the body.
   */
  async head(): Promise<FileMetadata> {
    return this.storage.head(this.key);
  }

  /**
   * Alias for {@link head}.
   */
  async stat(): Promise<FileMetadata> {
    return this.head();
  }

  /**
   * Checks whether this file exists on disk.
   */
  async exists(): Promise<boolean> {
    return this.storage.exists(this.key);
  }

  /**
   * Asserts that the file exists, throwing {@link FileNotFoundError} if missing.
   *
   * @returns `this` for chaining.
   */
  async ensureExists(): Promise<this> {
    if (!(await this.exists())) {
      throw new FileNotFoundError(this.key);
    }
    return this;
  }

  /**
   * Asserts that the file does not exist, throwing {@link FileAlreadyExistsError} if present.
   *
   * @returns `this` for chaining.
   */
  async ensureNotExists(): Promise<this> {
    if (await this.exists()) {
      throw new FileAlreadyExistsError(this.key);
    }
    return this;
  }

  /**
   * Reads and decodes file contents as a UTF-8 text string.
   */
  async text(): Promise<string> {
    const f = await this.read();
    return f.text();
  }

  /**
   * Reads, decodes, and parses file contents as JSON.
   */
  async json<T = unknown>(): Promise<T> {
    const f = await this.read();
    return f.json<T>();
  }

  /**
   * Reads file contents into a Node.js / Bun `Buffer`.
   */
  async buffer(): Promise<Buffer> {
    const f = await this.read();
    return f.buffer();
  }

  /**
   * Reads file contents into an `ArrayBuffer`.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const f = await this.read();
    return f.arrayBuffer();
  }

  /**
   * Opens a readable byte stream (`ReadableStream<Uint8Array>`) for this file.
   */
  async stream(): Promise<ReadableStream<Uint8Array>> {
    const f = await this.read();
    return f.stream();
  }

  /**
   * Reads and returns file contents wrapped in a `Blob`.
   */
  async blob(): Promise<Blob> {
    const f = await this.read();
    return f.blob();
  }

  /**
   * Deletes this file from storage.
   */
  async delete(): Promise<void> {
    return this.storage.delete(this.key);
  }

  /**
   * Copies this file to a new destination key.
   *
   * @param destinationKey Destination storage key.
   */
  async copyTo(destinationKey: string): Promise<FileMetadata> {
    return this.storage.copy(this.key, destinationKey);
  }

  /**
   * Moves / renames this file to a new destination key.
   *
   * @param destinationKey Destination storage key.
   */
  async moveTo(destinationKey: string): Promise<FileMetadata> {
    return this.storage.move(this.key, destinationKey);
  }

  /**
   * Returns the publicly accessible URL for this file.
   */
  url(): string {
    return this.storage.publicUrl(this.key);
  }

  /**
   * Initializes a {@link SignBuilder} configured with an expiration duration.
   *
   * @param time Expiration duration (e.g. `"1h"`, `"15m"`, or seconds).
   */
  expiresIn(time: HumanTime): SignBuilder {
    return new SignBuilder(this.key, this.storage).expiresIn(time);
  }

  /**
   * Directly generates a time-limited signed URL for this file.
   *
   * @param expiresIn Expiration duration (defaults to `"1h"`).
   * @param method Allowed HTTP method (`"GET"` or `"PUT"`).
   */
  async sign(
    expiresIn: HumanTime = "1h",
    method: "GET" | "PUT" = "GET",
  ): Promise<string> {
    return this.storage.signedUrl(this.key, { expiresIn, method });
  }

  /**
   * Streams this file as an HTTP Response supporting RFC 9110 Range headers and conditional 304s.
   *
   * @param request Incoming HTTP `Request` or null.
   * @param options Delivery options (cache control, headers, disposition).
   */
  async serve(
    request?: Request | null,
    options?: ServeOptions,
  ): Promise<Response> {
    const f = await this.read();
    return f.serve(request, options);
  }

  /**
   * Delivers this file as a downloadable attachment (`Content-Disposition: attachment`).
   *
   * @param options Download options including optional custom download filename.
   */
  async download(options?: { filename?: string }): Promise<Response> {
    const f = await this.read();
    return f.serve(null, {
      disposition: "attachment",
      downloadName: options?.filename ?? path.posix.basename(this.key),
    });
  }
}

/**
 * Fluent builder for complex file upload configurations, content-addressed hashing,
 * precondition matching, and magic byte validation.
 */
export class PutBuilder {
  private _data?: UploadInput;
  private _options: UploadOptions = {};
  private _uniqueName = false;
  private _hashAddressing = false;

  /**
   * @param _key Destination key or filename.
   * @param storage Target storage disk.
   */
  constructor(
    private _key: string,
    private storage: StorageDisk,
  ) {}

  /**
   * Supplies the payload data to be stored.
   *
   * @param data Upload data (File, Buffer, Stream, Object, etc.).
   */
  from(data: UploadInput): this {
    this._data = data;
    return this;
  }

  /**
   * Declares an explicit MIME Content-Type.
   */
  withContentType(type: string): this {
    this._options.contentType = type;
    return this;
  }

  /**
   * Attaches custom user metadata key-values.
   */
  withMetadata(meta: Record<string, string>): this {
    this._options.metadata = meta;
    return this;
  }

  /**
   * Marks the upload as publicly readable (`acl: "public-read"`).
   */
  asPublic(): this {
    this._options.acl = "public-read";
    return this;
  }

  /**
   * Marks the upload as private (`acl: "private"`).
   */
  asPrivate(): this {
    this._options.acl = "private";
    return this;
  }

  /**
   * Sets a maximum allowed byte size threshold.
   */
  maxSize(limit: HumanSize): this {
    this._options.maxSize = limit;
    return this;
  }

  /**
   * Enables binary header magic byte validation against the declared MIME type.
   */
  verifyMagic(): this {
    this._options.verifyMagicBytes = true;
    return this;
  }

  /**
   * Configures overwrite handling (`"replace"`, `"error"`, or `"skip"`).
   */
  ifExists(policy: OverwritePolicy): this {
    this._options.ifExists = policy;
    return this;
  }

  /**
   * Controls whether an existing file can be overwritten.
   *
   * @param allowed If `true`, replaces existing file; if `false`, throws error on collision.
   */
  overwrite(allowed = true): this {
    this._options.ifExists = allowed ? "replace" : "error";
    return this;
  }

  /**
   * Disallows overwriting an existing file (throws {@link FileAlreadyExistsError} on collision).
   */
  noOverwrite(): this {
    this._options.ifExists = "error";
    return this;
  }

  /**
   * Sets an `If-Match` ETag precondition for atomic updates.
   */
  ifMatch(etag: string): this {
    this._options.ifMatch = etag;
    return this;
  }

  /**
   * Sets an `If-None-Match` precondition (use `"*"` to ensure the file does not already exist).
   */
  ifNoneMatch(pattern = "*"): this {
    this._options.ifNoneMatch = pattern;
    return this;
  }

  /**
   * Generates a collision-free filename by appending a timestamp and random hex suffix.
   */
  unique(): this {
    this._uniqueName = true;
    return this;
  }

  /**
   * Enables content-addressed storage: names the file using its SHA-256 hash in a sharded folder (`sha256/xx/yy/<hash>.ext`).
   */
  hashName(): this {
    this._hashAddressing = true;
    return this;
  }

  /**
   * Executes the upload and returns file metadata.
   *
   * @throws {StorageError} If called without providing data via `.from(data)`.
   */
  async save(): Promise<FileMetadata> {
    if (this._data === undefined) {
      throw new StorageError(
        "Cannot execute .save() without supplying data. Use .from(data).",
      );
    }

    let data: UploadInput = this._data;
    const options: UploadOptions = { ...this._options };
    let finalKey = this._key;

    if (this._hashAddressing) {
      // Hash exactly the bytes that will be stored. Streams are buffered (under the size
      // cap) and objects are serialised the same way the drivers serialise them.
      if (data instanceof ReadableStream) {
        const cap = parseSize(
          options.maxSize ?? this.storage.securityConfig?.maxUploadSize,
        );
        data = new Uint8Array(
          await new Response(createCappedStream(data, cap)).arrayBuffer(),
        );
      } else if (isJsonPayload(data)) {
        data = JSON.stringify(data, null, 2);
        options.contentType ??= "application/json";
      }

      let bytes: Uint8Array;
      if (data instanceof Uint8Array) {
        bytes = data;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (typeof data === "string") {
        bytes = Buffer.from(data, "utf8");
      } else {
        bytes = new Uint8Array(await (data as Blob).arrayBuffer());
      }

      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const ext = path.extname(this._key);
      const dir =
        path.dirname(this._key) === "." ? "" : path.dirname(this._key);
      finalKey = path.posix.join(
        dir,
        "sha256",
        hash.slice(0, 2),
        hash.slice(2, 4),
        `${hash}${ext}`,
      );
      // Same content => same key, so re-uploading is a no-op by default.
      options.ifExists ??= "skip";
    } else if (this._uniqueName) {
      const ext = path.extname(this._key);
      const name = path.basename(this._key, ext);
      const dir =
        path.dirname(this._key) === "." ? "" : path.dirname(this._key);
      const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      finalKey = path.posix.join(dir, `${name}-${uniqueSuffix}${ext}`);
    }

    return this.storage.upload(finalKey, data, options);
  }
}

/**
 * Fluent builder for generating signed URLs.
 */
export class SignBuilder {
  private _options: SignedUrlOptions = { expiresIn: "1h", method: "GET" };

  /**
   * @param key Target storage key.
   * @param storage Parent storage disk.
   */
  constructor(
    readonly key: string,
    private storage: StorageDisk,
  ) {}

  /**
   * Sets the validity period of the signed URL.
   *
   * @param time Duration string (e.g. `"15m"`, `"2h"`, `"7d"`) or raw seconds.
   */
  expiresIn(time: HumanTime): this {
    this._options.expiresIn = time;
    return this;
  }

  /**
   * Configures the signed URL for uploading files via HTTP PUT.
   *
   * @param contentType Expected MIME type of the uploaded file.
   */
  forUpload(contentType?: string): this {
    this._options.method = "PUT";
    this._options.contentType = contentType;
    return this;
  }

  /**
   * Configures the signed URL for downloading files via HTTP GET (default).
   */
  forDownload(): this {
    this._options.method = "GET";
    return this;
  }

  /**
   * Generates and returns the cryptographic signed URL.
   */
  async get(): Promise<string> {
    return this.storage.signedUrl(this.key, this._options);
  }

  /**
   * Alias for {@link get}.
   */
  async signed(): Promise<string> {
    return this.get();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Virtual Folder / Prefix Scope
// ──────────────────────────────────────────────────────────────────────────

/**
 * Virtual directory handle scoping all operations under a given path prefix.
 */
export class FolderRef {
  /** Normalized directory prefix without trailing slash. */
  readonly prefix: string;

  /**
   * @param prefix Folder prefix path.
   * @param storage Parent storage disk.
   */
  constructor(
    prefix: string,
    private storage: StorageDisk,
  ) {
    this.prefix = sanitizeKey(prefix).replace(/\/+$/, "");
  }

  /**
   * Returns a {@link FileRef} scoped within this folder.
   *
   * @param name File name or relative subpath.
   */
  file(name: string): FileRef {
    const key = path.posix.join(this.prefix, sanitizeKey(name));
    return this.storage.file(key);
  }

  /**
   * Returns a {@link PutBuilder} for writing a file scoped within this folder.
   *
   * @param name File name or relative subpath.
   */
  put(name: string): PutBuilder {
    const key = path.posix.join(this.prefix, sanitizeKey(name));
    return this.storage.put(key);
  }

  /**
   * Returns a nested subfolder {@link FolderRef}.
   *
   * @param subfolder Child folder name.
   */
  folder(subfolder: string): FolderRef {
    const next = path.posix.join(this.prefix, sanitizeKey(subfolder));
    return new FolderRef(next, this.storage);
  }

  /**
   * Lists all files residing under this folder prefix.
   */
  async list(options?: Omit<ListOptions, "prefix">): Promise<FileMetadata[]> {
    return this.storage.list({
      ...options,
      prefix: `${this.prefix}/`,
    });
  }

  /**
   * Deletes all files residing under this folder prefix (in batches, until none remain).
   */
  async delete(): Promise<void> {
    let lastFirst: string | undefined;
    for (;;) {
      const files = await this.list({ limit: 1000 });
      if (files.length === 0) return;
      // Guard against looping forever if a backend keeps listing what it "deleted".
      if (files[0]!.path === lastFirst) {
        throw new StorageError(`Failed to delete "${files[0]!.path}"`, 500);
      }
      lastFirst = files[0]!.path;
      await this.storage.deleteMany(files.map((f) => f.path));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Storage Disk Core
// ──────────────────────────────────────────────────────────────────────────

/**
 * Primary storage disk instance managing file storage, validation, security, and streaming.
 */
export class StorageDisk {
  /**
   * @param driver Underlying storage driver implementation.
   * @param securityConfig Optional security and validation constraints.
   */
  constructor(
    readonly driver: IStorageDriver,
    readonly securityConfig?: StorageSecurityConfig,
  ) {}

  /**
   * Returns a fluent {@link FileRef} targeting a specific file key.
   */
  file(key: string): FileRef {
    return new FileRef(key, this);
  }

  /**
   * Returns a {@link PutBuilder} to upload and configure a file.
   */
  put(key: string): PutBuilder {
    return new PutBuilder(key, this);
  }

  /**
   * Returns a {@link SignBuilder} to generate a signed URL for a key.
   */
  sign(key: string): SignBuilder {
    return new SignBuilder(key, this);
  }

  /**
   * Returns a {@link FolderRef} scoping operations to a virtual directory prefix.
   */
  folder(prefix: string): FolderRef {
    return new FolderRef(prefix, this);
  }

  /**
   * Uploads and stores a file, applying MIME checking, size limits, magic-byte inspection,
   * and overwrite policies.
   *
   * Processing Pipeline:
   * 1. MIME resolution and pattern validation.
   * 2. Size limit checks and proactive stream capping.
   * 3. Non-destructive binary magic-byte verification (rewinds stream on completion).
   * 4. Overwrite policy and HTTP precondition evaluation (`If-Match`, `If-None-Match`).
   *
   * @param key Target storage key.
   * @param data Payload data.
   * @param options Upload options.
   * @returns Metadata for the stored file.
   */
  async upload(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const cleanKey = sanitizeKey(key);

    // 0. Plain objects/arrays become JSON text exactly once, so a user record that
    //    happens to have a `type` or `size` field is never mistaken for a Blob.
    let payload: UploadInput = data;
    const isJson = isJsonPayload(data);
    if (isJson) payload = JSON.stringify(data, null, 2);

    // 1. MIME Resolution & Validation
    const extType = guessContentType(cleanKey);
    const declaredType =
      options?.contentType ||
      (payload instanceof Blob && payload.type ? payload.type : undefined) ||
      (isJson ? "application/json" : undefined) ||
      extType;
    const mime = baseMime(declaredType);

    const allowed = options?.allowedTypes ?? this.securityConfig?.allowedTypes;
    if (allowed && allowed.length > 0) {
      // The declared type is client-controlled and the extension is what downstream
      // servers/CDNs key off, so BOTH must be permitted ("evil.html" declared as image/png).
      const candidates = new Set([mime]);
      const extMime = baseMime(extType);
      if (extMime !== "application/octet-stream") candidates.add(extMime);
      for (const candidate of candidates) {
        if (!allowed.some((pat) => matchMime(candidate, pat))) {
          throw new StorageSecurityError(
            `File type '${candidate}' is not permitted. Allowed types: ${allowed.join(", ")}`,
          );
        }
      }
    }

    if (
      this.securityConfig?.rejectUnknownMime &&
      mime === "application/octet-stream"
    ) {
      throw new StorageSecurityError(
        `Unrecognized or prohibited binary MIME format`,
      );
    }

    // 2. Size Cap Validation (every input kind, not only Blob/File)
    const limit = parseSize(
      options?.maxSize ?? this.securityConfig?.maxUploadSize,
    );
    let knownSize: number | undefined;
    if (payload instanceof Blob) knownSize = payload.size;
    // ArrayBuffer.isView covers Uint16Array, Float32Array, DataView and the
    // rest. Checking only Uint8Array left knownSize undefined for those, which
    // skipped this cap *and* the magic-byte inspection below entirely, so a
    // 4MB Uint16Array passed a 1MB limit.
    else if (payload instanceof ArrayBuffer) knownSize = payload.byteLength;
    else if (ArrayBuffer.isView(payload)) knownSize = payload.byteLength;
    else if (typeof payload === "string")
      knownSize = Buffer.byteLength(payload);

    if (knownSize !== undefined && knownSize > limit) {
      throw new StorageError(
        `File exceeds maximum size limit of ${limit} bytes`,
        413,
      );
    }

    // Wrap Stream with proactive transform cap to prevent DoS resource exhaustion
    let processed: UploadInput = payload;
    if (payload instanceof ReadableStream) {
      processed = createCappedStream(payload, limit);
    }

    // 3. Non-Destructive Magic Byte Inspection
    const shouldVerifyMagic =
      options?.verifyMagicBytes ?? this.securityConfig?.verifyMime ?? false;
    if (shouldVerifyMagic) {
      const mismatch = () =>
        new StorageSecurityError(
          `File signature does not match declared MIME type: "${mime}"`,
        );

      if (processed instanceof Uint8Array) {
        if (!verifyMagicBytes(processed, mime)) throw mismatch();
      } else if (processed instanceof ArrayBuffer) {
        if (
          !verifyMagicBytes(
            new Uint8Array(processed, 0, Math.min(32, processed.byteLength)),
            mime,
          )
        )
          throw mismatch();
      } else if (processed instanceof Blob) {
        const header = new Uint8Array(
          await processed.slice(0, 32).arrayBuffer(),
        );
        if (!verifyMagicBytes(header, mime)) throw mismatch();
      } else if (processed instanceof ReadableStream) {
        // Collect >= 32 bytes (or EOF) first: the first chunk alone can be 1 byte long.
        const reader = processed.getReader();
        const head: Uint8Array[] = [];
        let headLen = 0;
        let ended = false;
        while (headLen < 32) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          head.push(value);
          headLen += value.byteLength;
        }

        if (!verifyMagicBytes(Buffer.concat(head), mime)) {
          await reader.cancel().catch(() => {});
          throw mismatch();
        }

        // Rewind: replay the inspected chunks, then pull the rest on demand
        // (backpressure is preserved; nothing is buffered beyond the header).
        processed = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of head) controller.enqueue(chunk);
            if (ended) controller.close();
          },
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }
    }

    // 4. Overwrite Policy & Preconditions
    const discard = async () => {
      if (processed instanceof ReadableStream) {
        await processed.cancel().catch(() => {});
      }
    };

    const ifExists = options?.ifExists ?? "replace";
    const needsLookup =
      ifExists !== "replace" || !!options?.ifMatch || !!options?.ifNoneMatch;

    try {
      if (needsLookup) {
        const fileExists = await this.driver.exists(cleanKey);

        if (fileExists && options?.ifNoneMatch) {
          const existingEtag =
            options.ifNoneMatch === "*"
              ? undefined
              : (await this.driver.head(cleanKey)).etag;
          if (
            options.ifNoneMatch === "*" ||
            etagListMatches(options.ifNoneMatch, existingEtag)
          ) {
            throw new PreconditionFailedError(
              `File already exists: "${cleanKey}" (If-None-Match condition violated)`,
            );
          }
        }

        if (fileExists) {
          if (ifExists === "error") throw new FileAlreadyExistsError(cleanKey);
          if (ifExists === "skip") {
            await discard();
            return this.head(cleanKey);
          }
        }

        if (options?.ifMatch) {
          if (!fileExists) {
            throw new PreconditionFailedError(
              `Cannot match ETag. File does not exist: "${cleanKey}"`,
            );
          }
          const existing = await this.driver.head(cleanKey);
          if (!etagListMatches(options.ifMatch, existing.etag)) {
            throw new PreconditionFailedError(
              `ETag mismatch: expected "${options.ifMatch}", found "${existing.etag}"`,
            );
          }
        }
      }
    } catch (err) {
      await discard();
      throw err;
    }

    return this.driver.upload(cleanKey, processed, {
      ...options,
      contentType: declaredType,
    });
  }

  /**
   * Downloads a file and returns a {@link StorageFile} instance for reading or streaming.
   *
   * @param key Target storage key.
   */
  async download(key: string): Promise<StorageFile> {
    return this.driver.download(sanitizeKey(key));
  }

  /**
   * Retrieves file metadata without downloading the body content.
   *
   * @param key Target storage key.
   */
  async head(key: string): Promise<FileMetadata> {
    return this.driver.head(sanitizeKey(key));
  }

  /**
   * Alias for {@link head}.
   */
  async stat(key: string): Promise<FileMetadata> {
    return this.head(key);
  }

  /**
   * Deletes a file by key.
   */
  async delete(key: string): Promise<void> {
    return this.driver.delete(sanitizeKey(key));
  }

  /**
   * Deletes multiple files concurrently.
   */
  async deleteMany(keys: string[]): Promise<void> {
    return this.driver.deleteMany(keys.map(sanitizeKey));
  }

  /**
   * Copies a file to a new destination key.
   */
  async copy(source: string, destination: string): Promise<FileMetadata> {
    const src = sanitizeKey(source);
    const dst = sanitizeKey(destination);
    if (src === dst) return this.head(src);
    return this.driver.copy(src, dst);
  }

  /**
   * Moves / renames a file to a new destination key.
   */
  async move(source: string, destination: string): Promise<FileMetadata> {
    const src = sanitizeKey(source);
    const dst = sanitizeKey(destination);
    if (src === dst) return this.head(src);
    return this.driver.move(src, dst);
  }

  /**
   * Checks whether a file exists.
   */
  async exists(key: string): Promise<boolean> {
    return this.driver.exists(sanitizeKey(key));
  }

  /**
   * Lists files matching optional prefix constraints.
   */
  async list(options?: ListOptions): Promise<FileMetadata[]> {
    return this.driver.list(options);
  }

  /**
   * Searches for files by prefix, MIME type, and size range.
   */
  async search(options: SearchOptions): Promise<FileMetadata[]> {
    // Filter first, limit last: applying `limit` before filtering silently dropped matches.
    const files = await this.list({
      prefix: options.prefix,
      limit: 10_000,
    });
    // `!== undefined`, not truthiness: maxSize: 0 means "match nothing", and a
    // falsy check read it as "no limit".
    const minBytes = options.minSize !== undefined ? parseSize(options.minSize) : 0;
    const maxBytes = options.maxSize !== undefined ? parseSize(options.maxSize) : Infinity;

    return files
      .filter((f) => {
        if (options.type && !matchMime(f.contentType, options.type))
          return false;
        if (f.size < minBytes || f.size > maxBytes) return false;
        return true;
      })
      .slice(0, options.limit ?? 1000);
  }

  /**
   * Generates a time-limited cryptographic signed URL for temporary file access.
   */
  async signedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return this.driver.signedUrl(sanitizeKey(key), options);
  }

  /**
   * Returns the public HTTP URL for the given key.
   */
  publicUrl(key: string): string {
    return this.driver.publicUrl(sanitizeKey(key));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 8. Storage Manager & Embedded Hardened Explorer UI
// ──────────────────────────────────────────────────────────────────────────

/**
 * Multi-disk manager coordinating local filesystems, S3/R2 cloud storage,
 * authorization policies, and an embedded browser storage explorer UI.
 */
export class StorageManager {
  private disks = new Map<string, StorageDisk>();
  private defaultDiskName = "default";
  private authorizer?: StorageAuthorizer;

  /**
   * @param config Single disk or multi-disk configuration.
   */
  constructor(config: StorageConfig) {
    if ("disks" in config && config.disks) {
      this.defaultDiskName =
        config.default ?? Object.keys(config.disks)[0] ?? "default";
      this.authorizer = config.authorize;
      const sec = config.security;

      for (const [name, diskCfg] of Object.entries(config.disks)) {
        this.disks.set(name, this.createDisk(diskCfg, sec, config.secret));
      }
      if (!this.disks.has(this.defaultDiskName)) {
        throw new StorageError(
          `Default disk "${this.defaultDiskName}" is not among the configured disks: ${[...this.disks.keys()].join(", ")}`,
        );
      }
    } else {
      const cfg = config as DriverConfig;
      this.disks.set(this.defaultDiskName, this.createDisk(cfg));
    }
  }

  private createDisk(
    cfg: DriverConfig,
    security?: StorageSecurityConfig,
    fallbackSecret?: string,
  ): StorageDisk {
    if (cfg.driver === "s3") {
      return new StorageDisk(new S3StorageDriver(cfg), security);
    }
    return new StorageDisk(
      new LocalStorageDriver(cfg, fallbackSecret),
      security,
    );
  }

  /**
   * Selects a configured storage disk by name.
   *
   * @template D Registered disk name union.
   * @param name Name of the target disk. Defaults to the configured default disk.
   * @returns The corresponding {@link StorageDisk}.
   * @throws {StorageError} If the specified disk name is not configured.
   */
  disk<D extends RegisteredDisks = RegisteredDisks>(name?: D): StorageDisk {
    const target = name ?? this.defaultDiskName;
    const disk = this.disks.get(target);
    if (!disk) {
      throw new StorageError(
        `Storage disk "${String(target)}" is not configured.`,
      );
    }
    return disk;
  }

  /**
   * Returns the primary default storage disk.
   */
  get defaultDisk(): StorageDisk {
    return this.disk();
  }

  /**
   * Returns a {@link FileRef} targeting a key on the default disk.
   */
  file(key: string): FileRef {
    return this.defaultDisk.file(key);
  }

  /**
   * Returns a {@link PutBuilder} for writing a file on the default disk.
   */
  put(key: string): PutBuilder {
    return this.defaultDisk.put(key);
  }

  /**
   * Returns a {@link SignBuilder} for generating a signed URL on the default disk.
   */
  sign(key: string): SignBuilder {
    return this.defaultDisk.sign(key);
  }

  /**
   * Returns a {@link FolderRef} scoping operations to a virtual directory on the default disk.
   */
  folder(prefix: string): FolderRef {
    return this.defaultDisk.folder(prefix);
  }

  /**
   * Searches for files matching criteria on the default disk.
   */
  async search(options: SearchOptions): Promise<FileMetadata[]> {
    return this.defaultDisk.search(options);
  }

  /**
   * Renders the embedded zero-dependency Storage Explorer web dashboard.
   *
   * @param options Optional page title and mount path.
   * @returns Complete HTML `Response`.
   */
  renderUI(options?: { title?: string; mountPath?: string }): Response {
    const title = escapeHtml(options?.title ?? "YATTA Storage Explorer");
    const mountPath = (options?.mountPath ?? "/storage").replace(/\/+$/, "");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: #090d16; --card: #111827; --border: #1f2937;
      --text: #f3f4f6; --text-muted: #9ca3af;
      --primary: #3b82f6; --primary-hover: #2563eb; --danger: #ef4444;
      --radius: 10px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 32px 16px; min-height: 100vh; }
    .container { max-width: 1024px; margin: 0 auto; }
    header { margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
    h1 { font-size: 22px; font-weight: 700; }
    .badge { background: #1e293b; color: #60a5fa; padding: 5px 12px; border-radius: 9999px; font-size: 12px; border: 1px solid #3b82f633; }
    .dropzone {
      border: 2px dashed #374151; background: var(--card); border-radius: var(--radius);
      padding: 32px 20px; text-align: center; cursor: pointer; transition: 0.2s; margin-bottom: 24px;
    }
    .dropzone.dragover { border-color: var(--primary); background: #1e293b; }
    .dropzone svg { width: 40px; height: 40px; fill: none; stroke: var(--text-muted); margin-bottom: 8px; }
    .btn {
      background: var(--primary); color: white; border: none; padding: 8px 14px; border-radius: 6px;
      font-weight: 500; cursor: pointer; transition: 0.15s; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-sm { padding: 4px 8px; font-size: 12px; }
    .btn-danger { background: #371b1e; color: #f87171; border: 1px solid #ef444433; }
    .btn-danger:hover { background: var(--danger); color: white; }
    .progress-bar { width: 100%; height: 5px; background: #1f2937; border-radius: 4px; overflow: hidden; margin-top: 14px; display: none; }
    .progress-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.1s; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { padding: 12px 16px; background: #151e2e; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--border); }
    td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .file-name { font-weight: 500; color: #fff; display: flex; align-items: center; gap: 10px; }
    .preview-thumb { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; background: #1f2937; flex-shrink: 0; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #1e293b; color: #fff; padding: 10px 16px; border-radius: 8px; border: 1px solid #3b82f6; display: none; z-index: 99; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${title}</h1>
        <p style="color: var(--text-muted); font-size: 13px; margin-top: 3px;">Bun Native Fast Object Engine</p>
      </div>
      <span class="badge">Disks: ${escapeHtml(Array.from(this.disks.keys()).join(", ").toUpperCase())}</span>
    </header>

    <div class="dropzone" id="dropzone">
      <svg stroke-width="2" viewBox="0 0 24 24"><path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
      <p style="font-weight: 600; font-size: 15px;">Drop files here or click to browse</p>
      <p style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">Zero-copy streaming upload</p>
      <input type="file" id="fileInput" multiple style="display: none;">
      <div class="progress-bar" id="progressBar"><div class="progress-fill" id="progressFill"></div></div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Type</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="fileTable">
          <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading storage files...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const mount = ${JSON.stringify(mountPath).replace(/</g, "\\u003c")};
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("fileInput");
    const progressBar = document.getElementById("progressBar");
    const progressFill = document.getElementById("progressFill");
    const fileTable = document.getElementById("fileTable");
    const toast = document.getElementById("toast");

    function showToast(msg) {
      toast.textContent = msg;
      toast.style.display = "block";
      setTimeout(() => { toast.style.display = "none"; }, 3000);
    }

    dropzone.onclick = () => fileInput.click();
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
    dropzone.ondragleave = () => dropzone.classList.remove("dragover");
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      handleUpload(e.dataTransfer.files);
    };
    fileInput.onchange = (e) => handleUpload(e.target.files);

    function formatSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024, i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
    }

    async function loadFiles() {
      try {
        const res = await fetch(mount + "/api/files");
        if (!res.ok) throw new Error("Status " + res.status);
        const files = await res.json();

        // Resolved up front: the render below is synchronous, so asking for a URL
        // inside it produced "[object Promise]" for every row.
        const resolvedUrls = new Map();
        await Promise.all(files.map(async function (f) {
          resolvedUrls.set(f.path, await resolveUrl(f.path));
        }));

        fileTable.innerHTML = "";
        if (files.length === 0) {
          const row = document.createElement("tr");
          row.innerHTML = '<td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">No files present in storage.</td>';
          fileTable.appendChild(row);
          return;
        }

        files.forEach(f => {
          const tr = document.createElement("tr");

          // File cell with preview
          const tdFile = document.createElement("td");
          const divFile = document.createElement("div");
          divFile.className = "file-name";

          const isImg = typeof f.contentType === 'string' && f.contentType.startsWith("image/");
          if (isImg) {
            const img = document.createElement("img");
            img.className = "preview-thumb";
            // Resolved per-file: with security.signedUrls on, the direct
            // /files/ route is 403, so a thumbnail src built from it rendered a
            // broken image.
            img.src = resolvedUrls.get(f.path) || (mount + "/files/" + encodeURIComponent(f.path));
            divFile.appendChild(img);
          } else {
            const icon = document.createElement("div");
            icon.className = "preview-thumb";
            icon.style.display = "flex";
            icon.style.alignItems = "center";
            icon.style.justifyContent = "center";
            icon.textContent = "📄";
            divFile.appendChild(icon);
          }

          const span = document.createElement("span");
          span.textContent = f.path;
          divFile.appendChild(span);
          tdFile.appendChild(divFile);
          tr.appendChild(tdFile);

          // Size cell
          const tdSize = document.createElement("td");
          tdSize.style.color = "var(--text-muted)";
          tdSize.textContent = formatSize(f.size);
          tr.appendChild(tdSize);

          // Type cell
          const tdType = document.createElement("td");
          tdType.style.color = "var(--text-muted)";
          tdType.style.fontSize = "12px";
          tdType.textContent = f.contentType || "binary";
          tr.appendChild(tdType);

          // Actions
          const tdActions = document.createElement("td");
          const divActions = document.createElement("div");
          divActions.style.display = "flex";
          divActions.style.gap = "8px";

          const btnDownload = document.createElement("a");
          btnDownload.className = "btn btn-sm";
          btnDownload.href = resolvedUrls.get(f.path) || (mount + "/files/" + encodeURIComponent(f.path));
          btnDownload.setAttribute("download", "");
          btnDownload.textContent = "Download";

          const btnSign = document.createElement("button");
          btnSign.className = "btn btn-sm";
          btnSign.textContent = "Sign URL";
          btnSign.onclick = () => getSignedUrl(f.path);

          const btnDel = document.createElement("button");
          btnDel.className = "btn btn-sm btn-danger";
          btnDel.textContent = "Delete";
          btnDel.onclick = () => deleteFile(f.path);

          divActions.appendChild(btnDownload);
          divActions.appendChild(btnSign);
          divActions.appendChild(btnDel);
          tdActions.appendChild(divActions);
          tr.appendChild(tdActions);

          fileTable.appendChild(tr);
        });
      } catch (err) {
        fileTable.textContent = "";
        const errRow = document.createElement("tr");
        const errCell = document.createElement("td");
        errCell.colSpan = 4;
        errCell.style.cssText = "text-align: center; color: var(--danger); padding: 24px;";
        errCell.textContent = "Failed to load files: " + err.message;
        errRow.appendChild(errCell);
        fileTable.appendChild(errRow);
      }
    }

    async function handleUpload(files) {
      if (!files.length) return;
      progressBar.style.display = "block";

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append("file", file);
        formData.append("path", file.name);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", mount + "/api/upload");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = ((e.loaded / e.total) * 100).toFixed(0);
            progressFill.style.width = percent + "%";
          }
        };

        await new Promise((resolve) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              showToast("Uploaded: " + file.name);
            } else {
              showToast("Upload rejected (" + xhr.status + "): " + file.name);
            }
            resolve();
          };
          xhr.onerror = () => {
            showToast("Network error uploading " + file.name);
            resolve();
          };
          xhr.send(formData);
        });
      }

      progressBar.style.display = "none";
      progressFill.style.width = "0%";
      fileInput.value = "";
      loadFiles();
    }

    async function deleteFile(path) {
      if (!confirm("Are you sure you want to permanently delete " + path + "?")) return;
      const res = await fetch(mount + "/api/files?path=" + encodeURIComponent(path), { method: "DELETE" });
      if (res.ok) {
        showToast("Deleted " + path);
      } else {
        showToast("Failed to delete " + path);
      }
      loadFiles();
    }

    /*
     * A URL the browser can actually fetch.
     *
     * With security.signedUrls enabled the direct /files/ route returns 403, so
     * a thumbnail or download link built from it silently failed. Ask for a
     * signed URL instead and fall back to the direct route if signing is
     * unavailable, so the explorer still works when signed URLs are off.
     */
    async function resolveUrl(path) {
      try {
        const res = await fetch(mount + "/api/signed?path=" + encodeURIComponent(path));
        if (res.ok) {
          const data = await res.json();
          if (data && data.url) return data.url;
        }
      } catch {}
      return mount + "/files/" + encodeURIComponent(path);
    }

    async function getSignedUrl(path) {
      const res = await fetch(mount + "/api/signed?path=" + encodeURIComponent(path));
      if (!res.ok) {
        alert("Failed to sign URL: HTTP " + res.status);
        return;
      }
      const data = await res.json();
      navigator.clipboard.writeText(data.url);
      alert("Cryptographic Signed URL copied to clipboard!\\n\\n" + data.url);
    }

    loadFiles();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * High-Performance Unified Request Router.
   * Handles the Explorer UI, REST endpoints, Signed URLs, and HTTP 206 Streaming.
   *
   * Routes handled:
   * - `GET <prefix>/`: Renders the Storage Explorer UI.
   * - `GET <prefix>/api/files`: Lists files on the default disk.
   * - `POST <prefix>/api/upload`: Handles multipart form file uploads.
   * - `DELETE <prefix>/api/files?path=<key>`: Deletes a file.
   * - `GET <prefix>/api/signed?path=<key>`: Generates a temporary signed URL.
   * - `GET <prefix>/files/signed`: Serves files verified against cryptographic signed URLs.
   * - `GET <prefix>/files/<key>`: Direct HTTP streaming delivery with byte-range support.
   *
   * @param req Incoming HTTP `Request`.
   * @param prefix URL prefix mount path (defaults to `"/storage"`).
   * @returns Generated WHATWG `Response`.
   */
  async handleRequest(req: Request, prefix = "/storage"): Promise<Response> {
    try {
      return await this.routeRequest(req, prefix);
    } catch (err) {
      // Security/validation errors carry their own status (403, 413, 409…); anything
      // else is an internal failure whose message must not leak to the client.
      if (err instanceof StorageError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      console.error("[YATTA Storage] Unhandled error:", err);
      return Response.json(
        { error: "Internal storage error" },
        { status: 500 },
      );
    }
  }

  /**
   * Serves a stored file. Active content types (HTML, SVG, XML, JS) are forced to download
   * so user uploads can never execute script on the application's origin.
   */
  private serveFile(file: StorageFile, req: Request): Response {
    const active =
      /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)\b/i.test(
        file.contentType,
      );
    return active
      ? file.serve(req, { disposition: "attachment" })
      : file.serve(req);
  }

  private async routeRequest(req: Request, prefix: string): Promise<Response> {
    const url = new URL(req.url);
    const cleanPrefix = prefix.replace(/\/+$/, "");
    if (
      url.pathname !== cleanPrefix &&
      !url.pathname.startsWith(`${cleanPrefix}/`)
    ) {
      return Response.json({ error: "Route Not Found" }, { status: 404 });
    }
    const subpath = url.pathname.slice(cleanPrefix.length);
    const method = req.method.toUpperCase();

    // Keys are normalised BEFORE the authorizer sees them. Otherwise a policy such as
    // `key.startsWith("user123/")` is bypassed by "user123/../admin/x", which the storage
    // layer later resolves to "admin/x". Without an authorizer only reads are allowed:
    // list/upload/delete/sign must be opted into by configuring `authorize`.
    const authCheck = async (
      action: StorageAction,
      key?: string,
    ): Promise<Response | null> => {
      const safeKey = key === undefined ? undefined : sanitizeKey(key);
      if (!this.authorizer) {
        if (action === "read") return null;
        return Response.json(
          {
            error: `"${action}" is disabled: configure an 'authorize' callback to enable it`,
          },
          { status: 403 },
        );
      }
      const allowed = await this.authorizer({
        request: req,
        action,
        key: safeKey,
        disk: this.defaultDiskName,
      });
      if (!allowed) {
        return Response.json(
          { error: "Access Denied: Unauthorized storage action" },
          { status: 403 },
        );
      }
      return null;
    };

    // 1. Dashboard Root
    if (subpath === "" || subpath === "/") {
      const forbidden = await authCheck("read");
      if (forbidden) return forbidden;
      return this.renderUI({ mountPath: cleanPrefix });
    }

    // 2. REST API: List Files
    if (subpath === "/api/files" && method === "GET") {
      const forbidden = await authCheck("list");
      if (forbidden) return forbidden;

      const files = await this.defaultDisk.list();
      return Response.json(files);
    }

    // 3. REST API: Upload File
    if (subpath === "/api/upload" && method === "POST") {
      // Reject unauthorised callers before buffering a multipart body, then re-check
      // against the concrete key once it is known.
      const preAuth = await authCheck("write");
      if (preAuth) return preAuth;

      const maxBytes = parseSize(
        this.defaultDisk.securityConfig?.maxUploadSize,
      );
      /*
       * A missing Content-Length is unknown, not zero. `Number(null)` is 0, so
       * a chunked upload passed this check and `formData()` then buffered the
       * whole body in memory before the size limit rejected it — the request
       * ended in a 413 with the memory already spent. Chunked bodies are capped
       * while they are read instead.
       */
      const rawLength = req.headers.get("content-length");
      const declared = rawLength === null ? undefined : Number(rawLength);

      if (declared !== undefined) {
        if (!Number.isFinite(declared)) {
          return Response.json({ error: "Invalid Content-Length" }, { status: 400 });
        }
        if (declared > maxBytes + 1024 * 1024) {
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }
      }

      // Bound the body as it streams in, so an undeclared or dishonest length
      // cannot be used to allocate without limit.
      const form = await (declared === undefined
        ? req
        : new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: createCappedStream(req.body!, maxBytes + 1024 * 1024),
            // @ts-expect-error — Bun requires this when a body is supplied.
            duplex: "half",
          })
      ).formData();
      const file = form.get("file");
      const rawPath = form.get("path");
      const pathParam =
        typeof rawPath === "string" && rawPath
          ? rawPath
          : file instanceof File
            ? file.name
            : `file-${Date.now()}`;

      const forbidden = await authCheck("write", pathParam);
      if (forbidden) return forbidden;

      if (!file || typeof file === "string") {
        return Response.json(
          { error: "Missing multipart file payload" },
          { status: 400 },
        );
      }

      const result = await this.defaultDisk.upload(pathParam, file);
      return Response.json(result, { status: 201 });
    }

    // 4. REST API: Delete File
    if (subpath === "/api/files" && method === "DELETE") {
      const key = url.searchParams.get("path");
      if (!key)
        return Response.json(
          { error: "Missing path parameter" },
          { status: 400 },
        );

      const forbidden = await authCheck("delete", key);
      if (forbidden) return forbidden;

      await this.defaultDisk.delete(key);
      return Response.json({ success: true, deleted: key });
    }

    // 5. REST API: Sign URL
    if (subpath === "/api/signed" && method === "GET") {
      const key = url.searchParams.get("path");
      if (!key)
        return Response.json(
          { error: "Missing path parameter" },
          { status: 400 },
        );

      const forbidden = await authCheck("sign", key);
      if (forbidden) return forbidden;

      const signed = await this.defaultDisk.signedUrl(key, { expiresIn: "1h" });
      return Response.json({ url: signed });
    }

    // 6. Signed Local File Verification (CHECKED STRICTLY BEFORE WILDCARD FILE ROUTE)
    if (subpath === "/files/signed") {
      const key = url.searchParams.get("path");
      const exp = Number(url.searchParams.get("exp"));
      const sig = url.searchParams.get("sig") || "";
      const signedMethod = (
        url.searchParams.get("method") || "GET"
      ).toUpperCase();
      // Content-Type is part of a PUT signature, so it has to come back out of
      // the query and be verified rather than merely passed through.
      const signedContentType = url.searchParams.get("ct") ?? undefined;

      if (!key) {
        return Response.json(
          { error: "Missing path parameter" },
          { status: 400 },
        );
      }

      // This endpoint is only meaningful for HMAC-signed local URLs. S3 disks hand out
      // provider presigned URLs; falling through here would serve the file with no check.
      const driver = this.defaultDisk.driver;
      if (!(driver instanceof LocalStorageDriver)) {
        return Response.json({ error: "Route Not Found" }, { status: 404 });
      }

      // The method is part of the signature, so the real request must use it too
      // (a PUT-signed URL must not double as a read token, and vice versa).
      const methodOk =
        signedMethod === "GET"
          ? method === "GET" || method === "HEAD"
          : signedMethod === "PUT" && method === "PUT";
      if (
        !methodOk ||
        !driver.verifySignedUrl(key, exp, sig, signedMethod, signedContentType)
      ) {
        return Response.json(
          { error: "Invalid, tampered, or expired signed URL token" },
          { status: 403 },
        );
      }

      if (signedMethod === "PUT") {
        if (!req.body) {
          return Response.json(
            { error: "Missing request body" },
            { status: 400 },
          );
        }
        const requestContentType = req.headers.get("content-type") ?? undefined;

        // The signature already proved the type the URL was issued for; a body
        // arriving as something else is not that object.
        if (
          signedContentType &&
          requestContentType &&
          requestContentType !== signedContentType
        ) {
          return Response.json(
            { error: "Content-Type does not match the signed URL" },
            { status: 403 },
          );
        }

        const result = await this.defaultDisk.upload(key, req.body, {
          contentType: signedContentType ?? requestContentType,
        });
        return Response.json(result, { status: 201 });
      }

      try {
        const file = await this.defaultDisk.download(key);
        return this.serveFile(file, req);
      } catch (err) {
        if (err instanceof FileNotFoundError) {
          return Response.json({ error: "File not found" }, { status: 404 });
        }
        throw err;
      }
    }

    // 7. Direct Streaming Route
    if (subpath.startsWith("/files/")) {
      if (method !== "GET" && method !== "HEAD") {
        return Response.json(
          { error: "Method Not Allowed" },
          { status: 405, headers: { Allow: "GET, HEAD" } },
        );
      }

      let key: string;
      try {
        key = decodeURIComponent(subpath.slice("/files/".length));
      } catch {
        return Response.json(
          { error: "Malformed URL encoding" },
          { status: 400 },
        );
      }

      // `security.signedUrls`: direct access is disabled; only signed URLs work.
      if (this.defaultDisk.securityConfig?.signedUrls) {
        return Response.json(
          { error: "Direct access disabled: use a signed URL" },
          { status: 403 },
        );
      }

      const forbidden = await authCheck("read", key);
      if (forbidden) return forbidden;

      try {
        const file = await this.defaultDisk.download(key);
        return this.serveFile(file, req);
      } catch (err) {
        if (err instanceof FileNotFoundError) {
          return Response.json({ error: "File not found" }, { status: 404 });
        }
        throw err;
      }
    }

    return Response.json({ error: "Route Not Found" }, { status: 404 });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 9. Singleton Factory & Ambient Proxy
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_STORAGE_KEY = Symbol.for("yatta.storage.default");
const globalScope = globalThis as unknown as {
  [GLOBAL_STORAGE_KEY]?: StorageManager;
};

/**
 * Factory function creating and registering a configured {@link StorageManager} instance.
 *
 * @param config Single disk or multi-disk configuration options.
 * @returns Configured {@link StorageManager} instance.
 *
 * @example
 * ```ts
 * import { createStorage } from "./storage";
 *
 * export const storage = createStorage({
 *   default: "local",
 *   disks: {
 *     local: { driver: "local", baseDir: "./uploads" },
 *   },
 * });
 * ```
 */
export function createStorage(config?: StorageConfig): StorageManager {
  const cfg = config ?? {
    driver: "local",
    baseDir: "./storage",
  };
  const manager = new StorageManager(cfg);
  globalScope[GLOBAL_STORAGE_KEY] = manager;
  return manager;
}

function getDefaultStorage(): StorageManager {
  if (!globalScope[GLOBAL_STORAGE_KEY]) {
    globalScope[GLOBAL_STORAGE_KEY] = new StorageManager({
      driver: "local",
      baseDir: "./storage",
    });
  }
  return globalScope[GLOBAL_STORAGE_KEY]!;
}

/**
 * Ambient proxy type combining {@link StorageManager} and {@link StorageDisk} methods.
 */
export type StorageProxy = StorageManager & StorageDisk;

/**
 * 100% Type-Safe English Fluent Unified Storage Operating Layer for Bun.
 *
 * Exposes multi-disk management combined with direct methods targeting the default disk.
 *
 * @example
 * ```ts
 * // 1. Fluent put and write
 * await Storage.file("avatars/user.png").put(file);
 *
 * // 2. Content-Addressing & Unique Naming
 * await Storage.put("reports/annual.pdf").from(stream).hashName().save();
 *
 * // 3. Smart HTTP Delivery (RFC 9110 Range & 304s)
 * export default {
 *   fetch: (req) => Storage.file("video.mp4").serve(req),
 * };
 *
 * // 4. Virtual Folder Scopes
 * const folder = Storage.folder("users/123");
 * await folder.file("profile.json").write({ active: true });
 * ```
 */
export const Storage: StorageProxy = new Proxy(
  function () {} as unknown as StorageProxy,
  {
    get(_target, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_target, prop, receiver);
      }
      const manager = getDefaultStorage();

      if (prop in manager) {
        const val = (manager as any)[prop];
        return typeof val === "function" ? val.bind(manager) : val;
      }

      const defaultDisk = manager.defaultDisk;
      const val = (defaultDisk as any)[prop];
      return typeof val === "function" ? val.bind(defaultDisk) : val;
    },
  },
);
