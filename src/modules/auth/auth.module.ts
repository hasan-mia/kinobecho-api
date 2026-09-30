import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { PrismaModule } from '../../database/prisma.module';
import { OtpService } from './otp.service';
import { NotificationModule } from '../notification/notification.module';
import { GoogleAuthProvider } from './social/google-auth.provider';
import { FacebookAuthProvider } from './social/facebook-auth.provider';

@Module({
  imports: [
    PrismaModule,
    NotificationModule,
    PassportModule,
    JwtModule.register({}),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    JwtStrategy,
    JwtRefreshStrategy,
    GoogleAuthProvider,
    FacebookAuthProvider,
  ],
  exports: [AuthService, OtpService],
})
export class AuthModule {}