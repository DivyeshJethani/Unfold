import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CreditService } from '../services/credit.service';
import { RedeemRewardDto } from '../dto/teachback.dto';
import { CurrentStudentId } from '../decorators/current-student.decorator';

@ApiTags('credits')
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditService: CreditService) {}

  @Get('wallet')
  @ApiOperation({ summary: "Get the current student's credit balance" })
  async wallet(@CurrentStudentId() studentId: string) {
    return this.creditService.getWallet(studentId);
  }

  @Get('history')
  @ApiOperation({ summary: "Get the current student's credit transaction history" })
  async history(@CurrentStudentId() studentId: string) {
    return this.creditService.getHistory(studentId);
  }

  @Post('redeem')
  @ApiOperation({ summary: 'Redeem credits for a reward (gift/merchandise/cash-equivalent voucher)' })
  async redeem(@CurrentStudentId() studentId: string, @Body() dto: RedeemRewardDto) {
    return this.creditService.redeem({ studentId, rewardItemId: dto.rewardItemId });
  }

  @Get('leaderboard/:studyGroupId')
  @ApiOperation({ summary: 'Leaderboard of top credit earners within a study group' })
  async leaderboard(@Param('studyGroupId') studyGroupId: string) {
    return this.creditService.getLeaderboard(studyGroupId);
  }
}
