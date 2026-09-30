import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * A Google ID token as issued to a client app.
 *
 * The token is opaque here: nothing about its claims is trusted until
 * `GoogleAuthProvider` has verified the signature and the audience against our
 * own client ids.
 */
export class GoogleAuthDto {
  @ApiProperty({
    description: 'ID token from the Google Identity Services credential response',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  idToken: string;
}

/** A Facebook user access token, obtained with the `email` permission. */
export class FacebookAuthDto {
  @ApiProperty({ description: 'Facebook user access token' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  accessToken: string;
}
