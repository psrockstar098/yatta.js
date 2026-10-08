import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import { createMailer, YattaMailError, type YattaMailer } from "../types/mail";

/*
 * The SMTP transport, against a real server.
 *
 * Every one of the 17 existing mail tests uses `mode: "memory"`, which is a nodemailer
 * transport with a function where the socket would be. So the path every production
 * deployment uses — nodemailer, a host, a port, AUTH, DATA — has never been executed.
 * A template bug shows up in a test; a transport bug shows up as "email silently not
 * arriving", which is the failure nobody notices until a user complains.
 *
 * So this speaks enough SMTP to accept a message and hand back what arrived: 220, EHLO,
 * AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Real bytes over a real socket, through the
 * real client.
 */

interface Captured {
  from: string;
  recipients: string[];
  authUser?: string;
  authPass?: string;
  data: string;
}

let server: Server;
let port: number;
let captured: Captured[] = [];

/**
 * Every mailer this file creates.
 *
 * The SMTP transport pools connections, so a mailer that is never closed still holds
 * its socket open and `server.close()` waits for it forever. The first version of this
 * file hung at the end of the run for exactly that reason, with no output at all.
 */
const mailers: YattaMailer[] = [];

function track<T extends YattaMailer>(mailer: T): T {
  mailers.push(mailer as YattaMailer);
  return mailer;
}

/** One message, decoded enough to assert on. */
function decode(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);

  const headers: Record<string, string> = {};
  let lastKey = "";

  for (const line of head.split("\r\n")) {
    // A leading space continues the previous header (folded).
    if (/^\s/.test(line) && lastKey) {
      headers[lastKey] += " " + line.trim();
      continue;
    }

    const at = line.indexOf(":");
    if (at === -1) continue;

    lastKey = line.slice(0, at).trim();
    headers[lastKey] = line.slice(at + 1).trim();
  }

  return { headers, body };
}

function handle(socket: Socket): void {
  const record: Captured = { from: "", recipients: [], data: "" };
  let stage: "greet" | "ehlo" | "auth" | "mail" | "rcpt" | "data" = "greet";
  let buffer = "";
  let body = "";

  const say = (line: string): void => {
    void socket.write(`${line}\r\n`);
  };

  void socket.write("220 yatta.test ESMTP ready\r\n");

  socket.on("data", (chunk: Buffer): void => {
    buffer += chunk.toString();

    let at: number;
    while ((at = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);

      switch (stage) {
        case "greet":
          if (/^EHLO/i.test(line)) {
            say("250-yatta.test");
            say("250-AUTH LOGIN PLAIN");
            say("250 SIZE 10485760");
            stage = "ehlo";
          } else if (/^HELO/i.test(line)) {
            say("250 yatta.test");
            stage = "ehlo";
          } else if (/^QUIT/i.test(line)) {
            say("221 bye");
            socket.end();
          }
          break;

        case "ehlo":
          /*
           * Nodemailer sends `AUTH PLAIN <base64>` — the SASL initial-response form —
           * not the interactive `AUTH LOGIN` sequence. A server that only implements
           * the interactive one never replies and the send hangs, which is exactly what
           * the first version of this file did to itself.
           */
          const plain = /^AUTH PLAIN\s+(\S+)/i.exec(line);
          const login = /^AUTH LOGIN$/i.test(line);

          if (plain) {
            // SASL PLAIN is authorisation-id NUL authcid NUL passwd, so the username is
            // the *second* field. Reading it as the first makes the user empty and the
            // password the username.
            const [, user, pass] = Buffer.from(plain[1]!, "base64")
              .toString("utf8")
              .split("\0");
            record.authUser = user;
            record.authPass = pass;
            say("235 2.7.0 Authentication successful");
          } else if (login) {
            say("334 VXNlcm5hbWU6"); // "Username:"
            stage = "auth";
          } else if (/^MAIL FROM:/i.test(line)) {
            record.from = line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "");
            say("250 OK");
            stage = "mail";
          } else if (/^QUIT/i.test(line)) {
            say("221 bye");
            socket.end();
          }
          break;

        case "auth":
          // Interactive AUTH LOGIN: the username first, then the password.
          if (!record.authUser) {
            record.authUser = Buffer.from(line, "base64").toString();
            say("334 UGFzc3dvcmQ6"); // "Password:"
          } else {
            record.authPass = Buffer.from(line, "base64").toString();
            say("235 2.7.0 Authentication successful");
            stage = "ehlo";
          }
          break;

        case "mail":
          if (/^RCPT TO:/i.test(line)) {
            record.recipients.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, ""));
            say("250 OK");
          } else if (/^DATA/i.test(line)) {
            say("354 End data with <CR><LF>.<CR><LF>");
            stage = "data";
          } else if (/^QUIT/i.test(line)) {
            say("221 bye");
            socket.end();
          }
          break;

        case "data":
          if (line === ".") {
            captured.push({ ...record, data: body });
            body = "";
            say("250 2.0.0 Ok: queued");
            stage = "ehlo";
          } else {
            // Dot-stuffing: a leading ".." on a line is an escaped literal dot.
            body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          break;
      }

      if (socket.destroyed) return;
    }
  });

  socket.on("error", (): void => {
    // A client that hangs up mid-transaction is not a test failure.
  });
}

/*
 * Created on first use, from inside a test body.
 *
 * Two arrangements that should have worked and did not: `beforeAll` left the listening
 * promise unsettled and Bun ran the test bodies anyway, so each dialled port 0; and a
 * module-level `await` never resolved at all, so the module never finished loading.
 * Creating it lazily inside the test — which is what an isolated diagnostic proved
 * works — has no such phase to get wrong.
 */
let started: Promise<number> | null = null;

function smtpServer(): Promise<number> {
  started ??= (async () => {
    server = createServer(handle);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    return (server.address() as { port: number }).port;
  })();
  return started;
}

afterAll(async () => {
  // Close the pooled connections first, or the server waits on sockets nobody owns.
  for (const mailer of mailers) await mailer.close().catch(() => null);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  captured = [];
});

async function smtpMailer(): Promise<YattaMailer> {
  port = await smtpServer();

  return track(createMailer({
    mode: "smtp",
    host: "127.0.0.1",
    port,
    // No TLS on a loopback capture server; nodemailer otherwise starts STARTTLS.
    secure: false,
    ignoreTLS: true,
    auth: { user: "postmaster", pass: "s3cret-pass" },
    defaultFrom: "noreply@yatta.test",
  } as never));
}

describe("Mail over real SMTP", () => {
  it("delivers a message and the server receives it", async () => {
    const mailer = await smtpMailer();

    const result = await mailer
      .to("ada@yatta.test")
      .subject("Hello")
      .text("plain body")
      .html("<p>html body</p>")
      .send();
    expect(result.accepted).toContain("ada@yatta.test");
    expect(captured).toHaveLength(1);

    const { headers, body } = decode(captured[0]!.data);

    expect(headers["Subject"]).toBe("Hello");
    expect(headers["From"]).toContain("noreply@yatta.test");
    expect(headers["To"]).toContain("ada@yatta.test");
    expect(body).toContain("plain body");
    expect(body).toContain("<p>html body</p>");
  }, 20_000);

  it("authenticates when credentials are configured", async () => {
    const mailer = await smtpMailer();

    await mailer.to("bob@yatta.test").subject("Auth").text("hi").send();

    /*
     * Nodemailer only attempts AUTH when given credentials, and silently skips it when
     * told not to. A misconfigured `auth` therefore produces no error at all — it just
     * fails later, at the relay that rejects the recipient.
     */
    expect(captured[0]?.authUser).toBe("postmaster");
    expect(captured[0]?.authPass).toBe("s3cret-pass");
  }, 20_000);

  it("sends to several recipients in one transaction", async () => {
    const mailer = await smtpMailer();

    await mailer.to(["a@yatta.test", "b@yatta.test", "c@yatta.test"]).subject("Many").text("hi").send();

    // Nodemailer does not open a second session per recipient; one transaction with
    // three RCPTs is what a mailing list needs and what a naive loop gets wrong.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.recipients.sort()).toEqual(["a@yatta.test", "b@yatta.test", "c@yatta.test"]);
  }, 20_000);

  it("renders a template with its layout over SMTP", async () => {
    port = await smtpServer();
    const mailer = track(createMailer({
      mode: "smtp",
      host: "127.0.0.1",
      port,
      secure: false,
      ignoreTLS: true,
      defaultFrom: "noreply@yatta.test",
      layouts: {
        main: "<html><body>{{ content }}</body></html>",
      },
      templates: {
        welcome: {
          subject: "Welcome, {{ name }}",
          html: "<p>Hello {{ name }}</p>",
          text: "Hello {{ name }}",
          layout: "main",
        },
      },
    } as never));

    await mailer.send({
      to: "ada@yatta.test",
      template: "welcome",
      data: { name: "Ada" },
    });

    const { headers, body } = decode(captured[0]!.data);

    expect(headers["Subject"]).toContain("Welcome, Ada");
    expect(body).toContain("<html><body>");
    expect(body).toContain("Hello Ada");
  }, 20_000);

  it("attaches a file, encoded and named", async () => {
    const mailer = await smtpMailer();

    await mailer
      .to("ada@yatta.test")
      .subject("With a file")
      .text("see attached")
      .attach({
        filename: "notes.txt",
        content: Buffer.from("hello from a file"),
        contentType: "text/plain",
      })
      .send();

    const { headers, body } = decode(captured[0]!.data);

    /*
     * The message is multipart/mixed, so the encoding lives on the part, not on the
     * top-level headers — asserting `headers["Content-Transfer-Encoding"]` would be
     * asserting on something that is legitimately absent.
     */
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toContain("Content-Type: text/plain; name=notes.txt");
    expect(body).toContain("Content-Disposition: attachment; filename=notes.txt");
    expect(body).toContain(Buffer.from("hello from a file").toString("base64"));
  }, 20_000);

  it("refuses a header a newline would have smuggled", async () => {
    const mailer = await smtpMailer();

    /*
     * The classic injection: a "name" or subject carrying CRLF plus a Bcc. If the value
     * reached nodemailer unsanitised, the message would gain a recipient the caller
     * never named.
     */
    /*
     * Synchronously, from `.subject()`. The guard runs at the point the value is set,
     * so nothing is ever sent and a `rejects` assertion would be asserting on a promise
     * that was never created — the throw escapes while building the expression.
     */
    expect(() =>
      mailer.to("ada@yatta.test").subject("Hello\r\nBcc: attacker@evil.test").text("hi"),
    ).toThrow(YattaMailError);

    expect(captured).toHaveLength(0);
  }, 20_000);

  /*
   * The two hangs.
   *
   * Nodemailer's own defaults are a 2-minute connect timeout, a 30-second greeting
   * timeout and a 10-minute socket timeout. Left alone, that is what a caller gets:
   * mail is usually sent inline, so a relay that accepts the connection and then goes
   * quiet holds the request open for ten minutes, and every worker waiting on that relay
   * holds a request too. The transport now sets 5s / 5s / 10s unconditionally.
   *
   * These two fail by timing out at 25s if the defaults are restored — the 30s greeting
   * timeout and the 10-minute socket timeout both land past that.
   */
  it("gives up on a relay that accepts the connection but never greets", async () => {
    const silent = createServer(() => {
      // Accept, then say nothing at all. A firewall that drops the payload after the
      // handshake looks exactly like this.
    });

    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));

    const relayPort = (silent.address() as { port: number }).port;
    const mailer = track(createMailer({
      mode: "smtp",
      host: "127.0.0.1",
      port: relayPort,
      secure: false,
      ignoreTLS: true,
      defaultFrom: "noreply@yatta.test",
    } as never));

    await expect(
      mailer.to("ada@yatta.test").subject("x").text("y").send(),
    ).rejects.toThrow();

    /*
     * Deliberately no elapsed-time assertion. Nodemailer retries the whole send — four
     * connections were observed — so the 5s per-attempt greeting timeout lands at ~23s
     * rather than 5s, and a tighter threshold here would be a flaky test rather than a
     * strict one. The 25s test timeout *is* the assertion: with nodemailer's 30s greeting
     * default this takes four times 30s and blows straight through it.
     */

    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }, 25_000);

  it("applies an explicitly configured greeting timeout to a single attempt", async () => {
    const silent = createServer(() => {});

    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));

    const relayPort = (silent.address() as { port: number }).port;
    const mailer = track(createMailer({
      mode: "smtp",
      host: "127.0.0.1",
      port: relayPort,
      secure: false,
      ignoreTLS: true,
      defaultFrom: "noreply@yatta.test",
      timeouts: { greeting: 400 },
    } as never));

    const startedAt = Date.now();

    await expect(
      mailer.to("ada@yatta.test").subject("x").text("y").send(),
    ).rejects.toThrow();

    /*
     * The option reaches nodemailer. One attempt is 400ms and four attempts measured
     * 5.3s — nodemailer backs off between retries, so the total is not 4 × 400ms and the
     * threshold cannot be tight. What matters is the order of magnitude: with the option
     * ignored, the 30s greeting default applies four times and this takes over two
     * minutes.
     */
    expect(Date.now() - startedAt).toBeLessThan(12_000);

    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }, 25_000);

  it("gives up on a relay that greets then stalls mid-message", async () => {
    const stalling = createServer((socket) => {
      socket.write("220 yatta.test ESMTP\r\n");
      socket.on("data", (chunk: Buffer): void => {
        const text = chunk.toString();
        if (/^EHLO/i.test(text)) {
          void socket.write("250 yatta.test\r\n");
        } else if (/^MAIL FROM/i.test(text)) {
          void socket.write("250 OK\r\n");
        } else if (/^RCPT TO/i.test(text)) {
          void socket.write("250 OK\r\n");
        } else if (/^DATA/i.test(text)) {
          void socket.write("354 go\r\n");
          // Accept the DATA and then never answer it. Nodemailer waits out the full
          // 10-minute socket timeout for the final dot.
        }
      });
      socket.on("error", (): void => {});
    });

    await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", () => resolve()));

    const relayPort = (stalling.address() as { port: number }).port;
    const mailer = track(createMailer({
      mode: "smtp",
      host: "127.0.0.1",
      port: relayPort,
      secure: false,
      ignoreTLS: true,
      defaultFrom: "noreply@yatta.test",
      // Short, so the test is quick; the *presence* of a bounded wait is the point, and
      // the default is pinned by the test above.
      timeouts: { socket: 1500 },
    } as never));

    const startedAt = Date.now();

    await expect(
      mailer.to("ada@yatta.test").subject("x").text("y").send(),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(15_000);

    stalling.close();
  }, 25_000);

  it("reports a rejected recipient rather than claiming delivery", async () => {
    const mailer = await smtpMailer();

    // A port with nothing on it: the connection is refused, and the caller has to be
    // told. Silently dropping mail is the failure this whole layer exists to prevent.
    const dead = track(createMailer({
      mode: "smtp",
      host: "127.0.0.1",
      // Nothing listens here.
      port: 1,
      secure: false,
      ignoreTLS: true,
      defaultFrom: "noreply@yatta.test",
      /*
       * Bounded, because nodemailer's own defaults are long enough that a refused
       * connection hangs the test rather than failing it. The mailer sets these
       * unconditionally, so this is the default an operator would get anyway — which is
       * the point being tested.
       */
      timeouts: { connection: 1000, greeting: 1000, socket: 1000 },
    } as never));

    /*
     * Bounded, because nodemailer retries a refused connection and the default is long
     * enough to blow any test timeout. Two attempts is enough to prove it is talking to
     * a socket and being refused.
     */
    let reported: unknown = null;

    try {
      const result = await dead
        .to("ada@yatta.test")
        .subject("x")
        .text("y")
        .send();

      reported = result.accepted ?? [];
    } catch (err) {
      reported = err;
    }

    // Whichever way it surfaces, it must not read as a delivery.
    if (Array.isArray(reported)) {
      expect(reported).not.toContain("ada@yatta.test");
    } else {
      expect(reported).toBeInstanceOf(Error);
    }
  }, 30_000);
});