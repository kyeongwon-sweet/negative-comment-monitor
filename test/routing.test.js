import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCollector,
  detectPlatform,
  filterEligibleSponsorships,
  groupApifyTargets,
  isEligibleSponsorship,
} from '../src/routing.js';

test('detects all supported platforms', () => {
  assert.equal(detectPlatform('https://www.instagram.com/p/abc/'), 'instagram');
  assert.equal(detectPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(detectPlatform('https://www.tiktok.com/@a/video/1'), 'tiktok');
});

test('uses Graph only for managed boosted Instagram media', () => {
  assert.equal(chooseCollector({ url: 'https://instagram.com/p/a', isBoosted: true, isManagedAccount: true, mediaId: '1' }), 'graph');
  assert.equal(chooseCollector({ url: 'https://instagram.com/p/b', isBoosted: true, isManagedAccount: false, mediaId: '2' }), 'apify');
  assert.equal(chooseCollector({ url: 'https://youtube.com/watch?v=x' }), 'apify');
});

test('excludes Graph targets from Apify batches', () => {
  const groups = groupApifyTargets([
    { url: 'https://instagram.com/p/a', isBoosted: true, isManagedAccount: true, mediaId: '1' },
    { url: 'https://instagram.com/p/b' },
    { url: 'https://youtu.be/c' },
  ]);
  assert.equal(groups.instagram.length, 1);
  assert.equal(groups.youtube.length, 1);
});

test('excludes every channel category containing 무상시딩', () => {
  assert.equal(isEligibleSponsorship({ url: 'https://instagram.com/p/a', channelCategory: '무상시딩 (피드)' }), false);
  assert.equal(isEligibleSponsorship({ url: 'https://youtu.be/a', channelCategory: '유상협찬' }), true);
  assert.deepEqual(filterEligibleSponsorships([
    { url: 'https://instagram.com/p/a', channelCategory: '무상시딩 (영상)' },
    { url: 'https://www.tiktok.com/@a/video/1', channelCategory: 'PPL' },
  ]).map((item) => item.url), ['https://www.tiktok.com/@a/video/1']);
});

test('fails closed when GAS omits channel category', () => {
  assert.throws(
    () => isEligibleSponsorship({ url: 'https://instagram.com/p/a' }),
    /missing channelCategory/,
  );
});
