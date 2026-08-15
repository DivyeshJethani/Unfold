import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WeaknessSignal, TopicMasteryUpdateResult } from '../interfaces/scoring.interface';
import {
  MASTERY_EWMA_ALPHA,
  MASTERY_THRESHOLDS,
  AI_TEACHBACK_ESCALATION_THRESHOLD,
} from '../ai-tutor.constants';

/**
 * This is the fusion point: every signal source (exam marks, quiz answers,
 * video-interaction behavior, revision-test results, peer-teaching outcomes)
 * ultimately reduces to a WeaknessSignal and flows through here.
 *
 * Design choice: EWMA (exponentially weighted moving average) over a raw
 * running average, because:
 *  - it naturally weights recent evidence more heavily (a student who was
 *    weak last term but has aced the last 3 quizzes should update quickly)
 *  - it's O(1) to update per signal — no need to re-scan history each time,
 *    which matters once a student has months of quiz/video data
 *  - it's simple enough to explain to a parent/teacher in the UI ("your
 *    score moves toward each new result, weighted by how much we trust it")
 */
@Injectable()
export class WeakTopicDetectionService {
  private readonly logger = new Logger(WeakTopicDetectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async applySignal(signal: WeaknessSignal): Promise<TopicMasteryUpdateResult> {
    const existing = await this.prisma.topicMastery.findUnique({
      where: { studentId_topicId: { studentId: signal.studentId, topicId: signal.topicId } },
    });

    const previousScore = existing?.masteryScore ?? 0.5;
    const previousConfidence = existing?.confidence ?? 0.3;
    const previousLevel = existing?.masteryLevel ?? 'DEVELOPING';
    const previousFailures = existing?.consecutiveFailures ?? 0;

    // Signal confidence modulates the effective learning rate: a
    // high-confidence signal (e.g. a graded revision test) moves the score
    // more than a low-confidence one (e.g. rewind density).
    const effectiveAlpha = MASTERY_EWMA_ALPHA * signal.confidence;

    // strengthDelta is -1..+1 evidence; we map it onto the 0..1 mastery
    // scale as a pull toward 0 or 1, not an additive delta, so repeated
    // strong evidence saturates instead of overshooting past the bounds.
    const target = signal.strengthDelta >= 0
      ? previousScore + (1 - previousScore) * signal.strengthDelta
      : previousScore + previousScore * signal.strengthDelta; // strengthDelta negative here

    const newScore = this.clamp01(
      previousScore + effectiveAlpha * (target - previousScore),
    );

    // Confidence itself grows with more evidence (asymptotically), so early
    // signals don't over-claim certainty about a student's ability.
    const newConfidence = this.clamp01(previousConfidence + 0.08 * (1 - previousConfidence));

    const newLevel = this.scoreToLevel(newScore);

    const isFailureSignal =
      (signal.source === 'REVISION_TEST' || signal.source === 'QUIZ') &&
      signal.strengthDelta < 0;
    const consecutiveFailures = isFailureSignal ? previousFailures + 1 : 0;

    const needsReview = newScore < MASTERY_THRESHOLDS.WEAK || consecutiveFailures >= 1;

    const triggeredAiTeachback =
      needsReview && consecutiveFailures > 0 && consecutiveFailures < AI_TEACHBACK_ESCALATION_THRESHOLD;
    const triggeredPeerEscalation =
      needsReview && consecutiveFailures >= AI_TEACHBACK_ESCALATION_THRESHOLD;

    await this.prisma.topicMastery.upsert({
      where: { studentId_topicId: { studentId: signal.studentId, topicId: signal.topicId } },
      create: {
        studentId: signal.studentId,
        topicId: signal.topicId,
        masteryScore: newScore,
        masteryLevel: newLevel,
        confidence: newConfidence,
        needsReview,
        consecutiveFailures,
      },
      update: {
        masteryScore: newScore,
        masteryLevel: newLevel,
        confidence: newConfidence,
        needsReview,
        consecutiveFailures,
        lastEvaluatedAt: new Date(),
      },
    });

    this.logger.debug(
      `mastery update student=${signal.studentId} topic=${signal.topicId} ` +
        `${previousScore.toFixed(2)} -> ${newScore.toFixed(2)} (source=${signal.source})`,
    );

    return {
      studentId: signal.studentId,
      topicId: signal.topicId,
      previousScore,
      newScore,
      previousLevel,
      newLevel,
      needsReview,
      triggeredAiTeachback,
      triggeredPeerEscalation,
    };
  }

  async applySignals(signals: WeaknessSignal[]): Promise<TopicMasteryUpdateResult[]> {
    const results: TopicMasteryUpdateResult[] = [];
    // Sequential on purpose: signals for the same topic must be applied in
    // order for the EWMA to be meaningful (order matters for a moving avg).
    for (const s of signals) {
      results.push(await this.applySignal(s));
    }
    return results;
  }

  /** Convert a raw exam mark into a weakness signal against a topic/subject. */
  buildSignalFromExamMark(params: {
    studentId: string;
    topicId: string;
    marksObtained: number;
    maxMarks: number;
  }): WeaknessSignal {
    const ratio = params.maxMarks > 0 ? params.marksObtained / params.maxMarks : 0;
    // Center at 0.6 (a "C grade" boundary in most Indian school rubrics) so
    // marks below that pull mastery down, above it pull it up.
    const strengthDelta = this.clamp(-1, 1, (ratio - 0.6) / 0.4);
    return {
      source: 'EXAM',
      topicId: params.topicId,
      studentId: params.studentId,
      strengthDelta,
      confidence: 0.7, // school exams are high-trust signals
      occurredAt: new Date(),
      meta: { marksObtained: params.marksObtained, maxMarks: params.maxMarks },
    };
  }

  buildSignalFromQuizAttempt(params: {
    studentId: string;
    topicId: string;
    score: number; // 0..1
  }): WeaknessSignal {
    return {
      source: 'QUIZ',
      topicId: params.topicId,
      studentId: params.studentId,
      strengthDelta: this.clamp(-1, 1, (params.score - 0.6) / 0.4),
      confidence: 0.55,
      occurredAt: new Date(),
      meta: { score: params.score },
    };
  }

  buildSignalFromRevisionTest(params: {
    studentId: string;
    topicId: string;
    score: number; // 0..1
    nemotronQualityScore?: number;
  }): WeaknessSignal {
    // Blend the objective score with Nemotron's qualitative read when
    // available (free-text answers), weighting the objective score higher.
    const blended =
      params.nemotronQualityScore != null
        ? 0.6 * params.score + 0.4 * params.nemotronQualityScore
        : params.score;
    return {
      source: 'REVISION_TEST',
      topicId: params.topicId,
      studentId: params.studentId,
      strengthDelta: this.clamp(-1, 1, (blended - 0.65) / 0.35),
      confidence: 0.65,
      occurredAt: new Date(),
      meta: { score: params.score, nemotronQualityScore: params.nemotronQualityScore },
    };
  }

  buildSignalFromPeerTeaching(params: {
    tuteeId: string;
    topicId: string;
    postSessionQuizScore: number; // 0..1, quick check right after the session
  }): WeaknessSignal {
    return {
      source: 'PEER_TEACHING',
      topicId: params.topicId,
      studentId: params.tuteeId,
      strengthDelta: this.clamp(-1, 1, (params.postSessionQuizScore - 0.6) / 0.4),
      confidence: 0.6,
      occurredAt: new Date(),
    };
  }

  async listWeakTopicsForStudent(studentId: string) {
    return this.prisma.topicMastery.findMany({
      where: { studentId, needsReview: true },
      include: { topic: { include: { subject: true } } },
      orderBy: { masteryScore: 'asc' },
    });
  }

  private scoreToLevel(score: number): 'WEAK' | 'DEVELOPING' | 'PROFICIENT' | 'STRONG' {
    if (score < MASTERY_THRESHOLDS.WEAK) return 'WEAK';
    if (score < MASTERY_THRESHOLDS.DEVELOPING) return 'DEVELOPING';
    if (score < MASTERY_THRESHOLDS.PROFICIENT) return 'PROFICIENT';
    return 'STRONG';
  }

  private clamp01(n: number) {
    return Math.min(1, Math.max(0, n));
  }
  private clamp(min: number, max: number, n: number) {
    return Math.min(max, Math.max(min, n));
  }
}
