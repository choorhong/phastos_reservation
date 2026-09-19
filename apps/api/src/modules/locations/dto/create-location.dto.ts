import { IsNotEmpty, IsString, IsTimeZone } from 'class-validator';

export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsTimeZone()
  timezone: string;
}
