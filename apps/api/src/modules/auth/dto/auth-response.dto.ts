import { ApiProperty } from '@nestjs/swagger';

/** What `/auth/register` and `/auth/login` both return. */
export class AuthResponseDto {
  @ApiProperty({ description: 'Bearer JWT -- send as `Authorization: Bearer <accessToken>`.' })
  accessToken: string;
}
