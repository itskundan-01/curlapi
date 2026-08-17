import type { AppManifest } from '../../platform/app.ts';

export const CURL_EXTRACTOR_ID = 'curl-extractor';

export const manifest: AppManifest = {
  id: CURL_EXTRACTOR_ID,
  name: 'cURL Extractor',
  tagline: "Capture a site's real API calls as working curl commands.",
  description:
    'Point it at a site, browse the way you normally would, and every API call ' +
    'behind what you did is captured with the headers that actually went on the ' +
    'wire — cookies included. Pick the ones that matter, run them, and export ' +
    'them as curl, a Postman collection, or a document.',
  icon: '⚡',
  status: 'ready',
  launch: 'url',
  highlights: [
    'Byte-for-byte match with Chrome’s Copy as cURL',
    'Noise filtered out, with a reason recorded for every drop',
    'Replay any endpoint and see why a dead one died',
  ],
};
