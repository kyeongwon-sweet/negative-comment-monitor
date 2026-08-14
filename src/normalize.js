function first(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

export function normalizeComment(platform, item, fallbackUrl) {
  const text = String(first(item, ['text', 'commentText', 'comment', 'content', 'message'])).trim();
  if (!text) return null;

  const normalized = {
    id: String(first(item, ['id', 'commentId', 'cid', 'comment_id'])).trim(),
    platform,
    url: String(first(item, ['postUrl', 'post_url', 'video_url', 'videoUrl', 'videoWebUrl', 'submittedVideoUrl', 'pageUrl', 'source_url', 'inputUrl', 'input', 'url']) || fallbackUrl).trim(),
    username: String(first(item, ['username', 'ownerUsername', 'author_name', 'authorName', 'uniqueId']) || item?.author?.userName || item?.author?.username || '').trim(),
    text,
    timestamp: String(first(item, ['timestamp', 'createdAt', 'createTime', 'published_at', 'publishedAt', 'date'])).trim(),
    likeCount: Number(first(item, ['likesCount', 'like_count', 'likeCount', 'likes', 'diggCount']) || 0),
  };
  const parentId = String(first(item, ['conversationId', 'inReplyToId', 'parentId'])).trim();
  if (parentId) normalized.parentId = parentId;
  return normalized;
}

export function normalizeDataset(platform, items, fallbackUrl) {
  return items.map((item) => normalizeComment(platform, item, fallbackUrl)).filter(Boolean);
}

// 캠페인명 필터: 콤마 구분 다중 키워드 중 하나라도 이름에 포함되면 매칭.
// 플랫폼별 캠페인 명명 차이(실측: 틱톡=빙과, 유튜브=쫀득바)를 한 변수(AD_CAMPAIGN_NAME_FILTER)로 흡수.
// 빈 필터 = 전체 허용(기존 동작 보존).
export function campaignNameMatchesFilter(name, filter) {
  const keywords = String(filter || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return true;
  const hay = String(name || '');
  return keywords.some((k) => hay.includes(k));
}
