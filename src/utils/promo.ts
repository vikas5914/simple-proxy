// DramaTip's CDN (cdn.dramadizilerim.xyz) answers datacenter IPs with a 302 to a 10-second
// "watch full episodes on dramatip.net" clip in place of the requested playlist or segment.
// Passing it on would make the player treat the ad as a working source.
const PROMO_HOST = /^dxpromo\d*\.b-cdn\.net$/i;

export function isPromoRedirect(response: Response): boolean {
  if (!response.redirected || !response.url) return false;
  try {
    return PROMO_HOST.test(new URL(response.url).hostname);
  } catch {
    return false;
  }
}
