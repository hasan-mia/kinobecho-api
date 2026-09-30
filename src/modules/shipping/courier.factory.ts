import { BadRequestException, Injectable } from '@nestjs/common';
import { CourierProvider as CourierProviderEnum } from '@prisma/client';
import { CourierProvider } from './interfaces/courier-provider.interface';
import { ManualCourierProvider } from './providers/manual.provider';
import { PathaoProvider } from './providers/pathao.provider';
import { SteadfastProvider } from './providers/steadfast.provider';

/**
 * Resolves a CourierProvider enum value to its implementation. Adding a courier
 * means registering it here and adding the enum value; nothing else changes.
 */
@Injectable()
export class CourierFactory {
  constructor(
    private readonly pathao: PathaoProvider,
    private readonly steadfast: SteadfastProvider,
    private readonly manual: ManualCourierProvider,
  ) {}

  get(courier: CourierProviderEnum): CourierProvider {
    switch (courier) {
      case CourierProviderEnum.PATHAO:
        return this.pathao;
      case CourierProviderEnum.STEADFAST:
        return this.steadfast;
      case CourierProviderEnum.MANUAL:
        return this.manual;
      default:
        throw new BadRequestException(`Unsupported courier: ${courier}`);
    }
  }

  /** MANUAL is handled inline and never calls an outbound API. */
  supportsApi(courier: CourierProviderEnum): boolean {
    return courier !== CourierProviderEnum.MANUAL;
  }
}