import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';

import { envValidationSchema } from './config/env.validation';
import {
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  localPaymentsConfig,
  codConfig,
  orderConfig,
  smsConfig,
  otpConfig,
  returnsConfig,
  shippingConfig,
  storageConfig,
  mailConfig,
  throttleConfig,
  logConfig,
} from './config/configuration';

import { PrismaService } from './database/prisma.service';
import { PrismaModule } from './database/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { RedisCacheModule } from './common/cache/redis-cache.module';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler-storage';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { VendorModule } from './modules/vendor/vendor.module';
import { CategoryModule } from './modules/category/category.module';
import { ProductModule } from './modules/product/product.module';
import { StorageModule } from './modules/storage/storage.module';
import { CartModule } from './modules/cart/cart.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { ChatModule } from './modules/chat/chat.module';
import { NotificationModule } from './modules/notification/notification.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { ProcessorsModule } from './processors/processors.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      } as any,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
        localPaymentsConfig,
  codConfig,
  orderConfig,
        orderConfig,
        smsConfig,
        otpConfig,
        returnsConfig,
        shippingConfig,
        storageConfig,
        mailConfig,
        throttleConfig,
        logConfig,
      ],
    }),

    RedisCacheModule,

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB'),
        };
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            password: redis.password,
            db: redis.db,
          },
        };
      },
    }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const throttlerStorage = new RedisThrottlerStorage(configService);
        return {
          throttlers: [
            {
              ttl: configService.get<number>('THROTTLE_TTL') ?? 60,
              limit: configService.get<number>('THROTTLE_LIMIT') ?? 100,
            },
          ],
          storage: throttlerStorage,
        };
      },
    }),

    JwtModule.register({}),
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PaymentsModule,
    WebhooksModule,
    VendorModule,
    CategoryModule,
    ProductModule,
    StorageModule,
    CartModule,
    OrdersModule,
    CouponsModule,
    PayoutsModule,
    ReviewsModule,
    ChatModule,
    NotificationModule,
    ShippingModule,
    ReturnsModule,
    ProcessorsModule,
  ],
  providers: [
    PrismaService,
    JwtAuthGuard,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}