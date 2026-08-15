import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NemotronEvaluationRequest,
  NemotronEvaluationResult,
} from '../interfaces/scoring.interface';

/**
 * Thin, well-typed wrapper around NVIDIA's Nemotron API (OpenAI-compatible
 * chat completions endpoint via NVIDIA NIM / build.nvidia.com).
 *
 * Responsibilities kept deliberately narrow:
 *  - build the right system prompt per use case (teach-back grading,
 *    revision-test grading, follow-up question generation)
 *  - force structured JSON output so callers never have to regex-parse prose
 *  - fail loudly with a typed error rather than silently returning nulls,
 *    so the BullMQ processor can retry/backoff correctly
 */
@Injectable()
export class NemotronService {
  private readonly logger = new Logger(NemotronService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('NEMOTRON_API_KEY', '');
    this.baseUrl = this.config.get<string>(
      'NEMOTRON_BASE_URL',
      'https://integrate.api.nvidia.com/v1',
    );
    this.model = this.config.get<string>(
      'NEMOTRON_MODEL',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    );
  }

  async evaluateExplanation(
    req: NemotronEvaluationRequest,
  ): Promise<NemotronEvaluationResult> {
    const systemPrompt = this.buildSystemPrompt(req.mode);
    const userPrompt = this.buildUserPrompt(req);

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2, // grading should be consistent, not creative
      top_p: 0.9,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.logger.error(`Nemotron request failed to send: ${err}`);
      throw new InternalServerErrorException('AI evaluation service unreachable');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(`Nemotron API error ${response.status}: ${text}`);
      throw new InternalServerErrorException('AI evaluation service returned an error');
    }

    const data = await response.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new InternalServerErrorException('AI evaluation service returned empty content');
    }

    return this.parseResult(content, data);
  }

  private buildSystemPrompt(mode: NemotronEvaluationRequest['mode']): string {
    const common = `You are an expert school-subject examiner and tutor evaluating a
student's spoken/written explanation of a topic. You must respond ONLY with a
single JSON object, no markdown fences, no prose outside the JSON, matching
exactly this shape:
{
  "qualityScore": <float 0..1>,
  "conceptsCovered": [<string>],
  "conceptsMissed": [<string>],
  "misconceptions": [<string>],
  "feedbackForStudent": <string, 2-4 sentences, encouraging but specific, written for a school student>,
  "followUpQuestions": [<string>]
}`;

    switch (mode) {
      case 'TEACHBACK_EVALUATION':
        return `${common}
The student is "teaching back" a topic to you as a check for understanding
(the Feynman technique). Judge whether their explanation demonstrates real
understanding, not just correct keywords. Be strict about misconceptions —
a confidently-stated wrong idea is worse than an admitted gap.`;
      case 'REVISION_TEST_GRADING':
        return `${common}
You are grading free-text answers on a short post-lecture revision test.
Focus qualityScore on correctness and completeness relative to the topic.`;
      case 'FOLLOWUP_GENERATION':
        return `${common}
Focus mainly on producing 3-5 good followUpQuestions that probe the gaps in
conceptsMissed/misconceptions. Other fields should still be filled honestly.`;
      default:
        return common;
    }
  }

  private buildUserPrompt(req: NemotronEvaluationRequest): string {
    const parts = [`Topic: ${req.topicName}`];
    if (req.referenceExplanation) {
      parts.push(`Reference (curriculum-correct) explanation:\n${req.referenceExplanation}`);
    }
    parts.push(`Student's explanation:\n${req.studentExplanation}`);
    return parts.join('\n\n');
  }

  private parseResult(content: string, raw: unknown): NemotronEvaluationResult {
    try {
      const parsed = JSON.parse(content);
      return {
        qualityScore: this.clamp01(Number(parsed.qualityScore) || 0),
        conceptsCovered: Array.isArray(parsed.conceptsCovered) ? parsed.conceptsCovered : [],
        conceptsMissed: Array.isArray(parsed.conceptsMissed) ? parsed.conceptsMissed : [],
        misconceptions: Array.isArray(parsed.misconceptions) ? parsed.misconceptions : [],
        feedbackForStudent:
          typeof parsed.feedbackForStudent === 'string'
            ? parsed.feedbackForStudent
            : 'Good effort — keep reviewing this topic.',
        followUpQuestions: Array.isArray(parsed.followUpQuestions)
          ? parsed.followUpQuestions
          : [],
        raw,
      };
    } catch (err) {
      this.logger.error(`Failed to parse Nemotron JSON response: ${err}. Raw: ${content}`);
      // Fail safe rather than crash the pipeline — treat as inconclusive,
      // let the caller decide (typically: don't penalize the student for
      // an infra hiccup, retry the job instead).
      throw new InternalServerErrorException('Could not parse AI evaluation result');
    }
  }

  private clamp01(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }
}
