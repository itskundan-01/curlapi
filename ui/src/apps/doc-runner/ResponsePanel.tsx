import { useState } from 'react';
import type { Endpoint, ReplayResult } from './api.ts';
import { CopyButton } from '../curl-extractor/components/CopyButton.tsx';
import { formatBytes, formatMs, prettyJson, statusClass } from '../../util.ts';

/**
 * What came back.
 *
 * Takes no room until there is something to show — the previous version kept a
 * tall empty region reserved under every request, which read as a broken panel.
 * Once a run happens it claims the space it needs and no more.
 *
 * The comparison against the documented response is the reason to run anything
 * here at all, so it is stated in words at the top rather than left as a badge.
 */
export function ResponsePanel({
  endpoint,
  result,
  blocked,
  running,
}: {
  endpoint: Endpoint;
  result: ReplayResult | null;
  blocked: string | null;
  running: boolean;
}) {
  const [tab, setTab] = useState<'body' | 'headers' | 'compare'>('body');

  if (blocked) {
    return (
      <div className="response-panel blocked">
        <div className="response-blocked">{blocked}</div>
      </div>
    );
  }

  if (running) {
    return (
      <div className="response-panel">
        <div className="response-status">
          <span className="muted">Sending…</span>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const failed = result.error !== null;
  const body = result.bodyEncoding === 'base64' ? '(binary response)' : prettyJson(result.body);

  return (
    <div className="response-panel">
      <div className="response-status">
        {failed ? (
          <span className="status s5">Failed</span>
        ) : (
          <span className={`status ${statusClass(result.status)}`}>
            {result.status} {result.statusText}
          </span>
        )}
        <span className="muted">{formatMs(result.durationMs)}</span>
        <span className="muted">{formatBytes(result.sizeBytes)}</span>

        {result.shapeMatchesCapture !== null && (
          <span className={`badge ${result.shapeMatchesCapture ? 'ok' : 'warn'}`}>
            {result.shapeMatchesCapture
              ? 'matches the documented shape'
              : 'differs from the documented shape'}
          </span>
        )}

        <div className="spacer" />

        <nav className="response-tabs" role="tablist">
          {(
            [
              ['body', 'Body'],
              ['headers', `Headers (${result.headers.length})`],
              ...(endpoint.documentedResponse
                ? ([['compare', 'Compare']] as const)
                : ([] as const)),
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              className="response-tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <CopyButton text={result.body} label="Copy the response" />
      </div>

      {failed && <div className="response-error">{result.error}</div>}

      {!failed && tab === 'body' && (
        <pre className="code response-body">{body || '(empty response)'}</pre>
      )}

      {!failed && tab === 'headers' && (
        <table className="mini response-headers">
          <tbody>
            {result.headers.map(([name, value], index) => (
              <tr key={`${name}-${index}`}>
                <td className="mono">{name}</td>
                <td className="mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Side by side, because "is this the same as what was promised" is a
          question about two things and answering it from memory is guesswork. */}
      {!failed && tab === 'compare' && endpoint.documentedResponse && (
        <div className="response-compare">
          <div>
            <h5>Documented</h5>
            <pre className="code">{endpoint.documentedResponse}</pre>
          </div>
          <div>
            <h5>Actual</h5>
            <pre className="code">{body}</pre>
          </div>
        </div>
      )}

      {result.truncated && (
        <p className="response-note">
          The response was longer than the preview limit and was cut off here.
        </p>
      )}
    </div>
  );
}
