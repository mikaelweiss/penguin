// Shim for the vendored terminal: isMacPlatform copied verbatim from
// t3code apps/web/src/lib/utils.ts at the commit in ../../UPSTREAM.

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}
