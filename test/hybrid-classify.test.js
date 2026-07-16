import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsHybrid } from '../src/hybrid-classify.js';

test('calls the LLM only for ambiguous comments and keeps immediate rules local', async () => {
  const comments = [
    { text: 'ㅅㅂ 진짜 노맛' },
    { text: '이거 광고인가요?' },
    { text: '라라스윗 맛있어요' },
  ];
  let received;
  const llmClassifier = async (items) => {
    received = items;
    return [{ alert: false, category: '정상댓글', reason: '', priority: 'normal' }];
  };
  const results = await classifyCommentsHybrid(comments, { brandName: '라라스윗' }, { anthropicKey: 'key' }, llmClassifier);
  assert.deepEqual(received.map((item) => item.text), ['이거 광고인가요?']);
  assert.equal(results[0].engine, 'keyword');
  assert.equal(results[0].alert, true);
  assert.equal(results[1].engine, 'llm');
  assert.equal(results[2].engine, 'keyword');
});

test('uses only free keyword rules when no Anthropic key is configured', async () => {
  let called = false;
  const results = await classifyCommentsHybrid(
    [{ text: '라라스윗 광고인가요?' }],
    { brandName: '라라스윗' },
    { anthropicKey: '' },
    async () => { called = true; return []; },
  );
  assert.equal(called, false);
  assert.equal(results[0].engine, 'keyword');
});
