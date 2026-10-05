/**
 * ============================================================================
 *  YATTA MAIL — Fast, Type-Safe, Hardened Mail Engine for Bun & TypeScript
 * ============================================================================
 *
 *  OVERVIEW:
 *  Production-ready email dispatch engine featuring CRLF header-injection sanitization,
 *  XSS-safe Markdown parsing, templating with pipe transformations (e.g. `{{ amount | currency:USD }}`),
 *  layouts, automated plain-text fallback generation, RFC 8058 One-Click Unsubscribe,
 *  idempotency keys, rate limiting, and an in-memory transport with fluent test assertions.
 *
 *  KEY EXPORTS:
 *  - `createMailer(config)`: Factory returning a `YattaMailer` instance.
 *  - `YattaMailer`: Mail engine facade providing:
 *    - `.send(options)`: Compiles templates, attaches layouts, and dispatches email.
 *    - `.registerTemplate(name, config)`: Defines reusable email templates with typing.
 *    - `.registerLayout(name, html)`: Defines reusable HTML layout wrappers.
 *    - `.preview(options)`: Renders HTML/plain-text output without sending.
 *    - Test Helpers (in `mode: "memory"`):
 *      - `.sent()`: Array of sent emails.
 *      - `.lastSent()`, `.sentCount()`, `.findSent(predicate)`, `.clearSent()`, `.reset()`.
 *  - Transports: SMTP, Resend, Postmark, SendGrid, SES, Gmail, Terminal (console), Memory (tests).
 *
 *  MODULE AUGMENTATION:
 *  ```ts
 *  declare module "../types/mail" {
 *    interface MailRegister {
 *      templates: {
 *        welcome: { name: string; verifyUrl: string };
 *      };
 *    }
 *  }
 *  ```
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { createMailer } from "../types/mail";
 *
 *  export const mailer = createMailer({
 *    mode: process.env.NODE_ENV === "production" ? "smtp" : "terminal",
 *    defaultFrom: "Yatta <noreply@yatta.dev>",
 *  });
 *
 *  // Send transactional email
 *  await mailer.send({
 *    to: "user@example.com",
 *    subject: "Welcome to Yatta!",
 *    template: "welcome",
 *    data: { name: "Alice", verifyUrl: "https://yatta.dev/verify?token=abc" },
 *  });
 *  ```
 */

import nodemailer, {
  type Transporter,
  type SendMailOptions,
  type Attachment,
} from "nodemailer";
import crypto from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────
// 0. Errors, Types & Registry
// ──────────────────────────────────────────────────────────────────────────

/**
 * Base exception thrown by the Yatta Mail engine during validation, rendering, or dispatch errors.
 *
 * @example
 * ```ts
 * try {
 *   await mailer.send({ to: "invalid-email", subject: "Hello" });
 * } catch (error) {
 *   if (error instanceof YattaMailError) {
 *     console.error("Mail error:", error.message, error.details);
 *   }
 * }
 * ```
 */
export class YattaMailError extends Error {
  /**
   * Creates a new YattaMailError.
   *
   * @param message Human-readable error message.
   * @param details Optional diagnostic details or underlying error.
   */
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "YattaMailError";
  }
}

/**
 * Utility type expanding nested object properties for clearer IDE IntelliSense previews.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Global interface mergeable by application code for template type safety.
 *
 * @example
 * ```ts
 * declare module "../types/mail" {
 *   interface MailRegister {
 *     templates: {
 *       welcome: { name: string; verifyUrl: string };
 *       resetPassword: { email: string; token: string; expiresMinutes: number };
 *     };
 *   }
 * }
 * ```
 */
export interface MailRegister {}

/**
 * Extracts registered template data contracts from {@link MailRegister}, or falls back to any object map.
 */
export type RegisteredTemplates = MailRegister extends {
  templates: infer T extends Record<string, Record<string, unknown>>;
}
  ? T
  : Record<string, Record<string, unknown>>;

/**
 * Represents an email recipient or sender, either as a plain address string or an object with display name.
 *
 * @example `"alice@example.com"`
 * @example `{ name: "Alice Smith", address: "alice@example.com" }`
 */
export type EmailAddress = string | { name?: string; address: string };

/**
 * A single recipient address or an array of recipient addresses.
 */
export type RecipientInput = EmailAddress | readonly EmailAddress[];

/**
 * Email urgency level controlling client presentation and priority headers.
 */
export type MailPriority = "high" | "normal" | "low";

/**
 * Email attachment specification supporting file paths, in-memory buffers/strings, and embedded inline images.
 */
export interface MailerAttachment {
  /** Display filename for the attachment (e.g. `"invoice.pdf"`). */
  filename?: string;
  /** In-memory content payload as a string, Buffer, or Uint8Array. */
  content?: string | Buffer | Uint8Array;
  /** Filesystem path to stream the attachment from. */
  path?: string;
  /** Explicit MIME content type (e.g. `"application/pdf"`, `"image/png"`). */
  contentType?: string;
  /** Content-ID for embedding inline images in HTML templates (`<img src="cid:logo"/>`). */
  cid?: string;
  /** Content transfer encoding (e.g. `"base64"`). */
  encoding?: string;
}

/**
 * Structured logger interface for mail delivery operations and debugging.
 */
export interface MailLogger {
  /** Log diagnostic or low-level trace messages. */
  debug(...args: unknown[]): void;
  /** Log informational delivery notices. */
  info(...args: unknown[]): void;
  /** Log operational warnings. */
  warn(...args: unknown[]): void;
  /** Log delivery and runtime errors. */
  error(...args: unknown[]): void;
}

/**
 * Aggregated operational metrics and delivery statistics tracked by {@link YattaMailer}.
 */
export interface MailStats {
  /** Total count of successfully accepted email dispatches. */
  sent: number;
  /** Total count of failed deliveries that exhausted all retries. */
  failed: number;
  /** Total count of recipients explicitly rejected by SMTP relays. */
  rejected: number;
  /** Total count of retry attempts executed due to transient delivery errors. */
  retries: number;
  /** Total count of background asynchronous deliveries queued. */
  queued: number;
  /** Total count of emails processed in dryRun mode without network transmission. */
  dryRun: number;
  /** Cumulative milliseconds spent in SMTP network transmission. */
  totalDeliveryTimeMs: number;
  /** Average milliseconds spent per successful email delivery. */
  averageDeliveryTimeMs: number;
}

/**
 * Lifecycle hook callbacks executed at various stages of email compilation, transmission, and error handling.
 */
export interface MailHooks {
  /** Invoked when an email is enqueued for background dispatch via `.sendAsync()` or `.defer()`. */
  onQueued?: (mail: SendMailOptions) => void | Promise<void>;
  /** Invoked immediately prior to attempting network transmission. */
  beforeSend?: (mail: SendMailOptions) => void | Promise<void>;
  /** Invoked after an email has been successfully accepted by the transport. */
  afterSend?: (result: SendResult, mail: SendMailOptions) => void | Promise<void>;
  /** Invoked when delivery permanently fails after exhausting all retries. */
  onError?: (error: Error, mail: SendMailOptions) => void | Promise<void>;
  /** Invoked when a transient delivery error triggers a retry attempt with backoff delay. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Supported built-in email provider presets.
 */
export type MailProvider =
  | "smtp"
  | "gmail"
  | "resend"
  | "postmark"
  | "sendgrid"
  | "mailgun"
  | "brevo"
  | "ses";

/**
 * Connection presets mapping provider names to default host, port, and TLS settings.
 */
export const PROVIDER_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
  resend: { host: "smtp.resend.com", port: 465, secure: true },
  postmark: { host: "smtp.postmarkapp.com", port: 587, secure: false },
  sendgrid: { host: "smtp.sendgrid.net", port: 587, secure: false },
  mailgun: { host: "smtp.mailgun.org", port: 587, secure: false },
  brevo: { host: "smtp-relay.brevo.com", port: 587, secure: false },
  ses: { host: "email-smtp.us-east-1.amazonaws.com", port: 465, secure: true },
};

/**
 * Rate limiting and concurrency controls for outbound email dispatch.
 */
export interface MailRateLimitOptions {
  /** Maximum messages allowed within the time window (default: unlimited). */
  max?: number;
  /** Rolling time window in milliseconds for token refill (default: `1000` ms). */
  windowMs?: number;
  /** Maximum concurrent SMTP deliveries allowed simultaneously (default: `5`). */
  maxConcurrency?: number;
}

/**
 * Options configuring the {@link YattaMailer} instance.
 */
export interface MailerOptions<TTemplates extends Record<string, any> = RegisteredTemplates> {
  /** Preset provider: `"gmail" | "resend" | "postmark" | "sendgrid" | "mailgun" | "brevo" | "ses"`. */
  provider?: MailProvider;
  /** SMTP Host (defaults to `process.env.YATTA_MAIL_HOST` or `SMTP_HOST`). */
  host?: string;
  /** SMTP Port (defaults to `process.env.YATTA_MAIL_PORT` or `SMTP_PORT` or `587`). */
  port?: number;
  /** Use TLS/SSL (defaults to true if port is 465). */
  secure?: boolean;
  /** SMTP Authentication credentials. */
  auth?: {
    /** Username or API key. */
    user: string;
    /** Password or secret token. */
    pass: string;
  };
  /** Default sender address applied when `.from()` is omitted. */
  defaultFrom?: EmailAddress;
  /** Delivery mode: `"smtp"` (live network), `"ethereal"` (test inbox preview), `"terminal"` (console log), `"memory"` (unit tests). */
  mode?: "smtp" | "ethereal" | "terminal" | "memory";
  /** Maximum retry attempts for transient delivery failures (0-10, default: 3). */
  retries?: number;
  /** When enabled, messages are compiled, logged, and validated without sending over network. */
  dryRun?: boolean;
  /** In-line templates definition for direct type inference. */
  templates?: Record<string, TemplateRenderer<any>>;
  /** In-line layouts definition. */
  layouts?: Record<string, string>;
  /** Maximum allowable attachment byte size (default: 10MB). */
  maxAttachmentSize?: number;
  /** Maximum count of attachments per email (default: 10). */
  maxAttachments?: number;
  /** Built-in rate limiting and concurrency options. */
  rateLimit?: MailRateLimitOptions;
  /** Custom structured logger instance. */
  logger?: MailLogger;
  /** Lifecycle hooks for intercepting email dispatch events. */
  hooks?: MailHooks;
}

/**
 * Result returned upon sending or previewing an email.
 */
export interface SendResult {
  /** Unique message identifier assigned by transport or SMTP relay. */
  messageId: string;
  /** List of recipient addresses accepted by the relay. */
  accepted: string[];
  /** List of recipient addresses rejected by the relay. */
  rejected: string[];
  /** Whether the delivery encountered rejection or failures. */
  failed: boolean;
  /** Web URL for previewing test emails in `"ethereal"` development mode. */
  previewUrl?: string | false;
  /** Raw response object returned by underlying Nodemailer transport. */
  raw?: unknown;
}

/**
 * Record of an email captured in-memory during tests in `"memory"` mode.
 */
export interface SentMemoryEmail {
  /** Nodemailer send options compiled for this email. */
  options: SendMailOptions;
  /** Timestamp when the email was recorded in memory. */
  sentAt: Date;
}

/**
 * Direct options passed to {@link YattaMailer.send} for one-shot delivery without fluent builder.
 */
export interface DirectSendOptions<
  TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates,
  K extends keyof TTemplates = keyof TTemplates
> {
  /** Sender address override. */
  from?: EmailAddress;
  /** Primary recipient(s). */
  to: RecipientInput;
  /** Carbon copy (CC) recipient(s). */
  cc?: RecipientInput;
  /** Blind carbon copy (BCC) recipient(s). */
  bcc?: RecipientInput;
  /** Reply-To email address. */
  replyTo?: EmailAddress;
  /** Email subject line. */
  subject?: string;
  /** Plain text email body. */
  text?: string;
  /** HTML email body. */
  html?: string;
  /** Markdown text converted to HTML with automated plain-text fallback. */
  markdown?: string;
  /** Name of registered template to render. */
  template?: K;
  /** Data variables passed to template renderer. */
  data?: TTemplates[K];
  /** Layout template name wrapping the rendered HTML content. */
  layout?: string;
  /** Attachments list. */
  attachments?: MailerAttachment[];
  /** Custom MIME headers (e.g. `X-Custom-Header`). */
  headers?: Record<string, string>;
  /** Delivery priority. */
  priority?: MailPriority;
  /** Deduplication key preventing duplicate delivery via `X-Idempotency-Key`. */
  idempotencyKey?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Security & Sanitization Utilities
// ──────────────────────────────────────────────────────────────────────────

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Asserts that a string does not contain Carriage Return (`\r`) or Line Feed (`\n`) characters.
 * Prevents SMTP header injection attacks (e.g. injecting extra BCC, To, or Subject headers).
 *
 * @param value String value to validate.
 * @param fieldName Descriptive field name for error reporting.
 * @throws {@link YattaMailError} If CRLF characters are present.
 *
 * @example
 * ```ts
 * assertNoCrlf("Subject line", "Subject"); // Passes
 * assertNoCrlf("Subject\nBcc: hacker@evil.com", "Subject"); // Throws YattaMailError
 * ```
 */
export function assertNoCrlf(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new YattaMailError(
      `Header injection detected: "${fieldName}" cannot contain CR or LF characters.`,
    );
  }
}

/**
 * Validates that an email address is syntactically well-formed according to RFC 5322 standards
 * and free of CRLF header injection vectors in both display name and address fields.
 *
 * @param address Email address string or `{ name, address }` object.
 * @throws {@link YattaMailError} If the address format is invalid or contains CRLF characters.
 *
 * @example
 * ```ts
 * validateEmailAddress("user@example.com");
 * validateEmailAddress({ name: "Alice", address: "alice@example.com" });
 * ```
 */
export function validateEmailAddress(address: EmailAddress): void {
  const email = typeof address === "string" ? address : address.address;
  const name = typeof address === "string" ? undefined : address.name;

  if (name) {
    assertNoCrlf(name, "Recipient/Sender Name");
  }

  assertNoCrlf(email, "Email Address");

  const clean = email.trim();
  if (!clean || clean.length > 254 || !EMAIL_REGEX.test(clean)) {
    throw new YattaMailError(`Invalid email address: "${clean}"`);
  }
}

/**
 * Validates and sanitizes a URL string, restricting allowed protocols to safe schemes
 * (`http:`, `https:`, `mailto:`, `tel:`). Protects against `javascript:` and `data:` URI exploits.
 *
 * @param url Candidate URL string.
 * @returns Safe URL href if valid, or a safe fallback anchor (`"#unsafe-url"` or `"#invalid-url"`).
 *
 * @example
 * ```ts
 * sanitizeUrl("https://example.com/confirm"); // "https://example.com/confirm"
 * sanitizeUrl("javascript:alert(1)"); // "#unsafe-url"
 * ```
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol)) {
      return parsed.href;
    }
    return "#unsafe-url";
  } catch {
    return "#invalid-url";
  }
}

/**
 * Escapes HTML control characters (`&`, `<`, `>`, `"`, `'`) in dynamic text values to prevent XSS.
 *
 * @param value Dynamic value to escape.
 * @returns Safe HTML string with entities encoded.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Safe Markdown Parser & Smart HTML-to-Text Generator
// ──────────────────────────────────────────────────────────────────────────

/**
 * XSS-Safe Markdown-to-HTML parser designed for email client compatibility.
 * Dynamically escapes all text content prior to formatting and validates link URL protocols.
 *
 * Features:
 * - Code blocks (triple backticks) with styled `<pre><code>` containers.
 * - Headings (`#`, `##`, `###`) with responsive inline styling.
 * - Blockquotes (`> text`) with styled margins and borders.
 * - Inline formatting (`**bold**`, `*italic*`, `` `code` ``).
 * - Sanitized hyperlinks (`[label](url)`).
 * - Automatic paragraph formatting and line-breaks.
 *
 * @param md Markdown source string.
 * @returns Sanitized inline HTML string suitable for email rendering.
 *
 * @example
 * ```ts
 * const html = markdownToHtml("# Welcome\n\nVisit [our site](https://example.com)!");
 * ```
 */
export function markdownToHtml(md: string): string {
  const normalized = md.replace(/\r\n/g, "\n");

  // Placeholders for protected code blocks
  const codeBlocks: string[] = [];
  const processed = normalized.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre style="background:#f4f4f5;padding:12px;border-radius:6px;overflow-x:auto;"><code>${escapeHtml(code.trim())}</code></pre>`,
    );
    return `__CODE_BLOCK_${idx}__`;
  });

  // Pre-escape remaining markdown text to eliminate HTML injection
  let out = escapeHtml(processed);

  // Headers
  out = out.replace(/^### (.*$)/gim, '<h3 style="margin:16px 0 8px;">$1</h3>');
  out = out.replace(/^## (.*$)/gim, '<h2 style="margin:20px 0 8px;">$1</h2>');
  out = out.replace(/^# (.*$)/gim, '<h1 style="margin:24px 0 12px;">$1</h1>');

  // Blockquotes
  out = out.replace(
    /^&gt;\s+(.+)$/gm,
    '<blockquote style="border-left:4px solid #e4e4e7;padding-left:12px;color:#71717a;margin:8px 0;">$1</blockquote>',
  );

  // Inline formatting
  out = out.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*(.*?)\*/g, "<em>$1</em>");
  out = out.replace(/`([^`]+)`/g, '<code style="background:#f4f4f5;padding:2px 4px;border-radius:4px;">$1</code>');

  // Links with protocol sanitization
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = sanitizeUrl(href);
    return `<a href="${safe}" style="color:#2563eb;text-decoration:underline;">${label}</a>`;
  });

  // Restore code blocks
  out = out.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)] ?? "");

  // Paragraphs
  const paragraphs = out.split(/\n{2,}/);
  return paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<h") || trimmed.startsWith("<pre") || trimmed.startsWith("<block")) {
        return trimmed;
      }
      return `<p style="margin:0 0 12px;line-height:1.5;">${trimmed.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
}

/**
 * Intelligent HTML-to-Plain-Text converter.
 * Preserves link targets, lists, and headings for CLI email clients and accessibility.
 *
 * @param html HTML source content.
 * @returns Clean plain text representation with preserved formatting structure.
 *
 * @example
 * ```ts
 * const text = htmlToText("<h1>Notice</h1><p>Visit <a href='https://foo.bar'>here</a>.</p>");
 * // "=== Notice ===\n\nVisit here (https://foo.bar)."
 * ```
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<a(?:\s+[^>]*)?\s+href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
      return cleanLabel && cleanLabel !== href ? `${cleanLabel} (${href})` : href;
    })
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "  • $1\n")
    .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, "\n\n=== $1 ===\n\n")
    .replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, "\n\n--- $1 ---\n\n")
    .replace(/<hr\s*[\/]?>/gi, "\n----------------------------------------\n")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');

  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Template Interpolation with Helper Pipes
// ──────────────────────────────────────────────────────────────────────────

/**
 * Transformation function for template interpolation pipes (e.g. `{{ amount | currency:USD }}`).
 *
 * @param value Input value from data object.
 * @param arg Optional argument passed after the colon in the pipe definition.
 * @returns Formatted output string.
 */
export type TemplateHelper = (value: unknown, arg?: string) => string;

/**
 * Default built-in template helper pipes available in all templates and layouts.
 *
 * - `uppercase`: Converts text to upper case (`{{ name | uppercase }}`).
 * - `lowercase`: Converts text to lower case (`{{ name | lowercase }}`).
 * - `trim`: Trims whitespace from both ends.
 * - `json`: Formats object as formatted JSON (`{{ data | json }}`).
 * - `date`: Formats date object or timestamp string using locale date formatting (`{{ createdAt | date }}`).
 * - `currency`: Formats numeric amounts using `Intl.NumberFormat` (`{{ price | currency:USD }}`).
 */
export const DEFAULT_HELPERS: Record<string, TemplateHelper> = {
  uppercase: (v) => String(v ?? "").toUpperCase(),
  lowercase: (v) => String(v ?? "").toLowerCase(),
  trim: (v) => String(v ?? "").trim(),
  json: (v) => JSON.stringify(v, null, 2),
  date: (v) => {
    if (!v) return "";
    const d = v instanceof Date ? v : new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
  },
  currency: (v, currency = "USD") => {
    const num = Number(v);
    if (isNaN(num)) return String(v ?? "");
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(num);
    } catch {
      return `$${num.toFixed(2)}`;
    }
  },
};

/**
 * Interpolates variables into a template string supporting pipes and escaping.
 *
 * Syntax:
 * - `{{ expression | helper:arg }}`: HTML-escapes output to prevent XSS.
 * - `{{{ rawHtml }}}`: Preserves raw unescaped HTML.
 *
 * @param templateStr Raw template string.
 * @param data Variables object.
 * @param helpers Registered template helpers dictionary.
 * @returns Interpolated and formatted output string.
 *
 * @example
 * ```ts
 * const out = interpolate(
 *   "Hello {{ user.name | uppercase }}, your bill is {{ total | currency:EUR }}",
 *   { user: { name: "alice" }, total: 42.5 }
 * );
 * // "Hello ALICE, your bill is €42.50"
 * ```
 */
export function interpolate(
  templateStr: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper> = DEFAULT_HELPERS,
): string {
  // 1. Triple curlies {{{ rawHtml }}} -> raw unescaped output
  let out = templateStr.replace(/\{\{\{\s*([a-zA-Z0-9_.|:\s-]+)\s*\}\}\}/g, (_, expression) => {
    return resolveExpression(expression, data, helpers, false);
  });

  // 2. Double curlies {{ escaped }} -> HTML-escaped output
  out = out.replace(/\{\{\s*([a-zA-Z0-9_.|:\s-]+)\s*\}\}/g, (_, expression) => {
    return resolveExpression(expression, data, helpers, true);
  });

  return out;
}

function resolveExpression(
  expr: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>,
  shouldEscape: boolean,
): string {
  const parts = expr.split("|").map((p) => p.trim());
  const keyPath = parts[0]!;
  let value = resolveKeyPath(keyPath, data);

  // Apply pipes
  for (let i = 1; i < parts.length; i++) {
    const pipe = parts[i]!;
    const [helperName, arg] = pipe.split(":").map((s) => s.trim());
    const fn = helpers[helperName!];
    if (fn) {
      value = fn(value, arg);
    }
  }

  const str = value !== undefined && value !== null ? String(value) : "";
  return shouldEscape ? escapeHtml(str) : str;
}

function resolveKeyPath(path: string, data: Record<string, unknown>): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, data);
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Template & Builder Interfaces
// ──────────────────────────────────────────────────────────────────────────

/**
 * Output components produced by compiling or rendering an email template.
 */
export interface TemplateRenderResult {
  /** Optional subject line generated by the template. */
  subject?: string;
  /** Compiled HTML email body. */
  html: string;
  /** Optional plain-text fallback content. Generated automatically if omitted. */
  text?: string;
}

/**
 * Definition of an email template renderer.
 *
 * Supports three formats:
 * 1. Static object with template strings: `{ subject?, html, text?, layout? }`
 * 2. Object with `.render(data)` function and optional layout.
 * 3. Functional renderer callback: `(data: TData) => TemplateRenderResult`.
 */
export type TemplateRenderer<TData extends Record<string, unknown> = Record<string, unknown>> =
  | {
      subject?: string;
      html: string;
      text?: string;
      layout?: string;
    }
  | {
      render(data: TData): TemplateRenderResult;
      layout?: string;
    }
  | ((data: TData) => TemplateRenderResult);

// ──────────────────────────────────────────────────────────────────────────
// 5. Fluent MailBuilder DSL
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fluent email message builder DSL providing a clean, chainable API for composing and dispatching emails.
 *
 * @template TTemplates Registered templates map interface for typed template names and parameters.
 *
 * @example
 * ```ts
 * await mailer.compose()
 *   .to("alice@example.com")
 *   .subject("Welcome to Yatta!")
 *   .markdown("# Welcome\n\nThanks for signing up!")
 *   .send();
 * ```
 */
export class MailBuilder<TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates> {
  private _from?: EmailAddress;
  private _to: EmailAddress[] = [];
  private _cc: EmailAddress[] = [];
  private _bcc: EmailAddress[] = [];
  private _replyTo?: EmailAddress;
  private _subject?: string;
  private _text?: string;
  private _html?: string;
  private _layout?: string;
  private _templateName?: string;
  private _templateData?: Record<string, unknown>;
  private _attachments: MailerAttachment[] = [];
  private _priority: MailPriority = "normal";
  private _headers: Record<string, string> = {};
  private _idempotencyKey?: string;

  /**
   * Initializes a new MailBuilder instance linked to a {@link YattaMailer} engine.
   *
   * @param mailer Host mailer instance.
   */
  constructor(private readonly mailer: YattaMailer) {
    if (mailer.defaultFrom) {
      this._from = mailer.defaultFrom;
    }
  }

  /**
   * Sets the sender address for this message.
   *
   * @param address Sender email or `{ name, address }` object.
   * @returns Current builder for chaining.
   */
  from(address: EmailAddress): this {
    validateEmailAddress(address);
    this._from = address;
    return this;
  }

  /**
   * Appends primary recipient(s) to the email.
   *
   * @param recipients One or more email addresses or address arrays.
   * @returns Current builder for chaining.
   */
  to(...recipients: RecipientInput[]): this {
    return this.addRecipients(this._to, recipients);
  }

  /**
   * Fluent alias for {@link MailBuilder.to} to append primary recipients.
   *
   * @param recipients Recipient email addresses.
   * @returns Current builder for chaining.
   */
  andTo(...recipients: RecipientInput[]): this {
    return this.to(...recipients);
  }

  /**
   * Appends carbon copy (CC) recipient(s).
   *
   * @param recipients CC recipient email addresses.
   * @returns Current builder for chaining.
   */
  cc(...recipients: RecipientInput[]): this {
    return this.addRecipients(this._cc, recipients);
  }

  /**
   * Fluent alias for {@link MailBuilder.cc} to append CC recipients.
   *
   * @param recipients CC recipient email addresses.
   * @returns Current builder for chaining.
   */
  andCc(...recipients: RecipientInput[]): this {
    return this.cc(...recipients);
  }

  /**
   * Appends blind carbon copy (BCC) recipient(s).
   *
   * @param recipients BCC recipient email addresses.
   * @returns Current builder for chaining.
   */
  bcc(...recipients: RecipientInput[]): this {
    return this.addRecipients(this._bcc, recipients);
  }

  /**
   * Fluent alias for {@link MailBuilder.bcc} to append BCC recipients.
   *
   * @param recipients BCC recipient email addresses.
   * @returns Current builder for chaining.
   */
  andBcc(...recipients: RecipientInput[]): this {
    return this.bcc(...recipients);
  }

  /**
   * Sets the Reply-To address header.
   *
   * @param address Reply-To email address.
   * @returns Current builder for chaining.
   */
  replyTo(address: EmailAddress): this {
    validateEmailAddress(address);
    this._replyTo = address;
    return this;
  }

  /**
   * Sets the email subject line with CRLF injection validation.
   *
   * @param subject Subject line text.
   * @returns Current builder for chaining.
   */
  subject(subject: string): this {
    assertNoCrlf(subject, "Subject");
    this._subject = subject;
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.subject}.
   *
   * @param subject Subject line text.
   * @returns Current builder for chaining.
   */
  withSubject(subject: string): this {
    return this.subject(subject);
  }

  /**
   * Explicit override for the email subject line (e.g. replacing a template default subject).
   *
   * @param subject New subject line text.
   * @returns Current builder for chaining.
   */
  overrideSubject(subject: string): this {
    return this.subject(subject);
  }

  /**
   * Sets the plain text body content.
   *
   * @param text Plain text content.
   * @returns Current builder for chaining.
   */
  text(text: string): this {
    this._text = text;
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.text}.
   *
   * @param text Plain text content.
   * @returns Current builder for chaining.
   */
  withText(text: string): this {
    return this.text(text);
  }

  /**
   * Explicit override for plain text content.
   *
   * @param text Plain text content.
   * @returns Current builder for chaining.
   */
  overrideText(text: string): this {
    return this.text(text);
  }

  /**
   * Sets raw or pre-rendered HTML body content.
   *
   * @param html HTML source string.
   * @returns Current builder for chaining.
   */
  html(html: string): this {
    this._html = html;
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.html}.
   *
   * @param html HTML source string.
   * @returns Current builder for chaining.
   */
  withHtml(html: string): this {
    return this.html(html);
  }

  /**
   * Explicit override for HTML body content.
   *
   * @param html HTML source string.
   * @returns Current builder for chaining.
   */
  overrideHtml(html: string): this {
    return this.html(html);
  }

  /**
   * Converts Markdown text to XSS-safe HTML and generates plain-text fallback automatically.
   *
   * @param md Markdown source content.
   * @returns Current builder for chaining.
   *
   * @example
   * ```ts
   * builder.markdown("# Weekly Digest\n\nHere are this week's updates...");
   * ```
   */
  markdown(md: string): this {
    this._html = markdownToHtml(md);
    this._text = htmlToText(this._html);
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.markdown}.
   *
   * @param md Markdown source content.
   * @returns Current builder for chaining.
   */
  withMarkdown(md: string): this {
    return this.markdown(md);
  }

  /**
   * Specifies a registered layout template name to wrap around the rendered HTML body.
   *
   * @param name Name of registered layout.
   * @returns Current builder for chaining.
   */
  layout(name: string): this {
    this._layout = name;
    return this;
  }

  /**
   * Configures a registered template and its type-safe parameters to render for this email.
   *
   * @param name Registered template key.
   * @param data Typed parameter object matching template signature.
   * @returns Current builder for chaining.
   *
   * @example
   * ```ts
   * builder.template("welcome", { name: "Alice", verifyUrl: "https://..." });
   * ```
   */
  template<K extends keyof TTemplates>(name: K, data: TTemplates[K]): this {
    this._templateName = String(name);
    this._templateData = data as Record<string, unknown>;
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.template}.
   *
   * @param name Registered template key.
   * @param data Typed parameter object.
   * @returns Current builder for chaining.
   */
  withTemplate<K extends keyof TTemplates>(name: K, data: TTemplates[K]): this {
    return this.template(name, data);
  }

  /**
   * Selects an email template by name with untyped arbitrary dictionary data.
   *
   * @param name Template name string.
   * @param data Untyped parameters object.
   * @returns Current builder for chaining.
   */
  untypedTemplate(name: string, data: Record<string, unknown>): this {
    this._templateName = name;
    this._templateData = data;
    return this;
  }

  /**
   * Attaches a file or buffer to the message with size and format verification.
   *
   * @param attachment Attachment descriptor.
   * @returns Current builder for chaining.
   *
   * @example
   * ```ts
   * builder.attach({
   *   filename: "report.pdf",
   *   content: pdfBuffer,
   *   contentType: "application/pdf"
   * });
   * ```
   */
  attach(attachment: MailerAttachment): this {
    this.mailer.validateAttachment(attachment);
    this._attachments.push(attachment);
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.attach}.
   *
   * @param attachment Attachment descriptor.
   * @returns Current builder for chaining.
   */
  withAttachment(attachment: MailerAttachment): this {
    return this.attach(attachment);
  }

  /**
   * Attaches an array of files or buffers to the email.
   *
   * @param attachments Array of attachment descriptors.
   * @returns Current builder for chaining.
   */
  withAttachments(attachments: MailerAttachment[]): this {
    for (const a of attachments) this.attach(a);
    return this;
  }

  /**
   * Sets the delivery urgency priority (`"high"`, `"normal"`, `"low"`).
   *
   * @param level Urgency level.
   * @returns Current builder for chaining.
   */
  priority(level: MailPriority): this {
    this._priority = level;
    return this;
  }

  /**
   * Sets a deduplication idempotency key to prevent accidental duplicate dispatches.
   * Automatically configures `X-Idempotency-Key` and a deterministic SHA-256 `Message-ID`.
   *
   * @param key Unique idempotency token (e.g. invoice ID or order UUID).
   * @returns Current builder for chaining.
   */
  idempotencyKey(key: string): this {
    assertNoCrlf(key, "Idempotency-Key");
    this._idempotencyKey = key;
    return this;
  }

  /**
   * Sets a custom MIME header name and value with CRLF injection validation.
   *
   * @param name Header name (e.g. `"X-Campaign-ID"`).
   * @param value Header value.
   * @returns Current builder for chaining.
   */
  header(name: string, value: string): this {
    assertNoCrlf(name, "Header Name");
    assertNoCrlf(value, `Header "${name}"`);
    this._headers[name] = value;
    return this;
  }

  /**
   * Fluent alias for {@link MailBuilder.header}.
   *
   * @param name Header name.
   * @param value Header value.
   * @returns Current builder for chaining.
   */
  withHeader(name: string, value: string): this {
    return this.header(name, value);
  }

  /**
   * Sets the `In-Reply-To` header for threading replies to a specific previous email message ID.
   *
   * @param messageId Previous email Message-ID header value.
   * @returns Current builder for chaining.
   */
  inReplyTo(messageId: string): this {
    return this.header("In-Reply-To", messageId);
  }

  /**
   * Sets the `References` header for email conversation thread preservation.
   *
   * @param messageIds Sequence of prior Message-IDs.
   * @returns Current builder for chaining.
   */
  references(...messageIds: string[]): this {
    return this.header("References", messageIds.join(" "));
  }

  /**
   * Sets an explicit custom `Message-ID` header.
   *
   * @param id Message ID string (e.g. `"<custom-uuid@domain.com>"`).
   * @returns Current builder for chaining.
   */
  messageId(id: string): this {
    return this.header("Message-ID", id);
  }

  /**
   * Configures RFC 8058 One-Click Unsubscribe headers (`List-Unsubscribe` and `List-Unsubscribe-Post`).
   *
   * @param options Unsubscribe targets supporting URL endpoint and/or mailto recipient.
   * @returns Current builder for chaining.
   *
   * @example
   * ```ts
   * builder.unsubscribe({
   *   url: "https://example.com/unsubscribe?token=xyz",
   *   email: "unsub@example.com"
   * });
   * ```
   */
  unsubscribe(options: { url: string; email?: string }): this {
    const parts: string[] = [];
    if (options.email) {
      validateEmailAddress(options.email);
      parts.push(`<mailto:${options.email}>`);
    }
    if (options.url) {
      parts.push(`<${sanitizeUrl(options.url)}>`);
    }

    this.header("List-Unsubscribe", parts.join(", "));
    this.header("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
    return this;
  }

  private addRecipients(target: EmailAddress[], inputs: RecipientInput[]): this {
    for (const item of inputs) {
      const asArray = item as EmailAddress | readonly EmailAddress[] | undefined;
      if (Array.isArray(asArray)) {
        for (const addr of asArray as readonly EmailAddress[]) {
          validateEmailAddress(addr);
          target.push(addr);
        }
      } else if (asArray) {
        validateEmailAddress(asArray as EmailAddress);
        target.push(asArray as EmailAddress);
      }
    }
    return this;
  }

  /**
   * Compiles the email into standard SendMailOptions without dispatching.
   * Useful for inspection, unit testing, snapshot testing, and queuing.
   *
   * @returns Compiled Nodemailer `SendMailOptions`.
   * @throws {@link YattaMailError} If required fields (e.g. sender, recipient, subject) are missing.
   */
  build(): SendMailOptions {
    if (!this._from) {
      throw new YattaMailError(
        "Cannot send email without a sender. Use .from() or configure defaultFrom in createMailer().",
      );
    }

    if (this._to.length === 0) {
      throw new YattaMailError("Cannot send email without at least one recipient (.to()).");
    }

    if (this._attachments.length > this.mailer.maxAttachments) {
      throw new YattaMailError(
        `Email exceeds maximum allowed attachments limit of ${this.mailer.maxAttachments}.`,
      );
    }

    let resolvedHtml = this._html;
    let resolvedText = this._text;
    let resolvedSubject = this._subject;
    let templateLayout = this._layout;

    if (this._templateName) {
      const tpl = this.mailer.getTemplate(this._templateName);
      if (!tpl) {
        throw new YattaMailError(`Mail template "${this._templateName}" is not registered.`);
      }

      const data = this._templateData ?? {};

      if (typeof tpl === "function") {
        const res = tpl(data);
        if (!resolvedHtml) resolvedHtml = res.html;
        if (!resolvedText && res.text) resolvedText = res.text;
        if (!resolvedSubject && res.subject) resolvedSubject = res.subject;
      } else if ("render" in tpl && typeof tpl.render === "function") {
        const res = tpl.render(data);
        if (!resolvedHtml) resolvedHtml = res.html;
        if (!resolvedText && res.text) resolvedText = res.text;
        if (!resolvedSubject && res.subject) resolvedSubject = res.subject;
        if (!templateLayout && tpl.layout) templateLayout = tpl.layout;
      } else if (typeof tpl === "object" && "html" in tpl) {
        if (!resolvedHtml) resolvedHtml = interpolate(tpl.html, data, this.mailer.helpers);
        if (!resolvedText && tpl.text) resolvedText = interpolate(tpl.text, data, this.mailer.helpers);
        if (!resolvedSubject && tpl.subject) resolvedSubject = interpolate(tpl.subject, data, this.mailer.helpers);
        if (!templateLayout && tpl.layout) templateLayout = tpl.layout;
      }
    }

    // Apply layout if defined
    if (resolvedHtml && templateLayout) {
      const layoutHtml = this.mailer.getLayout(templateLayout);
      if (layoutHtml) {
        resolvedHtml = interpolate(
          layoutHtml,
          {
            content: resolvedHtml,
            body: resolvedHtml,
            subject: resolvedSubject ?? "",
            ...(this._templateData ?? {}),
          },
          this.mailer.helpers,
        );
      }
    }

    // Generate plain-text automatically if missing
    if (!resolvedText && resolvedHtml) {
      resolvedText = htmlToText(resolvedHtml);
    }

    if (!resolvedSubject) {
      throw new YattaMailError("Cannot send email without a subject. Provide .subject() or template subject.");
    }

    const headers = { ...this._headers };
    if (this._idempotencyKey) {
      headers["X-Idempotency-Key"] = this._idempotencyKey;
      if (!headers["Message-ID"]) {
        const hash = crypto.createHash("sha256").update(this._idempotencyKey).digest("hex");
        headers["Message-ID"] = `<idemp-${hash}@yatta.local>`;
      }
    }

    return {
      from: this._from,
      to: this._to.length === 1 ? this._to[0] : (this._to as any),
      cc: this._cc.length ? (this._cc.length === 1 ? this._cc[0] : (this._cc as any)) : undefined,
      bcc: this._bcc.length ? (this._bcc.length === 1 ? this._bcc[0] : (this._bcc as any)) : undefined,
      replyTo: this._replyTo,
      subject: resolvedSubject,
      text: resolvedText,
      html: resolvedHtml,
      attachments: this._attachments as Attachment[],
      priority: this._priority,
      headers: Object.keys(headers).length ? headers : undefined,
    };
  }

  /**
   * Compiles the email into standard SendMailOptions without dispatching. Alias for {@link MailBuilder.build}.
   */
  compile(): SendMailOptions {
    return this.build();
  }

  /**
   * Compiles and dispatches the email via the host mailer's configured transport.
   *
   * @returns Send result promise containing message ID and delivery status.
   */
  async send(): Promise<SendResult> {
    return this.mailer.dispatch(this.build());
  }

  /**
   * Fluent alias for {@link MailBuilder.send}.
   */
  async deliver(): Promise<SendResult> {
    return this.send();
  }

  /**
   * Preview compilation data without sending.
   *
   * @returns Compiled email preview details, including test preview URL when using `"ethereal"` mode.
   */
  async preview(): Promise<{
    subject: string;
    html: string;
    text: string;
    from: EmailAddress;
    to: EmailAddress | EmailAddress[];
    previewUrl?: string | false;
  }> {
    const built = this.build();
    let previewUrl: string | false = false;

    if (this.mailer.mode === "ethereal") {
      const res = await this.mailer.dispatch(built);
      previewUrl = res.previewUrl ?? false;
    }

    return {
      subject: built.subject!,
      html: String(built.html ?? ""),
      text: String(built.text ?? ""),
      from: built.from as unknown as EmailAddress,
      to: built.to as unknown as EmailAddress | EmailAddress[],
      previewUrl,
    };
  }

  /**
   * Dispatches asynchronously in the background and tracks execution within the host mailer instance.
   * Does not block the current request or handler.
   */
  async sendAsync(): Promise<void> {
    const mailOptions = this.build();
    this.mailer.trackBackgroundDelivery(mailOptions);
  }

  /**
   * Fire-and-forget background delivery with automated error logging.
   */
  defer(): void {
    this.sendAsync().catch((err) => {
      this.mailer.logger.error("[yatta-mail:defer] Background delivery error:", err);
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. YattaMailer Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hardened email dispatch engine featuring CRLF sanitization, XSS-safe Markdown parsing,
 * template rendering with pipe filters, layouts, rate-limiting, and multiple delivery transports.
 *
 * @template TTemplates Registered templates map interface for typed template names and parameters.
 *
 * @example
 * ```ts
 * const mailer = createMailer({
 *   mode: "smtp",
 *   host: "smtp.example.com",
 *   auth: { user: "smtp_user", pass: "smtp_pass" },
 *   defaultFrom: "No-Reply <noreply@example.com>"
 * });
 *
 * await mailer.to("user@example.com")
 *   .subject("Welcome")
 *   .markdown("Hello **User**!")
 *   .send();
 * ```
 */
export class YattaMailer<TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates> {
  private transporterPromise: Promise<Transporter> | null = null;
  private templates = new Map<string, TemplateRenderer<any>>();
  private layouts = new Map<string, string>();
  private helpersStore = new Map<string, TemplateHelper>(Object.entries(DEFAULT_HELPERS));
  private sentMemoryStorage: SentMemoryEmail[] = [];
  private backgroundPromises = new Set<Promise<SendResult>>();

  // Rate Limiting & Concurrency Queue
  private rateLimitTokens: number;
  private lastRateLimitRefill: number = Date.now();
  private activeConcurrentJobs: number = 0;
  private concurrencyWaiters: Array<() => void> = [];

  /** Default sender email address used when `.from()` is omitted. */
  readonly defaultFrom?: EmailAddress;
  /** Maximum retry attempts for transient delivery failures. */
  readonly retries: number;
  /** Active delivery mode (`"smtp"`, `"ethereal"`, `"terminal"`, `"memory"`). */
  readonly mode: "smtp" | "ethereal" | "terminal" | "memory";
  /** Whether dryRun mode is enabled (compiles and logs without sending). */
  readonly dryRun: boolean;
  /** Maximum allowable attachment byte size in bytes. */
  readonly maxAttachmentSize: number;
  /** Maximum number of attachments permitted per message. */
  readonly maxAttachments: number;
  /** Structured logger instance. */
  readonly logger: MailLogger;
  /** Lifecycle hook callbacks. */
  readonly hooks?: MailHooks;
  /** User-supplied configuration options. */
  readonly options: MailerOptions<TTemplates>;

  /** Operational metrics and delivery counters. */
  readonly metrics: MailStats = {
    sent: 0,
    failed: 0,
    rejected: 0,
    retries: 0,
    queued: 0,
    dryRun: 0,
    totalDeliveryTimeMs: 0,
    averageDeliveryTimeMs: 0,
  };

  /**
   * Initializes a new YattaMailer engine instance.
   *
   * @param options Configuration options for transports, credentials, defaults, and templates.
   */
  constructor(options: MailerOptions<TTemplates> = {}) {
    this.options = options;

    // Validate Retries
    const retries = options.retries ?? Number(process.env.YATTA_MAIL_RETRIES ?? 3);
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      throw new YattaMailError("options.retries must be an integer between 0 and 10.");
    }
    this.retries = retries;

    this.dryRun = options.dryRun ?? (process.env.YATTA_MAIL_DRY_RUN === "true" || process.env.DRY_RUN === "true");
    this.maxAttachmentSize = options.maxAttachmentSize ?? 10 * 1024 * 1024; // 10MB
    this.maxAttachments = options.maxAttachments ?? 10;
    this.hooks = options.hooks;

    this.rateLimitTokens = options.rateLimit?.max ?? Infinity;

    this.logger = options.logger ?? {
      debug: (...args) => console.debug("[yatta-mail:debug]", ...args),
      info: (...args) => console.log("[yatta-mail:info]", ...args),
      warn: (...args) => console.warn("[yatta-mail:warn]", ...args),
      error: (...args) => console.error("[yatta-mail:error]", ...args),
    };

    // Mode determination
    const isProd = process.env.NODE_ENV === "production";
    const envMode = (process.env.YATTA_MAIL_MODE ?? process.env.MAIL_MODE) as typeof this.mode | undefined;

    if (options.mode) {
      this.mode = options.mode;
    } else if (envMode) {
      this.mode = envMode;
    } else if (options.provider && options.provider !== "smtp") {
      this.mode = "smtp";
    } else if (options.host || process.env.YATTA_MAIL_HOST || process.env.SMTP_HOST) {
      this.mode = "smtp";
    } else if (isProd) {
      this.mode = "smtp";
    } else {
      this.mode = "ethereal";
    }

    // Default Sender Address Resolution
    const defaultFrom =
      options.defaultFrom ??
      process.env.YATTA_MAIL_FROM ??
      process.env.MAIL_FROM;

    if (isProd && !defaultFrom && this.mode === "smtp" && !this.dryRun) {
      throw new YattaMailError(
        "Default sender address (options.defaultFrom, YATTA_MAIL_FROM, or MAIL_FROM) is required in production.",
      );
    }
    this.defaultFrom = defaultFrom ?? "Yatta <no-reply@yatta.local>";

    // In-line template & layout registrations
    if (options.templates) {
      for (const [name, tpl] of Object.entries(options.templates)) {
        this.registerTemplate(name, tpl);
      }
    }
    if (options.layouts) {
      for (const [name, layout] of Object.entries(options.layouts)) {
        this.registerLayout(name, layout);
      }
    }
  }

  /**
   * Retrieves an object map of all registered template helper pipe functions.
   */
  get helpers(): Record<string, TemplateHelper> {
    return Object.fromEntries(this.helpersStore.entries());
  }

  /**
   * Registers a custom helper function for template interpolation pipes (e.g. `{{ value | customHelper:arg }}`).
   *
   * @param name Unique helper filter name.
   * @param helper Transformation function.
   * @returns Current mailer for chaining.
   *
   * @example
   * ```ts
   * mailer.registerHelper("discount", (price, percent) => {
   *   return `$${(Number(price) * (1 - Number(percent) / 100)).toFixed(2)}`;
   * });
   * ```
   */
  registerHelper(name: string, helper: TemplateHelper): this {
    assertNoCrlf(name, "Helper Name");
    this.helpersStore.set(name, helper);
    return this;
  }

  /**
   * Registers a reusable HTML layout template wrapper.
   * Layouts must include `{{{ content }}}` or `{{{ body }}}` token for dynamic injection.
   *
   * @param name Layout identifier name.
   * @param htmlTemplate HTML layout wrapper template string.
   * @returns Current mailer for chaining.
   *
   * @example
   * ```ts
   * mailer.registerLayout("main", `
   *   <html><body><header>Logo</header><main>{{{ body }}}</main><footer>Footer</footer></body></html>
   * `);
   * ```
   */
  registerLayout(name: string, htmlTemplate: string): this {
    this.layouts.set(name, htmlTemplate);
    return this;
  }

  /**
   * Retrieves a registered HTML layout template string by name.
   *
   * @param name Layout identifier name.
   * @returns Layout template string if found.
   */
  getLayout(name: string): string | undefined {
    return this.layouts.get(name);
  }

  /**
   * Registers an email template renderer.
   *
   * @param name Template name identifier.
   * @param renderer Template definition object or callback function.
   * @returns Current mailer for chaining.
   *
   * @example
   * ```ts
   * mailer.registerTemplate("welcome", {
   *   subject: "Welcome, {{ name }}!",
   *   html: "<h1>Welcome</h1><p>Click <a href='{{ verifyUrl }}'>here</a> to verify.</p>",
   *   layout: "main"
   * });
   * ```
   */
  registerTemplate<TData extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    renderer: TemplateRenderer<TData>,
  ): this {
    this.templates.set(name, renderer);
    return this;
  }

  /**
   * Retrieves a registered email template renderer by name.
   *
   * @param name Template name identifier.
   * @returns Template renderer if found.
   */
  getTemplate(name: string): TemplateRenderer<any> | undefined {
    return this.templates.get(name);
  }

  /**
   * Validates that all registered templates reference existing registered layout templates.
   *
   * @returns Validation result containing validity flag and error messages.
   */
  validateTemplates(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const [name, tpl] of this.templates.entries()) {
      if (typeof tpl === "object" && "layout" in tpl && tpl.layout) {
        if (!this.layouts.has(tpl.layout)) {
          errors.push(`Template "${name}" references missing layout "${tpl.layout}".`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Validates that an attachment specifies a valid source and does not exceed `maxAttachmentSize`.
   *
   * @param att Attachment descriptor.
   * @throws {@link YattaMailError} If the attachment is invalid or too large.
   */
  validateAttachment(att: MailerAttachment): void {
    if (!att.filename && !att.path && !att.content) {
      throw new YattaMailError("Attachment requires at least one of 'filename', 'path', or 'content'.");
    }

    if (att.content) {
      const len =
        typeof att.content === "string"
          ? Buffer.byteLength(att.content)
          : att.content instanceof Uint8Array || Buffer.isBuffer(att.content)
          ? att.content.byteLength
          : 0;

      if (len > this.maxAttachmentSize) {
        throw new YattaMailError(
          `Attachment "${att.filename ?? "unnamed"}" (${Math.round(len / 1024)}KB) exceeds maxAttachmentSize limit (${Math.round(this.maxAttachmentSize / 1024)}KB).`,
        );
      }
    }
  }

  /**
   * Creates a new fluent {@link MailBuilder} instance bound to this mailer.
   *
   * @returns Fluent mail builder DSL.
   */
  compose(): MailBuilder<TTemplates> {
    return new MailBuilder<TTemplates>(this as unknown as YattaMailer);
  }

  /**
   * Convenience entry point creating a {@link MailBuilder} with predefined recipient(s).
   *
   * @param recipients Recipient email address(es).
   * @returns Fluent mail builder DSL.
   */
  to(...recipients: RecipientInput[]): MailBuilder<TTemplates> {
    return this.compose().to(...recipients);
  }

  /**
   * Direct email delivery without using the fluent builder.
   *
   * @param options Direct delivery parameters.
   * @returns Send result promise with message ID and delivery status.
   *
   * @example
   * ```ts
   * await mailer.send({
   *   to: "user@example.com",
   *   subject: "Order Confirmation",
   *   html: "<h1>Order Received!</h1>"
   * });
   * ```
   */
  async send(options: DirectSendOptions<TTemplates>): Promise<SendResult> {
    const builder = this.compose();
    if (options.from) builder.from(options.from);
    builder.to(options.to);
    if (options.cc) builder.cc(options.cc);
    if (options.bcc) builder.bcc(options.bcc);
    if (options.replyTo) builder.replyTo(options.replyTo);
    if (options.subject) builder.subject(options.subject);
    if (options.text) builder.text(options.text);
    if (options.html) builder.html(options.html);
    if (options.markdown) builder.markdown(options.markdown);
    if (options.layout) builder.layout(options.layout);
    if (options.priority) builder.priority(options.priority);
    if (options.idempotencyKey) builder.idempotencyKey(options.idempotencyKey);

    if (options.template) {
      builder.template(options.template, options.data as any);
    }
    if (options.attachments) {
      builder.withAttachments(options.attachments);
    }
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        builder.header(k, v);
      }
    }

    return builder.send();
  }

  /**
   * Batch sending utility.
   * Concurrently dispatches emails while strictly adhering to rate limits and concurrency limits.
   *
   * @param items Array of direct send option objects or pre-configured `MailBuilder` instances.
   * @returns Aggregate summary containing results array, total count, and failed count.
   *
   * @example
   * ```ts
   * const summary = await mailer.batch([
   *   { to: "alice@example.com", subject: "Hi Alice", text: "..." },
   *   { to: "bob@example.com", subject: "Hi Bob", text: "..." },
   * ]);
   * console.log(`Dispatched ${summary.total - summary.failed}/${summary.total}`);
   * ```
   */
  async batch(
    items: Array<DirectSendOptions<TTemplates> | MailBuilder<TTemplates>>,
  ): Promise<{ results: SendResult[]; total: number; failed: number }> {
    const results: SendResult[] = [];
    let failed = 0;

    const executions = items.map(async (item) => {
      try {
        const res = item instanceof MailBuilder ? await item.send() : await this.send(item);
        results.push(res);
        if (res.failed) failed++;
      } catch (err) {
        failed++;
        this.logger.error("[yatta-mail:batch] Item delivery failed:", err);
      }
    });

    await Promise.all(executions);
    return { results, total: items.length, failed };
  }

  /**
   * Returns a snapshot copy of current operational metrics and delivery statistics.
   */
  stats(): MailStats {
    return { ...this.metrics };
  }

  // ── Testing Superpowers ──────────────────────────────────────────────────

  /**
   * In `"memory"` test mode, returns a read-only list of all captured sent email records.
   */
  sent(): readonly SentMemoryEmail[] {
    return this.sentMemoryStorage;
  }

  /**
   * In `"memory"` test mode, returns the most recently sent email record, or `undefined` if none.
   */
  lastSent(): SentMemoryEmail | undefined {
    return this.sentMemoryStorage[this.sentMemoryStorage.length - 1];
  }

  /**
   * In `"memory"` test mode, returns the count of sent emails recorded so far.
   */
  sentCount(): number {
    return this.sentMemoryStorage.length;
  }

  /**
   * In `"memory"` test mode, filters recorded emails by a predicate callback.
   *
   * @param predicate Filter predicate.
   * @returns Matching sent email records.
   */
  findSent(predicate: (email: SentMemoryEmail) => boolean): SentMemoryEmail[] {
    return this.sentMemoryStorage.filter(predicate);
  }

  /**
   * In `"memory"` test mode, clears the recorded list of sent emails.
   */
  clearSent(): void {
    this.sentMemoryStorage = [];
  }

  /**
   * In `"memory"` test mode, clears all recorded sent emails and resets operational metrics to zero.
   */
  reset(): void {
    this.clearSent();
    this.metrics.sent = 0;
    this.metrics.failed = 0;
    this.metrics.rejected = 0;
    this.metrics.retries = 0;
    this.metrics.queued = 0;
    this.metrics.dryRun = 0;
    this.metrics.totalDeliveryTimeMs = 0;
    this.metrics.averageDeliveryTimeMs = 0;
  }

  // ── Dispatch & Transport Engine ──────────────────────────────────────────

  private async getTransporter(): Promise<Transporter> {
    if (this.transporterPromise) return this.transporterPromise;

    this.transporterPromise = (async () => {
      if (this.mode === "memory") {
        return nodemailer.createTransport({
          name: "memory-transport",
          version: "2.0.0",
          send: (mail, callback) => {
            const data = mail.data;
            this.sentMemoryStorage.push({ options: data, sentAt: new Date() });
            callback(null, {
              messageId: `<mem-${Date.now()}@yatta.local>`,
              accepted: (Array.isArray(data.to) ? data.to : [data.to]) as string[],
              rejected: [],
              response: "OK (memory)",
            } as any);
          },
        });
      }

      if (this.mode === "terminal") {
        return nodemailer.createTransport({
          streamTransport: true,
          newline: "unix",
          buffer: true,
        });
      }

      if (this.mode === "ethereal") {
        const testAccount = await nodemailer.createTestAccount();
        this.logger.info(`✨ Smart Dev Mode: Connected to Ethereal (${testAccount.user})`);

        return nodemailer.createTransport({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass,
          },
        });
      }

      // Mode: SMTP
      let host = this.options.host ?? process.env.YATTA_MAIL_HOST ?? process.env.SMTP_HOST;
      let port = this.options.port ?? Number(process.env.YATTA_MAIL_PORT ?? process.env.SMTP_PORT);
      let secure = this.options.secure ?? (process.env.YATTA_MAIL_SECURE === "true" || port === 465);

      // Apply Provider Presets
      if (this.options.provider && PROVIDER_PRESETS[this.options.provider]) {
        const preset = PROVIDER_PRESETS[this.options.provider]!;
        host = host ?? preset.host;
        port = port || preset.port;
        if (this.options.secure === undefined) secure = preset.secure;
      }

      if (!host) {
        throw new YattaMailError(
          "SMTP Host is required in SMTP mode. Define options.host, options.provider, or SMTP_HOST.",
        );
      }

      const user = this.options.auth?.user ?? process.env.YATTA_MAIL_USER ?? process.env.SMTP_USER;
      const pass = this.options.auth?.pass ?? process.env.YATTA_MAIL_PASS ?? process.env.SMTP_PASS;

      return nodemailer.createTransport({
        host,
        port: port || 587,
        secure,
        auth: user && pass ? { user, pass } : undefined,
        pool: true,
        maxConnections: this.options.rateLimit?.maxConcurrency ?? 5,
        maxMessages: 100,
      });
    })();

    return this.transporterPromise;
  }

  /**
   * Verifies the SMTP transport connection configuration and credentials.
   *
   * @returns `true` if transport verification succeeds.
   * @throws {@link YattaMailError} If credentials or network connection fail.
   */
  async verify(): Promise<boolean> {
    const transporter = await this.getTransporter();
    try {
      await transporter.verify();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new YattaMailError(`Mail transport verification failed: ${msg}`, err);
    }
  }

  /**
   * Core dispatch pipeline. Compiles, rate-limits, retries, and sends raw Nodemailer options.
   *
   * @param mailOptions Compiled Nodemailer options.
   * @returns Delivery result promise.
   */
  async dispatch(mailOptions: SendMailOptions): Promise<SendResult> {
    await this.hooks?.beforeSend?.(mailOptions);

    // Dry Run Mode Check
    if (this.dryRun) {
      this.metrics.dryRun++;
      const messageId = `<dry-run-${Date.now()}@yatta.local>`;
      this.logger.info(`[yatta-mail:dry-run] Email compiled successfully: ${mailOptions.subject} (ID: ${messageId})`);
      const result: SendResult = {
        messageId,
        accepted: Array.isArray(mailOptions.to) ? mailOptions.to.map(String) : [String(mailOptions.to)],
        rejected: [],
        failed: false,
        previewUrl: false,
      };
      await this.hooks?.afterSend?.(result, mailOptions);
      return result;
    }

    await this.acquireRateLimitAndConcurrency();
    const startTime = Date.now();

    try {
      const transporter = await this.getTransporter();
      let attempt = 0;
      let lastError: unknown = null;

      while (attempt <= this.retries) {
        try {
          const info = await transporter.sendMail(mailOptions);
          const accepted = (info.accepted ?? []).map(String);
          const rejected = (info.rejected ?? []).map(String);

          if (rejected.length > 0 && accepted.length === 0) {
            throw new YattaMailError(`All recipients rejected by SMTP relay: ${rejected.join(", ")}`, info);
          }

          let previewUrl: string | false = false;
          if (this.mode === "ethereal") {
            previewUrl = nodemailer.getTestMessageUrl(info);
            if (previewUrl) {
              console.log("\n======================== ✉️  YATTA EMAIL PREVIEW ========================");
              console.log(`To:      ${String(mailOptions.to)}`);
              console.log(`Subject: ${mailOptions.subject}`);
              console.log(`🔗 Link:  \x1b[36m${previewUrl}\x1b[0m`);
              console.log("========================================================================\n");
            }
          } else if (this.mode === "terminal") {
            console.log("\n======================== ✉️  YATTA TERMINAL EMAIL ========================");
            console.log(`To:      ${String(mailOptions.to)}`);
            console.log(`Subject: ${mailOptions.subject}`);
            console.log(`Body:\n${mailOptions.text || "(HTML Content)"}`);
            console.log("========================================================================\n");
          }

          const result: SendResult = {
            messageId: info.messageId,
            accepted,
            rejected,
            failed: rejected.length > 0,
            previewUrl,
            raw: info,
          };

          // Metrics update
          const duration = Date.now() - startTime;
          this.metrics.sent++;
          if (rejected.length > 0) this.metrics.rejected += rejected.length;
          this.metrics.totalDeliveryTimeMs += duration;
          this.metrics.averageDeliveryTimeMs = this.metrics.totalDeliveryTimeMs / this.metrics.sent;

          await this.hooks?.afterSend?.(result, mailOptions);
          return result;
        } catch (err: unknown) {
          lastError = err;

          if (!this.isTransientError(err)) {
            break; // Non-transient failure: do not retry
          }

          attempt++;
          this.metrics.retries++;

          if (attempt <= this.retries) {
            // Full-jitter exponential backoff: (500 * 2^attempt) * random(0.5..1.0)
            const delay = Math.min(30_000, 500 * Math.pow(2, attempt - 1)) * (0.5 + Math.random() * 0.5);
            this.hooks?.onRetry?.(attempt, err as Error, delay);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      this.metrics.failed++;
      const errInstance = lastError instanceof Error ? lastError : new Error(String(lastError));
      await this.hooks?.onError?.(errInstance, mailOptions);
      throw new YattaMailError(
        `Failed to deliver email after ${attempt} attempt(s): ${errInstance.message}`,
        lastError,
      );
    } finally {
      this.releaseConcurrency();
    }
  }

  // ── Concurrency & Rate Limiting Queue ─────────────────────────────────────

  private async acquireRateLimitAndConcurrency(): Promise<void> {
    const rateLimit = this.options.rateLimit;
    const maxConcurrency = rateLimit?.maxConcurrency ?? 5;

    // Concurrency control
    if (this.activeConcurrentJobs >= maxConcurrency) {
      await new Promise<void>((resolve) => this.concurrencyWaiters.push(resolve));
    }
    this.activeConcurrentJobs++;

    // Token bucket rate limiting
    if (rateLimit?.max) {
      const windowMs = rateLimit.windowMs ?? 1000;
      const now = Date.now();
      if (now - this.lastRateLimitRefill > windowMs) {
        this.rateLimitTokens = rateLimit.max;
        this.lastRateLimitRefill = now;
      }

      if (this.rateLimitTokens <= 0) {
        const sleepTime = windowMs - (now - this.lastRateLimitRefill);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, sleepTime)));
        this.rateLimitTokens = rateLimit.max;
        this.lastRateLimitRefill = Date.now();
      }

      this.rateLimitTokens--;
    }
  }

  private releaseConcurrency(): void {
    this.activeConcurrentJobs--;
    const nextWaiter = this.concurrencyWaiters.shift();
    if (nextWaiter) nextWaiter();
  }

  /**
   * Tracks an asynchronous background delivery task within the mailer instance.
   *
   * @param mailOptions Nodemailer send options.
   */
  trackBackgroundDelivery(mailOptions: SendMailOptions): void {
    this.metrics.queued++;
    this.hooks?.onQueued?.(mailOptions);

    const promise = this.dispatch(mailOptions)
      .catch((err): SendResult => {
        this.logger.error("[yatta-mail:background-delivery] Delivery failed:", err);
        return {
          messageId: "",
          accepted: [],
          rejected: [],
          failed: true,
          previewUrl: false,
          raw: err,
        } as SendResult;
      })
      .finally(() => {
        this.backgroundPromises.delete(promise);
      });

    this.backgroundPromises.add(promise);
  }

  /**
   * Waits for all in-flight background deliveries to finish before process termination.
   */
  async drain(): Promise<void> {
    await Promise.all(Array.from(this.backgroundPromises));
  }

  private isTransientError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { responseCode?: number; code?: string };

    if (e.responseCode && e.responseCode >= 400 && e.responseCode < 500) return true;
    if (e.responseCode && e.responseCode >= 500) return false;

    const transientCodes = new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ENOTFOUND",
    ]);

    return Boolean(e.code && transientCodes.has(e.code));
  }

  /**
   * Closes active transport connections and drains background tasks.
   */
  async close(): Promise<void> {
    await this.drain();
    if (this.transporterPromise) {
      const transporter = await this.transporterPromise;
      transporter.close();
      this.transporterPromise = null;
    }
  }

  /**
   * Async disposable resource cleanup hook (`using mailer = ...`).
   */
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Testing Assertion Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fluent assertion helper for verifying dispatched emails during tests in `"memory"` mode.
 *
 * @param mailer {@link YattaMailer} instance running in `"memory"` mode.
 * @returns Matcher object with assertion methods.
 *
 * @example
 * ```ts
 * expectEmail(mailer)
 *   .toSentCount(1)
 *   .to("user@example.com")
 *   .withSubject("Welcome")
 *   .containing("Verify account");
 * ```
 */
export function expectEmail(mailer: YattaMailer) {
  return {
    /** Asserts that exactly `expected` number of emails have been sent. */
    toSentCount(expected: number) {
      const actual = mailer.sentCount();
      if (actual !== expected) {
        throw new Error(`Expected ${expected} sent emails, but found ${actual}.`);
      }
      return this;
    },
    /** Asserts that at least one email was sent to the specified recipient. */
    to(recipient: string) {
      const found = mailer.findSent((s) => {
        const to = s.options.to;
        if (typeof to === "string") return to.includes(recipient);
        if (Array.isArray(to)) return to.some((r) => String(r).includes(recipient));
        return false;
      });
      if (found.length === 0) {
        throw new Error(`No email was sent to "${recipient}".`);
      }
      return this;
    },
    /** Asserts that at least one sent email matches the expected subject. */
    withSubject(subject: string | RegExp) {
      const found = mailer.findSent((s) => {
        const sub = s.options.subject ?? "";
        return typeof subject === "string" ? sub === subject : subject.test(sub);
      });
      if (found.length === 0) {
        throw new Error(`No email matched subject: ${String(subject)}`);
      }
      return this;
    },
    /** Asserts that at least one sent email contains the specified text snippet. */
    containing(text: string) {
      const found = mailer.findSent((s) => {
        const body = `${s.options.text ?? ""} ${s.options.html ?? ""}`;
        return body.includes(text);
      });
      if (found.length === 0) {
        throw new Error(`No email contained expected body text: "${text}"`);
      }
      return this;
    },
  };
}

/**
 * Convenience assertion helper verifying that an email matching criteria was dispatched.
 *
 * @param mailer Host mailer instance.
 * @param filter Matcher criteria (`to`, `subject`, `contains`).
 *
 * @example
 * ```ts
 * assertEmailSent(mailer, { to: "alice@example.com", subject: /Welcome/i });
 * ```
 */
export function assertEmailSent(
  mailer: YattaMailer,
  filter: { to?: string; subject?: string | RegExp; contains?: string },
): void {
  const matcher = expectEmail(mailer);
  if (filter.to) matcher.to(filter.to);
  if (filter.subject) matcher.withSubject(filter.subject);
  if (filter.contains) matcher.containing(filter.contains);
}

// ──────────────────────────────────────────────────────────────────────────
// 8. Global Singleton & Proxy
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_MAIL_KEY = Symbol.for("yatta.mail.default");
const g = globalThis as unknown as { [GLOBAL_MAIL_KEY]?: YattaMailer<any> };

/**
 * Creates and configures a new {@link YattaMailer} instance and registers it as the global default.
 *
 * @template TTemplates Registered templates type contract.
 * @param options Mailer configuration options.
 * @returns Configured `YattaMailer` instance.
 *
 * @example
 * ```ts
 * export const mailer = createMailer({
 *   provider: "resend",
 *   auth: { user: "resend", pass: process.env.RESEND_API_KEY! },
 *   defaultFrom: "Yatta <noreply@yatta.dev>"
 * });
 * ```
 */
export function createMailer<TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates>(
  options: MailerOptions<TTemplates> = {},
): YattaMailer<TTemplates> {
  const mailer = new YattaMailer<TTemplates>(options);
  g[GLOBAL_MAIL_KEY] = mailer;
  return mailer;
}

function getDefaultMailer(): YattaMailer {
  if (!g[GLOBAL_MAIL_KEY]) {
    g[GLOBAL_MAIL_KEY] = new YattaMailer();
  }
  return g[GLOBAL_MAIL_KEY]!;
}

/**
 * Callable function signature for the {@link Mail} global proxy facade.
 */
export interface MailProxyFunction {
  /** Access the default configured {@link YattaMailer} instance. */
  <TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates>(): YattaMailer<TTemplates>;
  /** Compose an email targeting one or more recipients using default mailer. */
  to<TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates>(
    ...recipients: RecipientInput[]
  ): MailBuilder<TTemplates>;
  /** Create a fluent builder session using default mailer. */
  compose<TTemplates extends Record<string, Record<string, unknown>> = RegisteredTemplates>(): MailBuilder<TTemplates>;
  /** Directly dispatch an email using default mailer. */
  send(options: DirectSendOptions): Promise<SendResult>;
  /** Concurrently send multiple emails using default mailer. */
  batch(items: Array<DirectSendOptions | MailBuilder<any>>): Promise<{ results: SendResult[]; total: number; failed: number }>;
  /** Verify default transport connection. */
  verify(): Promise<boolean>;
  /** Close default transport connections. */
  close(): Promise<void>;
  /** Drain in-flight background deliveries on default mailer. */
  drain(): Promise<void>;
  /** In memory mode, retrieve sent emails on default mailer. */
  sent(): readonly SentMemoryEmail[];
  /** In memory mode, retrieve most recent email on default mailer. */
  lastSent(): SentMemoryEmail | undefined;
  /** In memory mode, retrieve sent count on default mailer. */
  sentCount(): number;
  /** In memory mode, find sent emails matching predicate on default mailer. */
  findSent(predicate: (email: SentMemoryEmail) => boolean): SentMemoryEmail[];
  /** In memory mode, clear sent emails on default mailer. */
  clearSent(): void;
  /** In memory mode, reset sent emails and metrics on default mailer. */
  reset(): void;
  /** Get metrics stats from default mailer. */
  stats(): MailStats;
}

/**
 * Union proxy type combining {@link MailProxyFunction} and {@link YattaMailer}.
 */
export type MailProxy = MailProxyFunction & YattaMailer;

/**
 * Global Mail facade delegating calls directly to the application's default {@link YattaMailer} instance.
 *
 * @example
 * ```ts
 * import { Mail } from "yatta/mail";
 *
 * // Directly send:
 * await Mail.to("user@example.com")
 *   .subject("Notification")
 *   .markdown("Hello!")
 *   .send();
 * ```
 */
export const Mail: MailProxy = new Proxy(function () { return getDefaultMailer(); }, {
  apply() {
    return getDefaultMailer();
  },
  get(_target, prop, receiver) {
    if (prop === "name" || prop === "length" || prop === "prototype" || prop === Symbol.toPrimitive) {
      return Reflect.get(_target, prop, receiver);
    }
    const instance = getDefaultMailer();
    const val = (instance as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? val.bind(instance) : val;
  },
}) as unknown as MailProxy;