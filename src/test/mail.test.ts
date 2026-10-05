import { describe, it, expect, beforeEach } from "bun:test";
import {
  createMailer,
  assertNoCrlf,
  validateEmailAddress,
  sanitizeUrl,
  escapeHtml,
  markdownToHtml,
  htmlToText,
  interpolate,
  DEFAULT_HELPERS,
  YattaMailError,
  type SendResult,
} from "../types/mail";

describe("Yatta Mail — Hardened Mail Engine", () => {
  let mailer: ReturnType<typeof createMailer>;

  beforeEach(() => {
    mailer = createMailer({
      mode: "memory",
      defaultFrom: "Yatta System <noreply@yatta.dev>",
    });

    mailer.registerLayout(
      "marketing",
      `<div class="wrapper"><header>Header</header><main>{{{content}}}</main><footer>Footer</footer></div>`,
    );

    mailer.registerTemplate("welcome", {
      subject: "Welcome, {{name | uppercase}}!",
      layout: "marketing",
      html: `<h1>Hi, {{name}}</h1><p>Your balance is {{balance | currency:USD}}.</p>`,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should accept valid string and object email address formats", () => {
      const addr1 = "user@test.com";
      const addr2 = { name: "Alice", address: "alice@test.com" };

      expect(typeof addr1).toBe("string");
      expect(addr2.address).toBe("alice@test.com");
    });

    it("should conform to SendResult interface", () => {
      const res: SendResult = {
        messageId: "<msg-123@yatta.dev>",
        accepted: ["alice@test.com"],
        rejected: [],
        failed: false,
      };

      expect(res.failed).toBe(false);
      expect(res.accepted.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should prevent CRLF header injection across all header inputs", () => {
      expect(() => assertNoCrlf("Normal Subject", "Subject")).not.toThrow();
      expect(() =>
        assertNoCrlf("Injected\r\nBcc: evil@hacker.com", "Subject"),
      ).toThrow(YattaMailError);
      expect(() =>
        assertNoCrlf("Injected\nTo: evil@hacker.com", "Subject"),
      ).toThrow(YattaMailError);
    });

    it("should sanitize dangerous URL protocols in links", () => {
      expect(sanitizeUrl("https://example.com/verify")).toBe(
        "https://example.com/verify",
      );
      expect(sanitizeUrl("mailto:support@test.com")).toBe(
        "mailto:support@test.com",
      );
      expect(sanitizeUrl("javascript:alert(document.cookie)")).toBe(
        "#unsafe-url",
      );
      expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe(
        "#unsafe-url",
      );
      expect(sanitizeUrl("vbscript:msgbox")).toBe("#unsafe-url");
    });

    it("should prevent XSS attacks in Markdown parser", () => {
      const maliciousMd =
        '# Welcome\n<script>alert("xss")</script>\n[Click Here](javascript:stealData())';
      const html = markdownToHtml(maliciousMd);

      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('href="#unsafe-url"');
    });

    it("should reject invalid and malformed email addresses", () => {
      expect(() => validateEmailAddress("valid.user@company.co")).not.toThrow();
      expect(() => validateEmailAddress("not-an-email")).toThrow(
        YattaMailError,
      );
      expect(() => validateEmailAddress("user@")).toThrow(YattaMailError);
      expect(() => validateEmailAddress("@domain.com")).toThrow(YattaMailError);
      expect(() => validateEmailAddress("name<email@test.com>\r\n")).toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should interpolate template variables and apply pipe transformations", () => {
      const template =
        "Hello {{user.name | uppercase}}, order total: {{order.total | currency:USD}} on {{order.date | date}}";
      const data = {
        user: { name: "john doe" },
        order: { total: 49.99, date: new Date("2026-05-15T00:00:00Z") },
      };

      const result = interpolate(template, data, DEFAULT_HELPERS);
      expect(result).toContain("JOHN DOE");
      expect(result).toContain("$49.99");
      expect(result).toContain("2026");
    });

    it("should escape HTML in double curlies and preserve raw HTML in triple curlies", () => {
      const template = "Escaped: {{content}} | Raw: {{{content}}}";
      const data = { content: "<b>Bold & Strong</b>" };

      const result = interpolate(template, data);
      expect(result).toContain("&lt;b&gt;Bold &amp; Strong&lt;/b&gt;");
      expect(result).toContain("<b>Bold & Strong</b>");
    });

    it("should convert HTML to clean plain text preserving structure and links", () => {
      const html = `
        <h1>Meeting Summary</h1>
        <p>Please check the <a href="https://example.com/docs">documentation</a>.</p>
        <ul>
          <li>Item A</li>
          <li>Item B</li>
        </ul>
      `;

      const text = htmlToText(html);
      expect(text).toContain("=== Meeting Summary ===");
      expect(text).toContain("documentation (https://example.com/docs)");
      expect(text).toContain("• Item A");
      expect(text).toContain("• Item B");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should compile and deliver email using Memory transport", async () => {
      const result = await mailer
        .to("recipient@example.com")
        .subject("Test Email Delivery")
        .html("<p>This is a test message</p>")
        .send();

      expect(result.failed).toBe(false);
      expect(result.accepted).toContain("recipient@example.com");

      // Verify memory transport recorded the email
      const sentEmails = mailer.sent();
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0]!.options.subject).toBe("Test Email Delivery");
      expect(sentEmails[0]!.options.to).toBe("recipient@example.com");

      mailer.clearSent();
      expect(mailer.sentCount()).toBe(0);
    });

    it("should render template within layout and generate plain text fallback", async () => {
      await mailer
        .to("customer@example.com")
        .template("welcome", { name: "Sarah", balance: 150 })
        .send();

      const sent = mailer.lastSent()!;
      expect(sent.options.subject).toBe("Welcome, SARAH!");
      expect(String(sent.options.html)).toContain('<div class="wrapper">');
      expect(String(sent.options.html)).toContain("Hi, Sarah");
      expect(String(sent.options.html)).toContain("$150.00");

      // Plain-text should be automatically generated from rendered HTML
      expect(sent.options.text).toBeDefined();
      expect(String(sent.options.text)).toContain("Hi, Sarah");
    });

    it("should assert email was sent using findSent helper", async () => {
      await mailer
        .to("audit@company.org")
        .subject("Security Notification")
        .text("Your password was updated.")
        .send();

      const found = mailer.findSent(
        (m) => m.options.subject === "Security Notification",
      );
      expect(found.length).toBe(1);

      const notFound = mailer.findSent(
        (m) => m.options.subject === "Non-existent Subject",
      );
      expect(notFound.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (Headers, MIME & Attachments)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests (Headers, MIME & Attachments)", () => {
    it("should attach binary and text files properly", async () => {
      const attachmentData = Buffer.from("Invoice Content Data");

      await mailer
        .to("billing@client.com")
        .subject("Your Monthly Invoice")
        .text("Attached is your invoice.")
        .attach({
          filename: "invoice.pdf",
          content: attachmentData,
          contentType: "application/pdf",
        })
        .send();

      const sent = mailer.lastSent()!;
      expect(sent.options.attachments?.length).toBe(1);
      const att = sent.options.attachments![0] as any;
      expect(att.filename).toBe("invoice.pdf");
      expect(att.contentType).toBe("application/pdf");
    });

    it("should support One-Click Unsubscribe headers (RFC 8058)", async () => {
      await mailer
        .to("newsletter@subscriber.com")
        .subject("Weekly Tech Roundup")
        .text("Roundup content here...")
        .unsubscribe({
          url: "https://yatta.dev/unsubscribe?token=abc123xyz",
          email: "unsubscribe@yatta.dev",
        })
        .send();

      const sent = mailer.lastSent()!;
      const headers = sent.options.headers as Record<string, string>;

      expect(headers["List-Unsubscribe"]).toContain(
        "<mailto:unsubscribe@yatta.dev>",
      );
      expect(headers["List-Unsubscribe"]).toContain(
        "<https://yatta.dev/unsubscribe?token=abc123xyz>",
      );
      expect(headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
    });

    it("should generate email preview without dispatching", async () => {
      const preview = await mailer
        .to("preview@test.com")
        .subject("Preview Title")
        .markdown("**Bold Announcement**")
        .preview();

      expect(preview.subject).toBe("Preview Title");
      expect(preview.html).toContain("<strong>Bold Announcement</strong>");
      expect(preview.text).toContain("Bold Announcement");
      // Memory store should NOT have sent emails from preview
      expect(mailer.sentCount()).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should handle parallel concurrent email dispatches safely", async () => {
      const count = 30;
      const tasks = Array.from({ length: count }).map(async (_, idx) => {
        return mailer
          .to(`user_${idx}@batch.org`)
          .subject(`Notification #${idx}`)
          .text(`Message body for index ${idx}`)
          .send();
      });

      const results = await Promise.all(tasks);
      expect(results.length).toBe(count);
      expect(results.every((r) => !r.failed)).toBe(true);
      expect(mailer.sentCount()).toBe(count);
    });

    it("should attach idempotency keys for delivery deduplication", async () => {
      const idempotencyKey = "order-tx-unique-9999";

      await mailer
        .to("buyer@shop.com")
        .subject("Order Confirmation #9999")
        .text("Thanks for your order.")
        .idempotencyKey(idempotencyKey)
        .send();

      const sent = mailer.lastSent()!;
      const headers = sent.options.headers as Record<string, string>;

      expect(headers["X-Idempotency-Key"]).toBe(idempotencyKey);
      expect(headers["Message-ID"]).toBeDefined();
    });
  });
});
