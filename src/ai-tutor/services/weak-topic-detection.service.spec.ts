import { Test } from '@nestjs/testing';
import { WeakTopicDetectionService } from './weak-topic-detection.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('WeakTopicDetectionService', () => {
  let service: WeakTopicDetectionService;
  let prisma: {
    topicMastery: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      topicMastery: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockImplementation(({ create, update }) => ({ ...create, ...update })),
        findMany: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WeakTopicDetectionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(WeakTopicDetectionService);
  });

  it('starts a new topic at the neutral default (0.5) when no prior record exists', async () => {
    prisma.topicMastery.findUnique.mockResolvedValue(null);

    const result = await service.applySignal({
      source: 'QUIZ',
      studentId: 's1',
      topicId: 't1',
      strengthDelta: 0, // neutral signal
      confidence: 0.5,
      occurredAt: new Date(),
    });

    expect(result.previousScore).toBe(0.5);
  });

  it('pulls mastery score down after a strongly negative signal (failed exam)', async () => {
    prisma.topicMastery.findUnique.mockResolvedValue({
      masteryScore: 0.5,
      masteryLevel: 'DEVELOPING',
      confidence: 0.3,
      consecutiveFailures: 0,
    });

    const examSignal = service.buildSignalFromExamMark({
      studentId: 's1',
      topicId: 't1',
      marksObtained: 20,
      maxMarks: 100, // a genuinely bad score
    });

    const result = await service.applySignal(examSignal);

    expect(result.newScore).toBeLessThan(result.previousScore);
    expect(result.newLevel === 'WEAK' || result.newLevel === 'DEVELOPING').toBe(true);
  });

  it('pushes mastery score up after a strong quiz result', async () => {
    prisma.topicMastery.findUnique.mockResolvedValue({
      masteryScore: 0.5,
      masteryLevel: 'DEVELOPING',
      confidence: 0.3,
      consecutiveFailures: 0,
    });

    const quizSignal = service.buildSignalFromQuizAttempt({
      studentId: 's1',
      topicId: 't1',
      score: 0.95,
    });

    const result = await service.applySignal(quizSignal);

    expect(result.newScore).toBeGreaterThan(result.previousScore);
  });

  it('marks needsReview and flags AI-teachback after the first revision-test failure', async () => {
    prisma.topicMastery.findUnique.mockResolvedValue({
      masteryScore: 0.5,
      masteryLevel: 'DEVELOPING',
      confidence: 0.3,
      consecutiveFailures: 0,
    });

    const failSignal = service.buildSignalFromRevisionTest({
      studentId: 's1',
      topicId: 't1',
      score: 0.2,
    });

    const result = await service.applySignal(failSignal);

    expect(result.needsReview).toBe(true);
    expect(result.triggeredAiTeachback).toBe(true);
    expect(result.triggeredPeerEscalation).toBe(false);
  });

  it('escalates to peer teaching after repeated consecutive failures on the same topic', async () => {
    // Simulate the 2nd consecutive failure already recorded.
    prisma.topicMastery.findUnique.mockResolvedValue({
      masteryScore: 0.3,
      masteryLevel: 'WEAK',
      confidence: 0.4,
      consecutiveFailures: 1, // already failed once before this signal
    });

    const secondFailSignal = service.buildSignalFromRevisionTest({
      studentId: 's1',
      topicId: 't1',
      score: 0.15,
    });

    const result = await service.applySignal(secondFailSignal);

    expect(result.needsReview).toBe(true);
    expect(result.triggeredPeerEscalation).toBe(true);
  });

  it('keeps scores within [0, 1] bounds regardless of extreme repeated signals', async () => {
    prisma.topicMastery.findUnique.mockResolvedValue({
      masteryScore: 0.98,
      masteryLevel: 'STRONG',
      confidence: 0.9,
      consecutiveFailures: 0,
    });

    const result = await service.applySignal({
      source: 'QUIZ',
      studentId: 's1',
      topicId: 't1',
      strengthDelta: 1,
      confidence: 1,
      occurredAt: new Date(),
    });

    expect(result.newScore).toBeLessThanOrEqual(1);
    expect(result.newScore).toBeGreaterThanOrEqual(0);
  });
});
