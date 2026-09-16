import type { Env } from '../env';

/**
 * Outgoing mail.
 *
 * One narrow interface with a real provider and an honest null provider. The
 * important property is that "not configured" is a first-class, visible outcome:
 * the delivery record says the mail was not sent rather than reporting a success
 * that never happened.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  from?: string;
}

export interface MailResult {
  ok: boolean;
  /** Present when the message was handed to a provider. */
  providerMessageId?: string;
  /** True when no provider is configured; the message was not transmitted. */
  skipped?: boolean;
  error?: string;
}

export interface Mailer {
  readonly name: string;
  readonly configured: boolean;
  send(message: MailMessage): Promise<MailResult>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resend
 * ──────────────────────────────────────────────────────────────────────────── */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendMailerOptions {
  apiKey: string;
  from: string;
  replyTo?: string;
}

function resendMailer(options: ResendMailerOptions): Mailer {
  return {
    name: 'resend',
    configured: true,

    async send(message: MailMessage): Promise<MailResult> {
      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: message.from ?? options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
            ...(message.replyTo ?? options.replyTo
              ? { reply_to: message.replyTo ?? options.replyTo }
              : {}),
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { id?: string; message?: string; error?: string }
          | null;

        if (!response.ok) {
          return {
            ok: false,
            error: payload?.message ?? payload?.error ?? `Provider returned ${response.status}`,
          };
        }

        return { ok: true, ...(payload?.id ? { providerMessageId: payload.id } : {}) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Null provider
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Used when no provider key is configured — development, tests, and a first
 * deploy that has not set the secret yet. It reports what it *would* have sent so
 * the operator can verify the content, and never claims success.
 */
function notConfiguredMailer(): Mailer {
  return {
    name: 'not-configured',
    configured: false,

    async send(message: MailMessage): Promise<MailResult> {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'outgoing mail not configured; message not sent',
          to: message.to,
          subject: message.subject,
        }),
      );

      return {
        ok: false,
        skipped: true,
        error: 'No mail provider is configured. Set MAIL_PROVIDER_API_KEY to enable delivery.',
      };
    },
  };
}

/** Selects a mailer from the environment. */
export function createMailer(env: Env): Mailer {
  const apiKey = env.MAIL_PROVIDER_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  const replyTo = env.MAIL_REPLY_TO?.trim();

  if (!apiKey || !from) return notConfiguredMailer();

  return resendMailer({
    apiKey,
    from,
    ...(replyTo ? { replyTo } : {}),
  });
}
