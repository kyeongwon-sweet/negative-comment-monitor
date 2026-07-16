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
