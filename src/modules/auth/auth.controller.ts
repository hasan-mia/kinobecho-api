import { Controller, Post, Body, Request, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FacebookAuthDto, GoogleAuthDto } from './dto/social-auth.dto';
import {
  RequestOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
  VerifyPhoneOtpDto,
} from './dto/otp.dto';
import { OtpPurpose } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({
    type: RegisterDto,
    description: 'User registration details',
  })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            roleId: { type: 'string', nullable: true },
          },
        },
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        accessExpiresIn: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 409, description: 'Conflict - email already exists' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({ summary: 'Login user' })
  @ApiBody({
    type: LoginDto,
    description: 'User login credentials',
  })
  @ApiResponse({
    status: 200,
    description: 'User logged in successfully',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            roleId: { type: 'string', nullable: true },
          },
        },
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        accessExpiresIn: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: 'Sign in or register with a Google ID token',
    description:
      'Links to an existing account when Google asserts an email that already ' +
      'belongs to one, otherwise creates a passwordless customer account.',
  })
  @ApiBody({ type: GoogleAuthDto })
  @ApiResponse({ status: 200, description: 'Signed in; tokens issued' })
  @ApiResponse({ status: 401, description: 'Invalid token, or email not verified' })
  @ApiResponse({ status: 503, description: 'Google sign-in is not configured' })
  async google(@Body() dto: GoogleAuthDto) {
    return this.authService.loginWithGoogle(dto.idToken);
  }

  @Public()
  @Post('facebook')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: 'Sign in or register with a Facebook user access token',
  })
  @ApiBody({ type: FacebookAuthDto })
  @ApiResponse({ status: 200, description: 'Signed in; tokens issued' })
  @ApiResponse({ status: 401, description: 'Invalid token, or issued for another app' })
  @ApiResponse({ status: 503, description: 'Facebook sign-in is not configured' })
  async facebook(@Body() dto: FacebookAuthDto) {
    return this.authService.loginWithFacebook(dto.accessToken);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refresh(body.refreshToken);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: 'Request an OTP code by SMS',
    description:
      'Always responds identically whether or not the phone belongs to a user, ' +
      'so this endpoint cannot be used to discover registered numbers.',
  })
  @ApiResponse({ status: 200, description: 'Code sent, if the request was allowed' })
  @ApiResponse({ status: 400, description: 'Invalid phone number' })
  @ApiResponse({ status: 429, description: 'Too many requests for this phone' })
  async requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.phone, dto.purpose);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: 'Verify an OTP code and sign in (LOGIN) or register (REGISTER)',
  })
  @ApiResponse({ status: 200, description: 'Verified; tokens issued' })
  @ApiResponse({ status: 400, description: 'Invalid or expired code' })
  @ApiResponse({ status: 401, description: 'No user for this phone (LOGIN)' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code, dto.purpose);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: 'Reset a password with a RESET_PASSWORD OTP',
    description: 'Revokes every refresh token for the user on success.',
  })
  @ApiResponse({ status: 200, description: 'Password reset' })
  @ApiResponse({ status: 400, description: 'Invalid code or weak password' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.phone, dto.code, dto.newPassword);
  }

  @Post('verify-phone')
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({ summary: "Verify the authenticated user's own phone number" })
  @ApiResponse({ status: 200, description: 'Phone verified' })
  async verifyPhone(@Body() dto: VerifyPhoneOtpDto, @Request() req: any) {
    return this.authService.verifyPhone(
      req.user.id,
      dto.code,
      dto.purpose ?? OtpPurpose.VERIFY_PHONE,
    );
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'User logged out successfully' })
  async logout(@Request() req: any) {
    await this.authService.logout(req.user.id);
    return { message: 'Logged out successfully' };
  }
}