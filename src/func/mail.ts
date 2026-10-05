import { createMailer } from "../types/mail";

export interface AppTemplates {
  welcome: {
    name: string;
    verifyUrl: string;
  };
}

declare module "../types/mail" {
  interface MailRegister {
    templates: AppTemplates;
  }
}

export const mailer = createMailer({
  defaultFrom: "Yatta App <hello@yatta.dev>",
  mode: process.env.NODE_ENV === "production" ? "smtp" : "terminal",
});

mailer.registerLayout(
  "default",
  `<!DOCTYPE html>
  <html>
    <body style="font-family:sans-serif;background:#fafafa;padding:20px;">
      <div style="background:#fff;padding:24px;border-radius:8px;max-width:600px;margin:auto;">
        {{{content}}}
      </div>
    </body>
  </html>`,
);

mailer.registerTemplate<AppTemplates["welcome"]>("welcome", {
  subject: "Welcome to Yatta, {{name}}!",
  layout: "default",
  html: `
    <h2>Welcome, {{name}} 👋</h2>
    <p>Please click below to verify your email address:</p>
    <a href="{{{verifyUrl}}}" style="background:#2563eb;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px;display:inline-block;">
      Verify Email
    </a>
  `,
});
