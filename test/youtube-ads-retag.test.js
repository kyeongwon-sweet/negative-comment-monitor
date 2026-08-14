import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCreativeAssigneeBlocks } from '../src/youtube-ads-retag.js';

test('유튜브 미처리 카드의 링크명을 소재명으로 바꾸고 제작자를 기존 담당자 뒤에 추가한다', () => {
  const original = [
    { type: 'section', text: { type: 'mrkdwn', text: '<https://youtube.test/watch?v=1|캠페인 · 영상제목> / 작성자 / 댓글' } },
    { type: 'section', text: { type: 'mrkdwn', text: '*담당자*\n<@U111AAA>' } },
    { type: 'actions', elements: [] },
  ];
  const result = updateCreativeAssigneeBlocks(original, '[26.08]_인지_정요한', ['U222BBB']);
  assert.equal(result.changed, true);
  assert.match(result.blocks[0].text.text, /\|\[26\.08\]_인지_정요한>/);
  assert.equal(result.blocks[1].text.text, '*담당자*\n<@U111AAA> <@U222BBB>');
  assert.equal(original[1].text.text, '*담당자*\n<@U111AAA>');
});

test('제작자 매핑이 없으면 카드를 변경하지 않는다', () => {
  const blocks = [{ type: 'actions', elements: [] }];
  assert.deepEqual(updateCreativeAssigneeBlocks(blocks, '소재', []), { blocks, changed: false });
});
