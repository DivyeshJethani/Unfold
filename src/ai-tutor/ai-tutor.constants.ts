export const AI_TUTOR_QUEUE = 'ai-tutor-processing';

export const JOB_NAMES = {
  EVALUATE_REVISION_TEST: 'evaluate-revision-test',
  EVALUATE_PEER_TEACHING: 'evaluate-peer-teaching',
  RECOMPUTE_TOPIC_MASTERY: 'recompute-topic-mastery',
  GENERATE_TIMETABLE: 'generate-timetable',
  GENERATE_FOLLOWUP_QUESTIONS: 'generate-followup-questions',
} as const;

/**
 * Mastery scoring thresholds. Kept centralized so tuning doesn't require
 * chasing magic numbers across services.
 */
export const MASTERY_THRESHOLDS = {
  WEAK: 0.4,
  DEVELOPING: 0.65,
  PROFICIENT: 0.85,
  // >= PROFICIENT threshold and below this stays PROFICIENT; STRONG is the ceiling band
};

/**
 * EWMA smoothing factor for topic mastery updates. Higher = more reactive
 * to the latest evidence, lower = more stable/slow-moving.
 */
export const MASTERY_EWMA_ALPHA = 0.35;

/**
 * How many consecutive revision-test failures on the same topic before we
 * escalate from "teach it back to the AI" to "get a peer from your study
 * group to re-teach you".
 */
export const AI_TEACHBACK_ESCALATION_THRESHOLD = 2;

/** Credit amounts per earning event — tune freely, keep in one place. */
export const CREDIT_AMOUNTS = {
  QUIZ_COMPLETED_PER_CORRECT: 2,
  REVISION_TEST_PASSED: 10,
  TAUGHT_AI_SUCCESSFULLY: 15,
  TAUGHT_PEER_SUCCESSFULLY: 25,
  PEER_IMPROVED_BONUS: 20,
  STREAK_BONUS_PER_DAY: 5,
};

/** Video-signal weighting for the weak-topic detector. */
export const VIDEO_SIGNAL_WEIGHTS = {
  rewindDensity: 0.35, // rewinds per minute in a section -> confusion signal
  pauseDensity: 0.15, // long pauses -> possible confusion or note-taking (weighted lower, ambiguous)
  skipDensity: -0.2, // skipping ahead -> either confidence or disengagement; handled contextually
  dropOffPenalty: 0.3, // did not finish the lecture
};

/** Rolling window (days) used to compute attention span & streaks. */
export const BEHAVIOR_WINDOW_DAYS = 21;
