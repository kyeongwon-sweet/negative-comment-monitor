import test from 'node:test';
import assert from 'node:assert/strict';
import { isKbongText, kbongProductName } from '../src/kbong.js';
import { awarenessProductName } from '../src/ad-common.js';
import { inferOwnerVideoProduct } from '../src/youtube-owner-channel.js';
import { inferProductFromEvidence } from '../src/august-product-restore.js';
import { productFromAdCreative } from '../src/youtube-owner-public-audit.js';
import { loadSlackAssignees } from '../src/config.js';
import { assigneeForTarget } from '../src/slack.js';

// 11-25 사용자 지정: '크봉','BB바','BB말','BB초','봉봉','크런치봉봉'이 들어 있으면 무조건 크봉.
const WORDS = ['크봉', 'BB바', 'BB말', 'BB초', '봉봉', '크런치봉봉', 'bb초'];

test('크봉 단어 6종은 어디에 있어도 크봉', () => {
  for (const w of WORDS) assert.equal(isKbongText(`앞 ${w} 뒤`), true, w);
  assert.equal(isKbongText('JD멜 쫀득바', '파인트'), false);
  assert.equal(kbongProductName('JD멜', '', '오늘 봉봉 먹방'), 'BB');
  assert.equal(kbongProductName('JD멜', '소재명', '캡션'), 'JD멜');
});

test('광고·소유영상·재감사·복구 경로 모두 다른 상품 신호보다 크봉이 우선', () => {
  // JD복 지정·파인트·제과 단어가 같이 있어도 크봉.
  assert.equal(awarenessProductName('JD복', '[빙과] JD복 인지', '봉봉 소재'), 'BB');
  assert.equal(awarenessProductName('JD', '[파인트] 인지', 'BB말_main'), 'BB');
  assert.equal(awarenessProductName('JD', '[제과] 인지', '크봉 컷'), 'BB');
  // 영상별 지정(override) 영상이라도 제목에 크봉 단어가 있으면 크봉.
  assert.equal(inferOwnerVideoProduct({ id: 'b7F8GZEogAA', snippet: { title: '떵개 30억뷰 봉봉' } }), 'BB');
  assert.equal(inferOwnerVideoProduct({ snippet: { title: '쫀득바 vs 크런치봉봉' } }), 'BB');
  assert.equal(inferOwnerVideoProduct({ snippet: { title: '쫀득바', description: 'BB초 등장' } }), 'BB');
  assert.equal(inferProductFromEvidence(['JD멜_소재', '크봉 캠페인']).product, 'BB');
  assert.equal(productFromAdCreative({ adNames: ['JD멜_main'], campaignNames: ['봉봉 인지'] }), 'BB');
});

test('크봉 담당: 주담당 = SLACK_ASSIGNEE_BB_PRIMARY(이재원)', () => {
  const a = loadSlackAssignees({ SLACK_ASSIGNEE_BB_PRIMARY: 'U09RCJ1B9ML', SLACK_ASSIGNEE_JD_PRIMARY: 'U_JD' });
  for (const channelCategory of ['위성채널', '인지 광고', '협찬 (인플루언서)', '바이럴 (배너)', '온드미디어', '소유 YouTube']) {
    assert.equal(assigneeForTarget({ productName: kbongProductName('JD멜', '봉봉'), channelCategory }, a), 'U09RCJ1B9ML', channelCategory);
  }
});
