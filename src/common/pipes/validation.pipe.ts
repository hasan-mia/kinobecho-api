import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class CustomValidationPipe implements PipeTransform {
  async transform(value: any, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    const object = plainToInstance(metatype, value, {
      excludeExtraneousValues: true,
    });

    const errors = await validate(object);
    if (errors.length > 0) {
      const messages = errors.map(
        (error) =>
          `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      );
      throw new BadRequestException({
        message: 'Validation failed',
        error: messages,
      });
    }

    return object;
  }

  private toValidate(metatype: new (...args: any[]) => unknown): boolean {
    const types: Array<new (...args: any[]) => unknown> = [
      String,
      Boolean,
      Number,
      Array,
      Object,
    ];
    return !types.includes(metatype);
  }
}