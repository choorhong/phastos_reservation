import { Injectable } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { Resend } from 'resend';
import { AppConfigService } from '@lib/config';
import { escapeHtml } from './escape-html';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Passed to Resend as its `Idempotency-Key`: a retry of the same
   * notification (same envelope `messageId`) within Resend's 24h window is
   * answered from the first send instead of mailing the user twice -- e.g.
   * when the send succeeded but the ack to RabbitMQ didn't.
   */
  idempotencyKey: string;
}

/**
 * The one place that talks to the mail provider (Resend). Throws on any
 * send failure so the caller's retry/DLQ path handles it -- Resend's SDK
 * reports API errors as `{ error }` rather than throwing, so that is turned
 * into a throw here.
 *
 * `EMAIL_REDIRECT_TO` (dev only) sends every email to that one address
 * instead, with `[Phastos]` prefixed to the subject and the intended
 * recipient named in the first line of the body. Without a verified domain Resend only delivers to the
 * account owner's address, so this is how emails for any test user can be
 * read in development.
 */
@Injectable()
export class EmailService {
  private readonly resend: Resend;
  private readonly from: string;
  private readonly redirectTo: string | undefined;

  constructor(config: AppConfigService, logger: Logger) {
    this.resend = new Resend(config.get('RESEND_API_KEY'));
    this.from = config.get('EMAIL_FROM');
    this.redirectTo = config.get('EMAIL_REDIRECT_TO');
    if (this.redirectTo) {
      logger.warn({ redirectTo: this.redirectTo }, 'email.redirect_enabled');
    }
  }

  async send(email: OutgoingEmail): Promise<string> {
    const outgoing = this.redirectTo ? redirect(email, this.redirectTo) : email;
    const { data, error } = await this.resend.emails.send(
      {
        from: this.from,
        to: outgoing.to,
        subject: outgoing.subject,
        text: outgoing.text,
        html: outgoing.html,
      },
      { idempotencyKey: outgoing.idempotencyKey },
    );
    if (error) {
      throw new Error(`Resend send failed (${error.name}): ${error.message}`);
    }
    return data.id;
  }
}

function redirect(email: OutgoingEmail, redirectTo: string): OutgoingEmail {
  const notice = `Dev redirect: this email was addressed to ${email.to}.`;
  return {
    ...email,
    to: redirectTo,
    subject: `[Phastos] ${email.subject}`,
    text: `${notice}\n\n${email.text}`,
    html: `<p><em>${escapeHtml(notice)}</em></p>\n${email.html}`,
  };
}
