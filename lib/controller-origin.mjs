// Both production names serve the same controller and identity namespace.
export const CONTROLLER_ORIGIN = "https://eng.xyznot.com";
export const LEGACY_CONTROLLER_ORIGIN = "https://eng.impo.ai";

export function canonicalControllerUrl(value) {
  const raw = String(value || CONTROLLER_ORIGIN);
  try {
    const url = new URL(raw);
    if (url.origin === LEGACY_CONTROLLER_ORIGIN) {
      return CONTROLLER_ORIGIN + (url.pathname === "/" ? "" : url.pathname) + url.search + url.hash;
    }
  } catch { /* Preserve custom configuration for the caller's validation. */ }
  return raw;
}

// Keep the original key so old binaries, rollback, stored credentials and
// singleton locks all refer to the same machine. Never alias custom servers.
export function controllerIdentityKey(value) {
  const origin = new URL(value).origin;
  return origin === CONTROLLER_ORIGIN ? LEGACY_CONTROLLER_ORIGIN : origin;
}

export function controllerOAuthRedirectUri(requestOrigin, configuredUri) {
  if ([CONTROLLER_ORIGIN, LEGACY_CONTROLLER_ORIGIN].includes(requestOrigin)) {
    return `${requestOrigin}/auth/google/callback`;
  }
  return configuredUri || `${requestOrigin}/auth/google/callback`;
}
