import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NemotronService } from './nemotron.service';
import { WeakTopicDetectionService } from './weak-topic-detection.service';
import { CreditService } from './credit.service';
import { CREDIT_AMOUNTS, AI_TEACHBACK_ESCALATION_THRESHOLD } from '../ai-tutor.constants';

const AI_TUTOR_SENTINEL = 'AI';
const NEMOTRON_PASS_THRESHOLD = 0.7;

/**
 * Implements the flow described in the product spec:
 *   weak topic detected -> student revises -> student TEACHES the topic
 *   back (first to the AI) -> Nemotron judges the explanation -> if it's
 *   genuinely good, mastery improves and credits are awarded; if it's not,
 *   and this is the student's 2nd+ consecutive miss on the same topic, we
 *   escalate to a real peer from their study group instead of the AI.
 */
@Injectable()
export class PeerTeachingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nemotron: NemotronService,
    private readonly weakTopicService: WeakTopicDetectionService,
    private readonly creditService: CreditService,
  ) {}

  /** Step 1: student explains the topic to the AI. */
  async submitAiTeachback(params: {
    tuteeId: string;
    topicId: string;
    explanation: string;
  }) {
    const topic = await this.prisma.topic.findUnique({ where: { id: params.topicId } });
    if (!topic) throw new NotFoundException('Topic not found');

    const evaluation = await this.nemotron.evaluateExplanation({
      topicName: topic.name,
      studentExplanation: params.explanation,
      mode: 'TEACHBACK_EVALUATION',
    });

    const passed = evaluation.qualityScore >= NEMOTRON_PASS_THRESHOLD;

    const session = await this.prisma.peerTeachingSession.create({
      data: {
        topicId: params.topicId,
        tutorId: null,
        isAiTutor: true,
        tuteeId: params.tuteeId,
        transcript: { explanation: params.explanation } as any,
        nemotronEvaluation: evaluation as any,
        outcome: passed ? 'IMPROVED' : 'NOT_IMPROVED',
        resolvedAt: new Date(),
      },
    });

    const masteryUpdate = await this.weakTopicService.applySignal(
      this.weakTopicService.buildSignalFromPeerTeaching({
        tuteeId: params.tuteeId,
        topicId: params.topicId,
        postSessionQuizScore: evaluation.qualityScore,
      }),
    );

    if (passed) {
      await this.creditService.award({
        studentId: params.tuteeId,
        amount: CREDIT_AMOUNTS.TAUGHT_AI_SUCCESSFULLY,
        reason: 'TAUGHT_AI_SUCCESSFULLY',
        refId: session.id,
      });
    }

    // Decide next step for the frontend: if this student has now failed
    // AI-teachback AI_TEACHBACK_ESCALATION_THRESHOLD times in a row on this
    // topic, hand back a flag telling the client to route them into peer
    // matching instead of retrying with the AI again.
    const shouldEscalateToPeer =
      !passed && masteryUpdate.triggeredPeerEscalation;

    if (shouldEscalateToPeer) {
      await this.prisma.peerTeachingSession.update({
        where: { id: session.id },
        data: { outcome: 'ESCALATED_TO_PEER' },
      });
    }

    return {
      session,
      evaluation,
      masteryUpdate,
      shouldEscalateToPeer,
    };
  }

  /**
   * Step 2 (escalation path): match the tutee with a strong peer from one
   * of their study groups. "Strong" = PROFICIENT/STRONG mastery on this
   * exact topic, same study group, and not currently over-tapped as a
   * tutor (simple load cap to avoid always picking the top student).
   */
  async findPeerTutorCandidates(tuteeId: string, topicId: string, limit = 3) {
    const tutee = await this.prisma.student.findUnique({
      where: { id: tuteeId },
      include: { studyGroupMemberships: true },
    });
    if (!tutee) throw new NotFoundException('Student not found');

    const groupIds = tutee.studyGroupMemberships.map((m) => m.studyGroupId);
    if (groupIds.length === 0) {
      throw new BadRequestException(
        'Student is not in any study group yet — join a subject study group first',
      );
    }

    const groupMembers = await this.prisma.studyGroupMember.findMany({
      where: { studyGroupId: { in: groupIds }, studentId: { not: tuteeId } },
      select: { studentId: true },
    });
    const candidateIds = [...new Set(groupMembers.map((m) => m.studentId))];

    const strongMasteries = await this.prisma.topicMastery.findMany({
      where: {
        topicId,
        studentId: { in: candidateIds },
        masteryLevel: { in: ['PROFICIENT', 'STRONG'] },
      },
      orderBy: { masteryScore: 'desc' },
    });

    // Load-balance: count each candidate's open/recent tutor sessions so we
    // don't always route to the single strongest student in the group.
    const recentLoad = await this.prisma.peerTeachingSession.groupBy({
      by: ['tutorId'],
      where: {
        tutorId: { in: strongMasteries.map((m) => m.studentId) },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      _count: { tutorId: true },
    });
    const loadMap = new Map(recentLoad.map((r) => [r.tutorId, r._count.tutorId]));

    return strongMasteries
      .map((m) => ({
        studentId: m.studentId,
        masteryScore: m.masteryScore,
        recentSessionLoad: loadMap.get(m.studentId) ?? 0,
      }))
      .sort((a, b) => a.recentSessionLoad - b.recentSessionLoad || b.masteryScore - a.masteryScore)
      .slice(0, limit);
  }

  async createPeerSession(params: { tutorId: string; tuteeId: string; topicId: string }) {
    return this.prisma.peerTeachingSession.create({
      data: {
        topicId: params.topicId,
        tutorId: params.tutorId,
        isAiTutor: false,
        tuteeId: params.tuteeId,
        outcome: 'PENDING',
      },
    });
  }

  /**
   * Called once the tutee takes a short post-session check (a mini
   * RevisionTest). Judges the *outcome*, not just whether the session
   * happened — this is what the credit system pays the tutor for.
   */
  async resolvePeerSession(sessionId: string, tuteePostSessionScore: number) {
    const session = await this.prisma.peerTeachingSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('Peer teaching session not found');
    if (session.isAiTutor || !session.tutorId) {
      throw new BadRequestException('This session was not a peer session');
    }

    const improved = tuteePostSessionScore >= NEMOTRON_PASS_THRESHOLD;

    await this.prisma.peerTeachingSession.update({
      where: { id: sessionId },
      data: { outcome: improved ? 'IMPROVED' : 'NOT_IMPROVED', resolvedAt: new Date() },
    });

    const masteryUpdate = await this.weakTopicService.applySignal(
      this.weakTopicService.buildSignalFromPeerTeaching({
        tuteeId: session.tuteeId,
        topicId: session.topicId,
        postSessionQuizScore: tuteePostSessionScore,
      }),
    );

    if (improved) {
      // Tutor is rewarded for the act of teaching AND a bonus once the
      // tutee's improvement is actually confirmed — this is the mechanism
      // that stops students from gaming credits via low-effort "teaching".
      await this.creditService.award({
        studentId: session.tutorId,
        amount: CREDIT_AMOUNTS.TAUGHT_PEER_SUCCESSFULLY,
        reason: 'TAUGHT_PEER_SUCCESSFULLY',
        refId: session.id,
      });
      await this.creditService.award({
        studentId: session.tutorId,
        amount: CREDIT_AMOUNTS.PEER_IMPROVED_BONUS,
        reason: 'PEER_IMPROVED_AFTER_TEACHING',
        refId: session.id,
      });
    }

    return { improved, masteryUpdate };
  }
}
