import type { UiApp } from '../../shell/apps.tsx';
import { CURL_EXTRACTOR_ID, type Status } from './api.ts';
import { CurlExtractor } from './index.tsx';

export const curlExtractorUi: UiApp = {
  id: CURL_EXTRACTOR_ID,
  component: CurlExtractor,
  activity(status) {
    const state = (status as Status | null)?.capture;
    if (!state) return null;
    if (state.state === 'starting') return { label: 'Launching…', tone: 'warn' };
    if (state.state === 'stopping') return { label: 'Finishing…', tone: 'warn' };
    if (state.state !== 'running') return null;

    // Named by what it is pointed at rather than "Recording", so a dashboard
    // left open across several captures says which one is live.
    const host = hostOf((status as Status).capture.targetUrl) ?? (status as Status).primaryHost;
    return { label: host ? `Recording ${host}` : 'Recording', tone: 'live' };
  },
};

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
