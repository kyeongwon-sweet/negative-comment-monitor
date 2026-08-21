import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversionCollectedFromTikTokContext,
  inferProductFromEvidence,
  productCodesFromText,
  restoreRowsFromContexts,
} from '../src/august-product-restore.js';

test('광고명에서 JD/P 상품코드를 정확히 추출하고 1P 규격은 제외한다', () => {
  assert.deepEqual(productCodesFromText('[26.06]F_I_P애_전환_1P_홍정민'), ['P애']);
  assert.deepEqual(productCodesFromText('F_V_JD멜_인지_1P'), ['JD멜']);
  assert.equal(inferProductFromEvidence(['이름없음', '파인트 캠페인']).product, 'P');
});

test('8월 광고·소유 YouTube 알림을 원본 컨텍스트로 복원한다', () => {
  const alerts = [
    { source: 'youtube_ads', platform: 'youtube', comment_id: 'yc', post_url: 'https://youtu.be/video01', comment_text: '별로', alerted_at: '2026-08-01T00:00:00Z', review_decision: 'hidden' },
    { source: 'tiktok_ads', platform: 'tiktok', comment_id: 'tc', post_url: 'https://www.tiktok.com/@ad/video/t1', comment_text: '싫다', alerted_at: '2026-08-02T00:00:00Z' },
    { source: null, platform: 'youtube', comment_id: 'oc', post_url: 'https://youtube.com/watch?v=owner01', comment_text: '노맛', alerted_at: '2026-08-03T00:00:00Z' },
    { source: null, platform: 'youtube', comment_id: 'third', post_url: 'https://youtube.com/watch?v=thirdparty', comment_text: '제외', alerted_at: '2026-08-03T00:00:00Z' },
  ];
  const youtube = { byVideo: new Map([['video01', { adNames: ['F_V_P망_인지_제작자'], campaignNames: [], titles: [] }]]) };
  const tiktok = { comments: [{ comment_id: 'tc', ad_name: 'F_V_JD멜_인지', campaign_name: '빙과' }] };
  const owners = new Map([['owner01', { video_title: '라라스윗 파인트 신상' }]]);
  const result = restoreRowsFromContexts(alerts, youtube, tiktok, owners);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((row) => row['상품']), ['P망', 'JD멜', 'P']);
  assert.equal(result.rows[0]['처리상태'], '숨김완료');
  assert.equal(result.coverage.ownerYouTube.alerts, 1);
});

test('TikTok 전체 조회 결과에서 전환 캠페인만 분류 입력으로 분리한다', () => {
  const config = { tiktokCampaignNameFilter: '', tiktokAdsAlertAfter: '', tiktokAdsProductName: 'JD', tiktokAdsChannelCategory: '인지 광고', brandContext: '라라스윗', videoAssignees: {}, tiktokAdvertiserId: 'a' };
  const context = {
    campaigns: [
      { campaign_id: 'c1', campaign_name: '빙과 전환' },
      { campaign_id: 'c2', campaign_name: '빙과 인지' },
    ],
    ads: [
      { ad_id: 'a1', adgroup_id: 'g1', campaign_id: 'c1' },
      { ad_id: 'a2', adgroup_id: 'g2', campaign_id: 'c2' },
    ],
    comments: [
      { comment_id: 'x1', ad_id: 'a1', adgroup_id: 'g1', campaign_name: '빙과 전환', ad_name: 'F_I_P애_전환', content: '별로', create_time: '2026-08-01T00:00:00Z' },
      { comment_id: 'x2', ad_id: 'a2', adgroup_id: 'g2', campaign_name: '빙과 인지', ad_name: 'F_I_JD멜_인지', content: '별로', create_time: '2026-08-01T00:00:00Z' },
    ],
  };
  const result = conversionCollectedFromTikTokContext(config, context);
  assert.equal(result.campaigns, 1);
  assert.equal(result.ads, 1);
  assert.equal(result.comments, 1);
  assert.equal(result.entries[0].comments[0].id, 'x1');
});
