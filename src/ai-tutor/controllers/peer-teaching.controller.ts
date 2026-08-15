import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PeerTeachingService } from '../services/peer-teaching.service';
import { SubmitAiTeachbackDto, ResolvePeerSessionDto } from '../dto/teachback.dto';
import { CurrentStudentId } from '../decorators/current-student.decorator';

@ApiTags('peer-teaching')
@Controller('peer-teaching')
export class PeerTeachingController {
  constructor(private readonly peerTeachingService: PeerTeachingService) {}

  @Post('ai-teachback')
  @ApiOperation({
    summary:
      'Student explains a weak topic to the AI (Feynman technique). Nemotron judges it; ' +
      'response tells the client whether to escalate to a real peer instead.',
  })
  async submitAiTeachback(
    @CurrentStudentId() studentId: string,
    @Body() dto: SubmitAiTeachbackDto,
  ) {
    return this.peerTeachingService.submitAiTeachback({
      tuteeId: studentId,
      topicId: dto.topicId,
      explanation: dto.explanation,
    });
  }

  @Get('peer-candidates')
  @ApiOperation({ summary: 'Find strong peers from the study group who can re-teach a topic' })
  async findCandidates(
    @CurrentStudentId() studentId: string,
    @Query('topicId', ParseUUIDPipe) topicId: string,
  ) {
    return this.peerTeachingService.findPeerTutorCandidates(studentId, topicId);
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Create a peer teaching session with a chosen tutor' })
  async createSession(
    @CurrentStudentId() studentId: string,
    @Body() body: { tutorId: string; topicId: string },
  ) {
    return this.peerTeachingService.createPeerSession({
      tutorId: body.tutorId,
      tuteeId: studentId,
      topicId: body.topicId,
    });
  }

  @Post('sessions/:sessionId/resolve')
  @ApiOperation({ summary: "Resolve a peer session using the tutee's post-session check score" })
  async resolveSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: ResolvePeerSessionDto,
  ) {
    return this.peerTeachingService.resolvePeerSession(sessionId, dto.tuteePostSessionScore);
  }
}
