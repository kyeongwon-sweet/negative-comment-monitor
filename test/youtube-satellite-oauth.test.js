import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeOwnerAuthorizationUrl,
  resolveSatelliteChannel,
  YOUTUBE_SATELLITE_CHANNELS,
} from '../src/youtube-satellite-oauth.js';

test('위성 YouTube 8채널의 이름·핸들·공개 channel ID가 고유하다', () => {
  assert.equal(YOUTUBE_SATELLITE_CHANNELS.length, 8);
  assert.equal(new Set(YOUTUBE_SATELLITE_CHANNELS.map((row) => row.channelId)).size, 8);
  assert.equal(resolveSatelliteChannel('썰박스')?.handle, '@ssulbox-1');
  assert.equal(resolveSatelliteChannel('@whydontuknow2424')?.name, '이걸몰라?');
});

test('OAuth URL은 offline consent·youtube.force-ssl·state를 고정한다', () => {
  const url = new URL(buildYouTubeOwnerAuthorizationUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:53682',
    state: 'safe-state',
  }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.force-ssl');
  assert.equal(url.searchParams.get('state'), 'safe-state');
});
