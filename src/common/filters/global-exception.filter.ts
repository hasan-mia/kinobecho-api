import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

interface ErrorResponse {
  message: string;
  timestamp: string;
  path: string;
  statusCode: number;
  error?: string;
  details?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const errorResponse: ErrorResponse = {
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
      path: request.url,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    };

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const { statusCode, message } = this.handlePrismaError(exception);
      errorResponse.statusCode = statusCode;
      errorResponse.message = message;
      this.logger.error(
        `Prisma error: ${exception.code} - ${exception.message}`,
        exception.stack,
      );
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse() as Record<string, unknown>;
      errorResponse.statusCode = exception.getStatus();
      const bodyMessage = body['message'];
      if (Array.isArray(bodyMessage)) {
        errorResponse.details = bodyMessage;
        errorResponse.message =
          (body['error'] as string) || exception.message;
      } else {
        errorResponse.message = (bodyMessage as string) || exception.message;
        errorResponse.error = body['error'] as string;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private handlePrismaError(
    error: Prisma.PrismaClientKnownRequestError,
  ): { statusCode: number; message: string } {
    switch (error.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'A record with this value already exists',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found',
        };
      case 'P2023':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Invalid query condition',
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database operation failed',
        };
    }
  }
}