import type { ReplayResult } from '../api.ts';
import { formatBytes, formatMs, prettyJson } from '../../../util.ts';
import { TokenExplanation } from './Tokens.tsx';
import type { HeaderPair } from '@core/types.ts';

function ShapeNote({ result }: { result: ReplayResult }) {
  if (result.shapeMatchesCapture === null) return null;
  return result.shapeMatchesCapture ? (
    <span className="badge ok">same shape as capture</span>
  ) : (
    <span className="badge warn">shape differs from capture</span>
  );
}

/** Shared by the detail pane and the collection cards so a run looks identical in both. */
export function RunResult({
  result,
  requestHeaders,
  singleUse,
}: {
  result: ReplayResult;
  requestHeaders?: HeaderPair[];
  /** Known-unreplayable, so a rejection is expected rather than a surprise. */
  singleUse?: boolean;
}) {
  if (result.error) {
    return (
      <div className="run-result">
        <div className="run-meta">
          <span className="badge err">failed</span>
          <span className="hint">{result.error}</span>
        </div>
      </div>
    );
  }

  const ok = result.status !== null && result.status < 400;

  return (
    <div className="run-result">
      <div className="run-meta">
        <span className={`badge ${ok ? 'ok' : 'err'}`}>
          {result.status} {result.statusText}
        </span>
        <span className="hint">{formatMs(result.durationMs)}</span>
        <span className="hint">{formatBytes(result.sizeBytes)}</span>
        <ShapeNote result={result} />
        {singleUse && !ok ? (
          <span className="hint">
            expected — this is a one-time request and the server already consumed it
          </span>
        ) : (
          requestHeaders && (
            <TokenExplanation headers={requestHeaders} status={result.status} />
          )
        )}
      </div>
      {result.bodyEncoding === 'base64' ? (
        <p className="hint">Binary response, {formatBytes(result.sizeBytes)}.</p>
      ) : (
        <pre className="code">{prettyJson(result.body)}</pre>
      )}
      {result.truncated && <p className="hint">Preview capped; the rest was not downloaded.</p>}
    </div>
  );
}
