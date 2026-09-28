import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    const id = correlationId ?? uuidv4();

    (req as Request & { correlationId: string }).correlationId = id;
    res.setHeader('x-correlation-id', id);

    res.on('finish', () => {
      this.logger.log(
        `${req.method} ${req.url} ${res.statusCode} [${id}]`,
      );
    });

    next();
  }
}
