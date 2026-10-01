import { Resend } from 'resend';
import { EmailService, OutgoingEmail } from './email.service';

jest.mock('resend');

describe('EmailService', () => {
  const send = jest.fn();
  const logger = { warn: jest.fn() };
  const email: OutgoingEmail = {
    to: 'alice@example.com',
    subject: 'Your booking is confirmed',
    text: 'Hello',
    html: '<p>Hello</p>',
    idempotencyKey: 'm1',
  };

  function service(env: Record<string, string | undefined>): EmailService {
    const config = {
      get: (key: string) =>
        ({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Phastos <a@b.c>', ...env })[key],
    };
    return new EmailService(config as never, logger as never);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    (Resend as unknown as jest.Mock).mockImplementation(() => ({ emails: { send } }));
    send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });

  it('sends to the real recipient, with the idempotency key, when no redirect is set', async () => {
    await expect(service({}).send(email)).resolves.toBe('email-1');
    expect(send).toHaveBeenCalledWith(
      {
        from: 'Phastos <a@b.c>',
        to: 'alice@example.com',
        subject: 'Your booking is confirmed',
        text: 'Hello',
        html: '<p>Hello</p>',
      },
      { idempotencyKey: 'm1' },
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('redirects to EMAIL_REDIRECT_TO and names the intended recipient', async () => {
    const svc = service({ EMAIL_REDIRECT_TO: 'me@example.com' });
    await svc.send(email);

    const [payload] = send.mock.calls[0];
    expect(payload.to).toBe('me@example.com');
    expect(payload.subject).toBe('[Phastos] Your booking is confirmed');
    expect(payload.text).toBe(
      'Dev redirect: this email was addressed to alice@example.com.\n\nHello',
    );
    expect(payload.html).toContain('addressed to alice@example.com.');
    expect(payload.html).toContain('<p>Hello</p>');
    expect(logger.warn).toHaveBeenCalledWith(
      { redirectTo: 'me@example.com' },
      'email.redirect_enabled',
    );
  });

  it('throws when Resend returns an error', async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'nope' },
    });
    await expect(service({}).send(email)).rejects.toThrow(
      'Resend send failed (validation_error): nope',
    );
  });
});
