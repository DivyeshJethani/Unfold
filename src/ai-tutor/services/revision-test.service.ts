import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NemotronService } from './nemotron.service';
import { WeakTopicDetectionService } from './weak-topic-detection.service';
import { CreditService } from './credit.service';
import { CREDIT_AMOUNTS } from '../ai-tutor.constants';

interface RevisionQuestionSnapshot {
  questionId: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
}

/**
 * Fires automatically when a lecture COMPLETE event lands (wired via the
 * BullMQ processor), or on demand when the weak-topic detector flags a
 * WEAKNESS_DETECTED trigger. Picks 3-5 questions from the topic's question
 * bank, weighted toward the sub-regions the video-analytics service flagged
 * as "confused" if available.
 */
@Injectable()
export class RevisionTestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nemotron: NemotronService,
    private readonly weakTopicService: WeakTopicDetectionService,
    private readonly creditService: CreditService,
  ) {}

  async createForLecture(params: {
    studentId: string;
    lectureId: string;
    triggeredBy: 'POST_LECTURE' | 'WEAKNESS_DETECTED' | 'SCHEDULED_REVIEW';
    questionCount?: number;
  }) {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: params.lectureId },
      include: { topic: { include: { quizQuestions: true } } },
    });
    if (!lecture) throw new NotFoundException('Lecture not found');

    const count = params.questionCount ?? 4;
    const pool = [...lecture.topic.quizQuestions];
    const selected = this.pickRandom(pool, Math.min(count, pool.length));

    const snapshot: RevisionQuestionSnapshot[] = selected.map((q) => ({
      questionId: q.id,
      prompt: q.prompt,
      options: q.options as Array<{ id: string; text: string }>,
    }));

    return this.prisma.revisionTest.create({
      data: {
        studentId: params.studentId,
        lectureId: params.lectureId,
        triggeredBy: params.triggeredBy,
        questions: snapshot as any,
      },
    });
  }

  /**
   * Submit answers. Objective (MCQ) portion is scored directly; if the
   * student also submitted a free-text explanation (teach-back-lite), it's
   * sent to Nemotron and blended in. Feeds the result straight into the
   * weak-topic detector so mastery updates in the same request cycle.
   */
  async submit(params: {
    revisionTestId: string;
    responses: Array<{ questionId: string; selectedOptionId: string }>;
    freeTextExplanation?: string;
  }) {
    const test = await this.prisma.revisionTest.findUnique({
      where: { id: params.revisionTestId },
      include: { lecture: { include: { topic: true } } },
    });
    if (!test) throw new NotFoundException('Revision test not found');

    const snapshot = test.questions as unknown as RevisionQuestionSnapshot[];
    const questionRecords = await this.prisma.quizQuestion.findMany({
      where: { id: { in: snapshot.map((q) => q.questionId) } },
    });
    const correctById = new Map(questionRecords.map((q) => [q.id, q.correctOptionId]));

    let correctCount = 0;
    for (const r of params.responses) {
      if (correctById.get(r.questionId) === r.selectedOptionId) correctCount++;
    }
    const objectiveScore = snapshot.length > 0 ? correctCount / snapshot.length : 0;

    let nemotronFeedback = null;
    let nemotronQualityScore: number | undefined;
    if (params.freeTextExplanation) {
      const evaluation = await this.nemotron.evaluateExplanation({
        topicName: test.lecture.topic.name,
        studentExplanation: params.freeTextExplanation,
        mode: 'REVISION_TEST_GRADING',
      });
      nemotronFeedback = evaluation as any;
      nemotronQualityScore = evaluation.qualityScore;
    }

    const finalScore = nemotronQualityScore != null
      ? 0.6 * objectiveScore + 0.4 * nemotronQualityScore
      : objectiveScore;

    await this.prisma.revisionTest.update({
      where: { id: test.id },
      data: {
        responses: params.responses as any,
        score: finalScore,
        nemotronFeedback,
        completedAt: new Date(),
      },
    });

    const masteryUpdate = await this.weakTopicService.applySignal(
      this.weakTopicService.buildSignalFromRevisionTest({
        studentId: test.studentId,
        topicId: test.lecture.topicId,
        score: objectiveScore,
        nemotronQualityScore,
      }),
    );

    if (finalScore >= 0.65) {
      await this.creditService.award({
        studentId: test.studentId,
        amount: CREDIT_AMOUNTS.REVISION_TEST_PASSED,
        reason: 'REVISION_TEST_PASSED',
        refId: test.id,
      });
    }

    return { finalScore, objectiveScore, nemotronFeedback, masteryUpdate };
  }

  private pickRandom<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length > 0) {
      const idx = Math.floor(Math.random() * copy.length);
      out.push(copy.splice(idx, 1)[0]);
    }
    return out;
  }
}
