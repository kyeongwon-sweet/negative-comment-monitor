import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import {
  collectAugustConversionCandidates,
  encryptConversionExport,
  formatTikTokKst,
  productFromConversionAdTitle,
} from '../src/tiktok-conversion-backfill.js';

test('전환 광고명에서 전환 바로 앞 상품 토큰을 추출한다', () => {
  assert.equal(productFromConversionAdTitle('[26.06]F_I_P애_전환_상시_홍정민', 'JD'), 'P애');
  assert.equal(productFromConversionAdTitle('형식없음', 'JD'), 'JD');
});

test('TikTok timestamp를 KST로 바꾸고 8월 부정댓글만 로우데이터로 만든다', () => {
  assert.equal(formatTikTokKst('2026-07-31T15:00:01Z'), '2026-08-01 00:00:01');
  const entries = [{
    target: { url: 'https://www.tiktok.com/@ad/video/v1', adTitle: 'F_V_JD멜_전환_x', channelName: 'TikTok 광고' },
    comments: [
      { id: 'c1', text: '별로', timestamp: '2026-08-03T00:00:00Z' },
      { id: 'c2', text: '7월', timestamp: '2026-07-01T00:00:00Z' },
    ],
  }];
  const risks = [[
    { alert: true, category: '제품 불만', reason: '맛 불만' },
    { alert: true, category: '제품 불만', reason: '기간 밖' },
  ]];
  const rows = collectAugustConversionCandidates(entries, risks, { tiktokAdsProductName: 'JD' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row['상품'], 'JD멜');
  assert.equal(rows[0].row['채널'], '전환 광고');
  assert.equal(rows[0].row['플랫폼'], '틱톡');
  assert.equal(rows[0].row['탐지일시_KST'], '2026-08-03 09:00:00');
});

test('내보내기는 공개키로 암호화되어 개인키 없이는 원문을 담지 않는다', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { rows: [{ '악플_내용': '민감한 댓글' }] };
  const envelope = encryptConversionExport(payload, Buffer.from(pubPem).toString('base64'));
  assert.equal(JSON.stringify(envelope).includes('민감한 댓글'), false);
  const key = privateDecrypt({
    key: privateKey,
    oaepHash: 'sha256',
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(envelope.encryptedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), payload);
});
