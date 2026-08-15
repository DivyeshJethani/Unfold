import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AI_TUTOR_QUEUE, JOB_NAMES } from '../ai-tutor.constants';
import { VideoAnalyticsService } from '../services/video-analytics.service';
import { WeakTopicDetectionService } from '../services/weak-topic-detection.service';
import { RevisionTestService } from '../services/revision-test.service';
import { AttentionSpanService } from '../services/attention-span.service';

/**
 * All Nemotron calls and heavy aggregation happen off the request path,
 * here. Rationale: a video COMPLETE event, or a batch of pause/rewind
 * events, should return 202-fast to the client — the actual mastery
 * recompute and (if triggered) revision-test generation can take a few
 * hundred ms to a couple seconds and shouldn't block the video player.
 */
@Processor(AI_TUTOR_QUEUE)
export class AiEvaluationProcessor extends WorkerHost {
  private readonly logger = new Logger(AiEvaluationProcessor.name);

  constructor(
    private readonly videoAnalytics: VideoAnalyticsService,
    private readonly weakTopicService: WeakTopicDetectionService,
    private readonly revisionTestService: RevisionTestService,
    private readonly attentionService: AttentionSpanService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    switch (job.name) {
      case JOB_NAMES.RECOMPUTE_TOPIC_MASTERY:
        return this.handleRecomputeMastery(job);
      case JOB_NAMES.EVALUATE_REVISION_TEST:
        return this.handleGeneratePostLectureTest(job);
      case JOB_NAMES.GENERATE_TIMETABLE:
        return this.handleRecomputeAttention(job);
      default:
        this.logger.warn(`Unhandled job type: ${job.name}`);
        return null;
    }
  }

  /**
   * Triggered on lecture COMPLETE / DROP_OFF: aggregate this student's raw
   * video events into weakness signals and fold them into mastery.
   */
  private async handleRecomputeMastery(
    job: Job<{ studentId: string; lectureId: string; topicId: string }>,
  ) {
    const { studentId, lectureId, topicId } = job.data;
    const summary = await this.videoAnalytics.summarize(studentId, lectureId);
    const signals = this.videoAnalytics.toWeaknessSignals(summary, topicId);
    const results = await this.weakTopicService.applySignals(signals);

    this.logger.log(
      `Recomputed mastery for student=${studentId} topic=${topicId}: ` +
        `${results.length} signal(s) applied`,
    );
    return results;
  }

  /** Triggered right after a lecture COMPLETE event. */
  private async handleGeneratePostLectureTest(
    job: Job<{ studentId: string; lectureId: string }>,
  ) {
    const { studentId, lectureId } = job.data;
    const test = await this.revisionTestService.createForLecture({
      studentId,
      lectureId,
      triggeredBy: 'POST_LECTURE',
    });
    this.logger.log(`Generated post-lecture revision test ${test.id} for student=${studentId}`);
    return test;
  }

  /** Nightly / periodic job: refresh attention span + memory retention. */
  private async handleRecomputeAttention(job: Job<{ studentId: string }>) {
    return this.attentionService.recomputeForStudent(job.data.studentId);
  }
}
