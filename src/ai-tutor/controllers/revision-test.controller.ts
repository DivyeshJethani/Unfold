import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RevisionTestService } from '../services/revision-test.service';
import { SubmitRevisionTestDto } from '../dto/revision-test.dto';
import { CurrentStudentId } from '../decorators/current-student.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('revision-tests')
@Controller('revision-tests')
export class RevisionTestController {
  constructor(
    private readonly revisionTestService: RevisionTestService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('lectures/:lectureId/generate')
  @ApiOperation({ summary: 'Manually trigger a revision test for a lecture (normally auto-fires on completion)' })
  async generate(
    @Param('lectureId', ParseUUIDPipe) lectureId: string,
    @CurrentStudentId() studentId: string,
  ) {
    return this.revisionTestService.createForLecture({
      studentId,
      lectureId,
      triggeredBy: 'POST_LECTURE',
    });
  }

  @Post(':revisionTestId/submit')
  @ApiOperation({ summary: 'Submit answers to a revision test; triggers mastery recompute + credits' })
  async submit(
    @Param('revisionTestId', ParseUUIDPipe) revisionTestId: string,
    @Body() dto: SubmitRevisionTestDto,
  ) {
    return this.revisionTestService.submit({
      revisionTestId,
      responses: dto.responses,
      freeTextExplanation: dto.freeTextExplanation,
    });
  }

  @Get('mine')
  @ApiOperation({ summary: "List the current student's revision test history" })
  async mine(@CurrentStudentId() studentId: string) {
    return this.prisma.revisionTest.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      include: { lecture: { include: { topic: true } } },
    });
  }
}
