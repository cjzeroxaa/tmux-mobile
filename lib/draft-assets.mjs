import { createHash, createHmac } from 'node:crypto';
import { ASSET_ORIGIN, ASSET_KEY_PATTERN, ASSET_URL_PATTERN } from '../public/skills/tmax-drafts/scripts/asset-contract.mjs';
export { ASSET_ORIGIN };
export const ASSET_TTL_SECONDS = 86400;
export const machineAssetPrefix = machineId => createHash('sha256').update(machineId).digest('hex') + '/';
export function assetSigningKey(sessionSecret) {
  if(!sessionSecret) throw Object.assign(Error('Draft asset signing is unavailable'),{status:503});
  return createHmac('sha256',sessionSecret).update('tmax-draft-assets-v1').digest('hex');
}
export function isDraftAssetUrl(value, machineId) {
  try {
    const u=new URL(value), key=u.pathname.slice(1);
    return u.origin===ASSET_ORIGIN && !u.search && !u.hash && !u.username && !u.password &&
      ASSET_KEY_PATTERN.test(key) && !!machineId && key.startsWith(machineAssetPrefix(machineId));
  } catch { return false; }
}
export function validateAssetReferences(html, machineId) {
  for(const match of html.matchAll(ASSET_URL_PATTERN)) {
    if(!isDraftAssetUrl(match[0],machineId)) throw Object.assign(Error('Draft assets must belong to the publishing machine'),{status:400});
  }
}
export function signDraftAssets(html, machineId, sessionSecret, now=Date.now()) {
  return html.replace(ASSET_URL_PATTERN,url=>{
    if(!isDraftAssetUrl(url,machineId)) throw Object.assign(Error('Invalid Draft asset reference'),{status:400});
    const exp=Math.floor(now/1000)+ASSET_TTL_SECONDS;
    const pathname=new URL(url).pathname;
    const sig=createHmac('sha256',assetSigningKey(sessionSecret)).update(`${pathname}\n${exp}`).digest('base64url');
    return `${url}?token=${exp}.${sig}`;
  });
}
