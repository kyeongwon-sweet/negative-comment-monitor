export const YOUTUBE_SATELLITE_CHANNELS = Object.freeze([
  { name: '썰박스', handle: '@ssulbox-1', channelId: 'UCE5iE_6o4EU6x9CR6TnsXHw' },
  { name: '썰뜨기', handle: '@sseoltteugi', channelId: 'UCASoOEk77g0NTcblPf0RuBg' },
  { name: '이슈뜨기', handle: '@issuetteugi', channelId: 'UC5DKlx4R-7siM65GdlP1hnA' },
  { name: '이슈박스', handle: '@issuebox_x', channelId: 'UC9PyxanftI-l-j3I9vvb9Nw' },
  { name: '유머박스', handle: '@humorrbox', channelId: 'UC6oZw_I2oO_nKjIEfBt1l0A' },
  { name: '정리해드림', handle: '@allkill_2424', channelId: 'UC_rgT8r47YzIE7lXia03Nmg' },
  { name: '매일1분', handle: '@just1min_2424', channelId: 'UC_rLu8ulIc3pQ0zoq36Jxow' },
  { name: '이걸몰라?', handle: '@whydontuknow2424', channelId: 'UCQRxcMlnRXUHP5lHRmhcjdA' },
]);

export function resolveSatelliteChannel(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return YOUTUBE_SATELLITE_CHANNELS.find((channel) => [
    channel.name.toLowerCase(),
    channel.handle.toLowerCase(),
    channel.handle.slice(1).toLowerCase(),
    channel.channelId.toLowerCase(),
  ].includes(needle)) || null;
}

export function buildYouTubeOwnerAuthorizationUrl({ clientId, redirectUri, state }) {
  if (!String(clientId || '').trim()) throw new Error('Google OAuth client ID is required');
  if (!String(redirectUri || '').trim()) throw new Error('Google OAuth redirect URI is required');
  if (!String(state || '').trim()) throw new Error('OAuth state is required');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', String(clientId).trim());
  url.searchParams.set('redirect_uri', String(redirectUri).trim());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', String(state).trim());
  return url.toString();
}
