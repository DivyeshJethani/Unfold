import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export enum VideoEventTypeDto {
  PLAY = 'PLAY',
  PAUSE = 'PAUSE',
  REWIND = 'REWIND',
  FAST_FORWARD = 'FAST_FORWARD',
  SKIP_SECTION = 'SKIP_SECTION',
  SPEED_CHANGE = 'SPEED_CHANGE',
  COMPLETE = 'COMPLETE',
  DROP_OFF = 'DROP_OFF',
}

export class RecordVideoEventDto {
  @ApiProperty()
  @IsUUID()
  lectureId: string;

  @ApiProperty({ enum: VideoEventTypeDto })
  @IsEnum(VideoEventTypeDto)
  eventType: VideoEventTypeDto;

  @ApiProperty({ description: 'Playhead position in seconds when the event fired' })
  @IsInt()
  @Min(0)
  atSecond: number;

  @ApiProperty({ required: false, description: 'Destination second, for REWIND/SKIP/FAST_FORWARD' })
  @IsOptional()
  @IsInt()
  @Min(0)
  toSecond?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  playbackSpeed?: number;
}
