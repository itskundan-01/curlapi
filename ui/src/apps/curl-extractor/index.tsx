import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CURL_EXTRACTOR_ID, type Status } from './api.ts';
import { Launch } from './Launch.tsx';
import { Workspace } from './Workspace.tsx';
import { useAppStatus } from '../../shell/live.tsx';

/**
 * The app's two states: asking where to point the browser, and reviewing what
 * came back.
 *
 * Which one shows is decided by the capture's own state rather than by anything
 * held here, so a capture started from the command line, from another tab, or
 * from this form all land in the same place — and a browser the user quits by
 * hand drops back to the launch screen without a reload.
 */
export function CurlExtractor() {
  const status = useAppStatus<Status>(CURL_EXTRACTOR_ID);
  /** Set when a stored session is opened for review with nothing recording. */
  const [reviewing, setReviewing] = useState(false);

  const live = status?.capture.state === 'running' || status?.capture.state === 'stopping';

  // Read inside the transition effect below, which must not re-run on every
  // status push just to see the summary that came with the last one.
  const latest = useRef(status);
  latest.current = status;
  const wasLive = useRef(false);

  useEffect(() => {
    if (live) {
      // A capture supersedes whatever stored session was being reviewed.
      setReviewing(false);
    } else if (wasLive.current) {
      // The capture just ended, by Stop or by Chrome being quit. Stay on what it
      // kept: throwing the user back to the launch form the moment the browser
      // closes would hide the very thing they were capturing for. A session that
      // kept nothing is the exception — there is nothing there to stay on.
      setReviewing(latest.current?.capture.lastSummary?.sessionKept !== false);
    }
    wasLive.current = live;
  }, [live]);

  const openSession = useCallback(async (id: string) => {
    await api.selectSession(id).catch(() => undefined);
    setReviewing(true);
  }, []);

  if (!status) return <div className="app-loading">Loading…</div>;

  if (live || reviewing) {
    return <Workspace status={status} onNewCapture={() => setReviewing(false)} />;
  }

  return <Launch status={status} onOpenSession={(id) => void openSession(id)} />;
}
