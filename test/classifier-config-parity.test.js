// 분류기(hybrid-classify·llm·cache…)가 읽는 설정값은 실행 경로마다 다른 로더로 만들어진다.
// 로더가 키를 하나 빠뜨리면 워크플로 env가 있어도 그 경로에서만 조용히 꺼진다
// (09-23 광고 로더 담당자 누락, 09-21~10-28 소유채널 강한 모델 승격 미작동 5q7z3FExo_Q).
// 분류기 소스에서 읽는 config 키를 정적으로 뽑아, 모든 분류 경로 로더가 일반 모니터
// (loadConfig)와 같은 값을 내는지 강제한다. 새 키를 loadConfig에만 넣으면 여기서 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { loadMetaAdsConfig } from '../src/meta-ads.js';
import { loadTikTokAdsConfig } from '../src/tiktok-ads.js';
import { loadYouTubeAdsConfig } from '../src/youtube-ads.js';
import { loadYouTubeOwnerChannelConfig } from '../src/youtube-owner-channel.js';
import { loadOwnerCoverageAuditConfig } from '../src/youtube-owner-coverage-audit.js';

const SRC = new URL('../src/', import.meta.url);
const CLASSIFIER_MODULES = [
  'hybrid-classify.js', 'llm.js', 'cache.js', 'gemini-budget.js', 'classify.js', 'classifier-hash.js',
];
// 실행 경로별로 일부러 다른 값(호출 정책)이라 동등 비교에서 뺀다. 늘릴 때는 사유를 적는다.
const PATH_SPECIFIC = new Set([
  'classificationCacheReadOnly', // 감사·진단 실행만 true(운영 캐시 비변경)
]);

function classifierConfigKeys() {
  const keys = new Set();
  for (const file of CLASSIFIER_MODULES) {
    const source = readFileSync(new URL(file, SRC), 'utf8');
    for (const match of source.matchAll(/\bconfig\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]);
  }
  for (const key of PATH_SPECIFIC) keys.delete(key);
  return [...keys].sort();
}

// src 전체에서 참조하는 env 이름을 모아 같은 값을 넣는다. 기본값과 다른 값이어야
// '로더가 env를 안 읽고 기본값을 씀'과 '읽음'이 구별된다.
function syntheticEnv() {
  const env = {};
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, SRC), 'utf8');
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) env[match[1]] = '7';
    for (const match of source.matchAll(/(?:required|json)\(env,\s*'([A-Z][A-Z0-9_]+)'/g)) env[match[1]] = '7';
  }
  // JSON 설정(채널 목록·액터 입력)은 형식이 있어 '7'을 못 받는다. 분류 설정과 무관하니 빈 값으로 둔다.
  for (const name of Object.keys(env)) if (name.endsWith('_JSON')) env[name] = name.includes('INPUT') ? '{}' : '[]';
  return env;
}

const LOADERS = {
  loadMetaAdsConfig,
  loadTikTokAdsConfig,
  loadYouTubeAdsConfig,
  loadYouTubeOwnerChannelConfig,
  loadOwnerCoverageAuditConfig,
};

test('분류 경로 로더는 분류기가 읽는 설정값을 일반 모니터(loadConfig)와 똑같이 만든다', () => {
  const env = syntheticEnv();
  const now = Date.parse('2026-10-28T00:00:00Z');
  const base = loadConfig(env, now);
  const loaded = Object.fromEntries(Object.entries(LOADERS).map(([name, load]) => [name, load(env, now)]));
  // 어느 로더에든 정의된 키는 전부 비교한다(한쪽 로더에만 새 키를 넣은 경우도 잡는다).
  const keys = classifierConfigKeys().filter((key) => base[key] !== undefined
    || Object.values(loaded).some((config) => config[key] !== undefined));
  assert.ok(keys.includes('ownedBrandEscalationModel'), '정적 추출이 승격 모델 키를 찾아야 함');
  assert.ok(keys.includes('geminiModel'));
  const gaps = [];
  for (const [name, config] of Object.entries(loaded)) {
    for (const key of keys) {
      if (JSON.stringify(config[key]) !== JSON.stringify(base[key])) {
        gaps.push(`${name}.${key}: ${JSON.stringify(config[key])} ≠ loadConfig ${JSON.stringify(base[key])}`);
      }
    }
  }
  assert.deepEqual(gaps, [], `분류 설정 누락/불일치:\n${gaps.join('\n')}`);
});
