import { ApiProperty } from '@nestjs/swagger';

/** What `POST /slots/generate` returns. */
export class GenerateSlotsResponseDto {
  @ApiProperty({ description: 'How many new slot rows this sweep inserted.' })
  created: number;
}
