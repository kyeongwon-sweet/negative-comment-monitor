import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVideoCreativeMap,
  replaceOwnerAssigneeBlock,
  updateCreativeAssigneeBlocks,
} from '../src/youtube-ads-retag.js';

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

test('소유 YouTube 카드는 담당자 섹션만 제작자로 교체하고 처리 상태·링크는 보존한다', () => {
  const original = [
    { type: 'section', text: { type: 'mrkdwn', text: '<https://youtube.test/watch?v=1|원본 영상명> / 작성자 / 댓글' } },
    { type: 'section', text: { type: 'mrkdwn', text: '*현재상태*\n숨김 처리됨' } },
    { type: 'section', text: { type: 'mrkdwn', text: '*담당자*\n<@U_BASE>' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '처리: <@U_ACTOR>' }] },
  ];
  const result = replaceOwnerAssigneeBlock(original, ['U_CREATOR']);
  assert.equal(result.changed, true);
  assert.equal(result.blocks[0].text.text, original[0].text.text);
  assert.equal(result.blocks[1].text.text, original[1].text.text);
  assert.equal(result.blocks[2].text.text, '*담당자*\n<@U_CREATOR>');
  assert.deepEqual(result.blocks[3], original[3]);
  assert.equal(original[2].text.text, '*담당자*\n<@U_BASE>');
});

test('광고 자산의 광고명에서 영상별 제작자를 중복 없이 만든다', () => {
  const map = buildVideoCreativeMap([
    { videoId: 'v1', adName: 'F_V_JD멜_빙과_정요한' },
    { videoId: 'v1', adNames: ['F_V_JD멜_빙과_정요한', 'F_V_JD멜_빙과_김유진'] },
    { videoId: 'v2', adName: '제작자없음' },
  ], { 정요한: 'U_YOHAN', 김유진: 'U_YUJIN' });
  assert.deepEqual(map.get('v1').assignees, ['U_YOHAN', 'U_YUJIN']);
  assert.deepEqual(map.get('v2').assignees, []);
});
