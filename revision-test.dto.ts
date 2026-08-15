import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';

class RevisionTestResponseItemDto {
  @ApiProperty()
  @IsUUID()
  questionId: string;

  @ApiProperty()
  @IsString()
  selectedOptionId: string;
}

export class SubmitRevisionTestDto {
  @ApiProperty({ type: [RevisionTestResponseItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RevisionTestResponseItemDto)
  responses: RevisionTestResponseItemDto[];

  @ApiProperty({
    required: false,
    description: 'Optional free-text explanation the student wrote, graded by Nemotron',
  })
  @IsOptional()
  @IsString()
  freeTextExplanation?: string;
}
