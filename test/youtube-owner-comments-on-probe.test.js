import test from 'node:test';
import assert from 'node:assert/strict';
import { commentsEnabled, probeChannelCommentsOn } from '../src/youtube-owner-comments-on-probe.js';

test('댓글 켜짐 판정: statistics에 commentCount가 있어야 켜짐(0이어도 켜짐), 속성 없으면 꺼짐', () => {
  assert.equal(commentsEnabled({ statistics: { viewCount: '1', commentCount: '0' } }), true);
  assert.equal(commentsEnabled({ statistics: { viewCount: '1' } }), false);
  assert.equal(commentsEnabled({}), true, 'statistics 없음 = 판정 불가 → 작업 목록에 남긴다');
});

test('채널 전체 업로드를 페이지 넘겨 읽고 댓글 켜진 영상만 모은다(읽기 전용)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push([u.pathname.split('/').pop(), init.method || 'GET']);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname.endsWith('/channels')) return json({ items: [{ snippet: { title: '먹짱언니' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (u.pathname.endsWith('/playlistItems')) {
      return u.searchParams.get('pageToken')
        ? json({ items: [{ contentDetails: { videoId: 'v3' } }] })
        : json({ items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }], nextPageToken: 'p2' });
    }
    if (u.pathname.endsWith('/videos')) {
      return json({ items: [
        { id: 'v1', statistics: { commentCount: '3' } },
        { id: 'v2', statistics: { viewCount: '9' } },
        { id: 'v3', statistics: { commentCount: '0' } },
      ] });
    }
    throw new Error(`unexpected ${u}`);
  };
  const result = await probeChannelCommentsOn({ youtubeApiBase: 'https://yt.test/youtube/v3', maxPages: 10 }, 'UCx', 'at', fetchImpl);
  assert.equal(result.videos, 3);
  assert.deepEqual(result.commentsOn, ['v1', 'v3']);
  assert.ok(calls.every(([, method]) => method === 'GET'), '읽기 전용');
});
