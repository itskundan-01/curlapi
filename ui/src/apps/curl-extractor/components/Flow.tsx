import type { Dependency, Replayability } from '../api.ts';

/**
 * Explains why a request may refuse to be replayed, and where its inputs came
 * from. For a single-use endpoint the dependency list is the more useful half:
 * it names the step a wrapper has to perform instead of replaying this one.
 */
export function Flow({
  replayability,
  dependencies,
}: {
  replayability: Replayability;
  dependencies: Dependency[];
}) {
  const singleUse = replayability.verdict === 'single-use';
  if (!singleUse && dependencies.length === 0) return null;

  return (
    <div className="flow">
      {singleUse && (
        <>
          <div className="chips">
            <span className="badge warn">one-time request</span>
          </div>
          <p className="hint">
            Running this again will fail however fresh the credentials are — it{' '}
            {replayability.reasons.join('; ')}. The server consumed those values the
            first time.
          </p>
        </>
      )}

      {dependencies.length > 0 && (
        <>
          <p className="hint">
            {singleUse
              ? 'To automate it, reproduce the request that issued those values:'
              : 'Values in this request came from earlier responses:'}
          </p>
          <ul className="deps">
            {dependencies.map((dependency) => (
              <li key={dependency.producerId}>
                <span className="dep-seq">#{dependency.producerSeq}</span>
                <span className="dep-name">{dependency.producerName}</span>
                <span className="hint">
                  {dependency.links
                    .map(
                      (link) =>
                        `${link.producedAs} → ${link.consumedAs} (${link.where})`,
                    )
                    .join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
