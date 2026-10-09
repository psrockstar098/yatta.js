// yatta/func/mail.ts
//
// Terminal output in development; "smtp" in production.
import { createMailer } from "yatta.js/mail";

export interface AppTemplates {
  welcome: { name: string; verifyUrl: string };
}

declare module "yatta.js/mail" {
  interface MailRegister {
    templates: AppTemplates;
  }
}

export const mailer = createMailer({
  defaultFrom: process.env.MAIL_FROM || "Yatta App <hello@localhost>",
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
    <h2>Welcome, {{name}}</h2>
    <p>Please confirm your email address:</p>
    <a href="{{{verifyUrl}}}">Verify Email</a>
  `,
});
