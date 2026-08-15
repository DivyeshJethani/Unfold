import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WeakTopicDetectionService } from '../services/weak-topic-detection.service';
import { TimetableService } from '../services/timetable.service';
import { AttentionSpanService } from '../services/attention-span.service';
import { CurrentStudentId } from '../decorators/current-student.decorator';

@ApiTags('insights')
@Controller('insights')
export class InsightsController {
  constructor(
    private readonly weakTopicService: WeakTopicDetectionService,
    private readonly timetableService: TimetableService,
    private readonly attentionService: AttentionSpanService,
  ) {}

  @Get('weak-topics')
  @ApiOperation({ summary: "List the current student's weak topics, weakest first" })
  async weakTopics(@CurrentStudentId() studentId: string) {
    return this.weakTopicService.listWeakTopicsForStudent(studentId);
  }

  @Get('attention-profile')
  @ApiOperation({ summary: "Get (recomputing if needed) the current student's attention/memory profile" })
  async attentionProfile(@CurrentStudentId() studentId: string) {
    return this.attentionService.recomputeForStudent(studentId);
  }

  @Get('timetable')
  @ApiOperation({ summary: "Generate today's personalized study timetable" })
  async timetable(@CurrentStudentId() studentId: string, @Query('date') date?: string) {
    return this.timetableService.generateDailyTimetable(studentId, date ? new Date(date) : undefined);
  }
}
