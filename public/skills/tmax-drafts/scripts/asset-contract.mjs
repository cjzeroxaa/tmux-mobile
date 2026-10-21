// Public deployment contract. Credentials are never part of this module.
export const ASSET_ORIGIN = 'https://draft-assets.xyznot.com';
export const ASSET_BUCKET = 'tmax-draft-assets';
export const ASSET_ACCOUNT = '34431cd51da281ed3590ab6ce5141d09';
export const ASSET_KEY_PATTERN = /^[a-f0-9]{64}\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/;
export const ASSET_URL_PATTERN = /https:\/\/draft-assets\.xyznot\.com\/[a-f0-9]{64}\/[a-f0-9]{64}\.[a-z0-9]{1,10}(?![a-z0-9./?%#-])/g;
export const ASSET_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  vtt: 'text/vtt', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  json: 'application/json', zip: 'application/zip', bin: 'application/octet-stream',
};
