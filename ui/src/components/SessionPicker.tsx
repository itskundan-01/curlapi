import type { SessionSummary } from '../api.ts';

function when(startedAt: number): string {
  const date = new Date(startedAt);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * Switches which stored capture the UI is showing.
 *
 * Every run of `curlapi start` opens a new session, so without this the previous
 * one is still on disk but unreachable — which reads as the tool having thrown
 * the data away. Recording is unaffected by looking at an old one.
 */
export function SessionPicker({
  sessions,
  activeId,
  captureId,
  onSelect,
}: {
  sessions: SessionSummary[];
  activeId: string;
  captureId: string;
  onSelect: (id: string) => void;
}) {
  if (sessions.length <= 1) return null;

  // Naming the host on every row is noise when they all share one, which is the
  // normal case — you reverse-engineer one site at a time.
  const hosts = new Set(sessions.map((session) => session.primaryHost ?? ''));
  const showHost = hosts.size > 1;

  return (
    <select
      className="session-pick"
      value={activeId}
      title="Which stored capture to show"
      onChange={(event) => onSelect(event.target.value)}
    >
      {sessions.map((session) => (
        <option key={session.id} value={session.id}>
          {when(session.startedAt)} · {session.kept} calls
          {showHost && session.primaryHost ? ` · ${session.primaryHost}` : ''}
          {session.id === captureId ? ' · recording' : ''}
        </option>
      ))}
    </select>
  );
}
