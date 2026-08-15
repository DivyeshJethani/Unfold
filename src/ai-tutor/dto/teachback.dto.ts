import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MinLength } from 'class-validator';

export class SubmitAiTeachbackDto {
  @ApiProperty()
  @IsUUID()
  topicId: string;

  @ApiProperty({ description: 'The student explaining the topic in their own words' })
  @IsString()
  @MinLength(20, { message: 'Explanation is too short to evaluate meaningfully' })
  explanation: string;
}

export class ResolvePeerSessionDto {
  @ApiProperty({ description: 'Score 0..1 from the tutee\'s post-session check' })
  tuteePostSessionScore: number;
}

export class RedeemRewardDto {
  @ApiProperty()
  @IsUUID()
  rewardItemId: string;
}
