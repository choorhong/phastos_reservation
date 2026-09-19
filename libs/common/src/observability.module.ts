import { randomUUID } from 'crypto';
import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'http';

/**
 * Baseline observability wiring, present from project scaffold (see PLAN.md
 * "Decisions" §3) rather than retrofitted later:
 *  - ClsModule gives every request a `correlationId` in async-local-storage,
 *    readable from anywhere in the request's call graph (service, Redis hold,
 *    Kafka publish, RabbitMQ enqueue) without threading it through every
 *    function signature.
 *  - nestjs-pino gives structured (JSON in prod, pretty in dev) logs, with
 *    the correlationId auto-attached to every HTTP access log line.
 *
 * Downstream code should inject `Logger` from 'nestjs-pino' and read
 * `cls.get('correlationId')` (via `ClsService`) when logging slot
 * claim/release events, so every log line for one booking attempt can be
 * traced across Redis -> Postgres -> Kafka -> RabbitMQ hops.
 */
function extractCorrelationId(req: IncomingMessage): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  return randomUUID();
}

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingMessage) => extractCorrelationId(req),
      },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Jest sets NODE_ENV=test; keep test output readable.
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
        genReqId: (req: IncomingMessage) => extractCorrelationId(req),
        customProps: (req: IncomingMessage & { id?: string }) => ({
          correlationId: req.id,
        }),
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
  ],
  exports: [ClsModule, LoggerModule],
})
export class ObservabilityModule {}
