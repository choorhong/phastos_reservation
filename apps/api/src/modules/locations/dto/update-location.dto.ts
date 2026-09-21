import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Only `name` and `address` can be edited. Every other field in the body
 * (`timezone` included) is dropped by the global `ValidationPipe`'s
 * `whitelist`, not rejected. A timezone is left out on purpose: the
 * location's slots were generated in it, so changing it would mean
 * regenerating them.
 */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;
}
