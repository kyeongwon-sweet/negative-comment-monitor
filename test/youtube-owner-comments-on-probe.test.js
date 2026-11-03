import test from 'node:test';
import assert from 'node:assert/strict';
import { probeChannelCommentsOn } from '../src/youtube-owner-comments-on-probe.js';

function world({ disabled = [], unknown = [] } = {}) {
  const calls = [];
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push([u.pathname.split('/').pop(), init.method || 'GET']);
    if (u.pathname.endsWith('/channels')) return json({ items: [{ snippet: { title: '먹짱언니' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (u.pathname.endsWith('/playlistItems')) {
      return u.searchParams.get('pageToken')
        ? json({ items: [{ contentDetails: { videoId: 'v3' } }] })
        : json({ items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }], nextPageToken: 'p2' });
    }
    if (u.pathname.endsWith('/commentThreads')) {
      const id = u.searchParams.get('videoId');
      if (disabled.includes(id)) return json({ error: { errors: [{ reason: 'commentsDisabled' }] } }, false, 403);
      if (unknown.includes(id)) return json({ error: { errors: [{ reason: 'backendError' }] } }, false, 500);
      return json({ items: [] });
    }
    // 소유자 토큰의 videos.list statistics는 꺼진 영상에도 commentCount를 준다 → 판정에 쓰면 안 된다.
    if (u.pathname.endsWith('/videos')) throw new Error('videos.list statistics로 댓글 켜짐을 판정하면 안 됨');
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls };
}

const CONFIG = { youtubeApiBase: 'https://yt.test/youtube/v3', maxPages: 10 };

test('채널 전체 업로드를 페이지 넘겨 읽고, commentThreads 403 commentsDisabled면 꺼짐으로 뺀다(읽기 전용)', async () => {
  const { fetchImpl, calls } = world({ disabled: ['v2'] });
  const result = await probeChannelCommentsOn(CONFIG, 'UCx', 'at', fetchImpl);
  assert.equal(result.videos, 3);
  assert.deepEqual(result.commentsOn, ['v1', 'v3']);
  assert.equal(result.commentsOff, 1);
  assert.ok(calls.every(([, method]) => method === 'GET'), '읽기 전용');
});

test('판정 불가(오류)는 켜짐 쪽으로 남기고 개수를 따로 센다(작업 목록 누락 방지)', async () => {
  const { fetchImpl } = world({ unknown: ['v3'] });
  const result = await probeChannelCommentsOn(CONFIG, 'UCx', 'at', fetchImpl);
  assert.deepEqual(result.commentsOn, ['v1', 'v2', 'v3']);
  assert.equal(result.unknown, 1);
});

test('검증용 영상 지정 시 업로드 목록을 읽지 않고 그 영상만 판정한다', async () => {
  const { fetchImpl, calls } = world({ disabled: ['x2'] });
  const result = await probeChannelCommentsOn({ ...CONFIG, videoIds: ['x1', 'x2'] }, 'UCx', 'at', fetchImpl);
  assert.deepEqual(result.commentsOn, ['x1']);
  assert.ok(!calls.some(([name]) => name === 'playlistItems'));
});
