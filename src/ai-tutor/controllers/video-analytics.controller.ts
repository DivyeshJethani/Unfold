import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VideoAnalyticsService } from '../services/video-analytics.service';
import { RecordVideoEventDto } from '../dto/video-event.dto';
import { CurrentStudentId } from '../decorators/current-student.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_TUTOR_QUEUE, JOB_NAMES } from '../ai-tutor.constants';

@ApiTags('video-analytics')
@Controller('lectures/:lectureId/events')
export class VideoAnalyticsController {
  constructor(
    private readonly videoAnalytics: VideoAnalyticsService,
    private readonly prisma: PrismaService,
    @InjectQueue(AI_TUTOR_QUEUE) private readonly queue: Queue,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Record a video player interaction event (play/pause/rewind/skip/speed-change/complete/drop-off)',
  })
  @ApiOkResponse({ description: 'Event recorded; heavy analysis is queued asynchronously' })
  async recordEvent(
    @Param('lectureId', ParseUUIDPipe) lectureId: string,
    @CurrentStudentId() studentId: string,
    @Body() dto: RecordVideoEventDto,
  ) {
    const event = await this.videoAnalytics.recordEvent({ studentId, lectureId, ...dto });

    // On COMPLETE or DROP_OFF, kick off async mastery recompute + (for
    // COMPLETE) revision-test generation. Kept event-driven rather than
    // polling so the student gets their revision test within seconds of
    // finishing the lecture.
    if (dto.eventType === 'COMPLETE' || dto.eventType === 'DROP_OFF') {
      const lecture = await this.prisma.lecture.findUniqueOrThrow({ where: { id: lectureId } });
      await this.queue.add(JOB_NAMES.RECOMPUTE_TOPIC_MASTERY, {
        studentId,
        lectureId,
        topicId: lecture.topicId,
      });
      if (dto.eventType === 'COMPLETE') {
        await this.queue.add(JOB_NAMES.EVALUATE_REVISION_TEST, { studentId, lectureId });
      }
    }

    return event;
  }
}
