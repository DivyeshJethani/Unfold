export interface VideoEngagementSummary {
  lectureId: string;
  studentId: string;
  totalDurationSec: number;
  watchedSec: number;
  rewindCount: number;
  rewindRegions: Array<{ fromSec: number; toSec: number; count: number }>;
  pauseCount: number;
  longPauseCount: number; // pauses > 15s, treated as "stuck" signal
  skipCount: number;
  skippedRegions: Array<{ fromSec: number; toSec: number }>;
  completed: boolean;
  droppedOffAtSec: number | null;
}

export interface WeaknessSignal {
  source: 'EXAM' | 'QUIZ' | 'VIDEO' | 'REVISION_TEST' | 'PEER_TEACHING';
  topicId: string;
  studentId: string;
  strengthDelta: number; // -1..+1, negative = evidence of weakness
  confidence: number; // 0..1, how much to trust this single signal
  occurredAt: Date;
  meta?: Record<string, unknown>;
}

export interface TopicMasteryUpdateResult {
  studentId: string;
  topicId: string;
  previousScore: number;
  newScore: number;
  previousLevel: string;
  newLevel: string;
  needsReview: boolean;
  triggeredAiTeachback: boolean;
  triggeredPeerEscalation: boolean;
}

export interface NemotronEvaluationRequest {
  topicName: string;
  referenceExplanation?: string; // curated correct explanation, if available
  studentExplanation: string;
  mode: 'TEACHBACK_EVALUATION' | 'REVISION_TEST_GRADING' | 'FOLLOWUP_GENERATION';
}

export interface NemotronEvaluationResult {
  qualityScore: number; // 0..1, how well the student explained/answered
  conceptsCovered: string[];
  conceptsMissed: string[];
  misconceptions: string[];
  feedbackForStudent: string;
  followUpQuestions?: string[];
  raw?: unknown;
}

export interface AttentionEstimate {
  studentId: string;
  estimatedAttentionSpanSec: number;
  memoryRetentionScore: number;
  bestFocusWindowStart: number | null;
  bestFocusWindowEnd: number | null;
}
