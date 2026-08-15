import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AI_TUTOR_QUEUE } from './ai-tutor.constants';

import { NemotronService } from './services/nemotron.service';
import { VideoAnalyticsService } from './services/video-analytics.service';
import { WeakTopicDetectionService } from './services/weak-topic-detection.service';
import { AttentionSpanService } from './services/attention-span.service';
import { TimetableService } from './services/timetable.service';
import { RevisionTestService } from './services/revision-test.service';
import { PeerTeachingService } from './services/peer-teaching.service';
import { CreditService } from './services/credit.service';
import { StudyGroupService } from './services/study-group.service';

import { AiEvaluationProcessor } from './processors/ai-evaluation.processor';

import { VideoAnalyticsController } from './controllers/video-analytics.controller';
import { RevisionTestController } from './controllers/revision-test.controller';
import { PeerTeachingController } from './controllers/peer-teaching.controller';
import { CreditsController } from './controllers/credits.controller';
import { InsightsController } from './controllers/insights.controller';

@Module({
  imports: [
    BullModule.registerQueue({
      name: AI_TUTOR_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    }),
  ],
  controllers: [
    VideoAnalyticsController,
    RevisionTestController,
    PeerTeachingController,
    CreditsController,
    InsightsController,
  ],
  providers: [
    NemotronService,
    VideoAnalyticsService,
    WeakTopicDetectionService,
    AttentionSpanService,
    TimetableService,
    RevisionTestService,
    PeerTeachingService,
    CreditService,
    StudyGroupService,
    AiEvaluationProcessor,
  ],
  exports: [
    WeakTopicDetectionService,
    CreditService,
    StudyGroupService,
    TimetableService,
  ],
})
export class AiTutorModule {}
