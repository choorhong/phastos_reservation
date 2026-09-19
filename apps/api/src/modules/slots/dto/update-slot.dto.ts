import { IsInt, Min } from 'class-validator';

export class UpdateSlotDto {
  /** 0 closes the slot (e.g. a holiday); the upper bound is `SLOT_CAPACITY`. */
  @IsInt()
  @Min(0)
  capacity: number;
}
