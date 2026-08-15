import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AttentionSpanService } from './attention-span.service';
import { WeakTopicDetectionService } from './weak-topic-detection.service';

export interface TimetableBlock {
  subjectId: string;
  subjectName: string;
  topicId: string;
  topicName: string;
  startMinute: number; // minutes from timetable start (e.g. from 16:00)
  durationMinutes: number;
  reason: 'WEAK_TOPIC_REVIEW' | 'SPACED_REVIEW' | 'NEW_LECTURE' | 'REVISION_TEST';
}

export interface DailyTimetable {
  studentId: string;
  date: string; // ISO date
  windowStartHour: number;
  windowEndHour: number;
  blocks: TimetableBlock[];
  breakMinutes: number;
}

/**
 * Builds a single day's study plan sized to the student's actual measured
 * attention span (not a generic 45-min slot), front-loads their weakest
 * topics into their best-focus window, and inserts breaks proportional to
 * how quickly their engagement has been observed to degrade.
 */
@Injectable()
export class TimetableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attentionService: AttentionSpanService,
    private readonly weakTopicService: WeakTopicDetectionService,
  ) {}

  async generateDailyTimetable(studentId: string, date: Date = new Date()): Promise<DailyTimetable> {
    const [profile, weakTopics] = await Promise.all([
      this.getOrComputeProfile(studentId),
      this.weakTopicService.listWeakTopicsForStudent(studentId),
    ]);

    // Study block length = attention span, capped to a sane range so a
    // very short/noisy estimate doesn't produce a useless 3-minute block.
    const blockMinutes = Math.min(45, Math.max(10, Math.round(profile.estimatedAttentionSpanSec / 60)));
    // Break length scales inversely with memory retention: a student who
    // forgets faster benefits from shorter, more frequent breaks with
    // active-recall re-entry rather than long blocks.
    const breakMinutes = Math.round(5 + (1 - profile.memoryRetentionScore) * 10);

    const windowStartHour = profile.bestFocusWindowStart ?? 16; // default 4pm
    const windowEndHour = profile.bestFocusWindowEnd != null
      ? profile.bestFocusWindowStart! < profile.bestFocusWindowEnd
        ? profile.bestFocusWindowStart! + 3
        : profile.bestFocusWindowEnd
      : 19;

    const totalMinutesAvailable = Math.max(30, (windowEndHour - windowStartHour) * 60);

    const blocks: TimetableBlock[] = [];
    let cursor = 0;

    // 1) Weakest topics first, while focus is freshest.
    const topWeak = weakTopics.slice(0, 4);
    for (const wt of topWeak) {
      if (cursor + blockMinutes > totalMinutesAvailable) break;
      blocks.push({
        subjectId: wt.topic.subjectId,
        subjectName: wt.topic.subject.name,
        topicId: wt.topicId,
        topicName: wt.topic.name,
        startMinute: cursor,
        durationMinutes: blockMinutes,
        reason: 'WEAK_TOPIC_REVIEW',
      });
      cursor += blockMinutes + breakMinutes;
    }

    // 2) Fill remaining time with spaced-review slots for topics that are
    // PROFICIENT/STRONG but due for a refresh (simple day-count heuristic;
    // a full spaced-repetition scheduler would live in its own service).
    if (cursor < totalMinutesAvailable) {
      const dueForReview = await this.prisma.topicMastery.findMany({
        where: {
          studentId,
          needsReview: false,
          lastEvaluatedAt: { lt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
        },
        include: { topic: { include: { subject: true } } },
        orderBy: { lastEvaluatedAt: 'asc' },
        take: 2,
      });

      for (const t of dueForReview) {
        if (cursor + blockMinutes > totalMinutesAvailable) break;
        blocks.push({
          subjectId: t.topic.subjectId,
          subjectName: t.topic.subject.name,
          topicId: t.topicId,
          topicName: t.topic.name,
          startMinute: cursor,
          durationMinutes: Math.round(blockMinutes * 0.6), // lighter touch
          reason: 'SPACED_REVIEW',
        });
        cursor += Math.round(blockMinutes * 0.6) + breakMinutes;
      }
    }

    return {
      studentId,
      date: date.toISOString().slice(0, 10),
      windowStartHour,
      windowEndHour,
      blocks,
      breakMinutes,
    };
  }

  private async getOrComputeProfile(studentId: string) {
    const existing = await this.prisma.attentionProfile.findUnique({ where: { studentId } });
    if (existing) return existing;
    return this.attentionService.recomputeForStudent(studentId);
  }
}
