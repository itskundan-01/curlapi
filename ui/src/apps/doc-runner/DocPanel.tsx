import type { Endpoint } from './api.ts';
import { statusClass } from '../../util.ts';

/**
 * What the document said, kept beside the request rather than behind a tab.
 *
 * This is the pairing the app is for. Deciding what to put in a field means
 * reading the field table; deciding whether a run went right means comparing it
 * against the documented response. Both are one-glance questions, and a tab
 * makes them a click and a memory test instead.
 */
export function DocPanel({ endpoint }: { endpoint: Endpoint }) {
  const request = endpoint.params.filter((param) => param.in !== 'response');
  const response = endpoint.params.filter((param) => param.in === 'response');

  /**
   * A document that only gave the command itself — common for a browser export.
   * Saying so once is better than three empty sections each explaining their own
   * absence.
   */
  const bare =
    !endpoint.documentedResponse &&
    endpoint.params.length === 0 &&
    endpoint.responseCodes.length === 0 &&
    !endpoint.description;

  return (
    <div className="doc-panel">
      <header className="doc-panel-head">
        <h3>From the document</h3>
        <span
          className="provenance"
          title={`Read as a ${endpoint.provenance.extractor} layout`}
        >
          {endpoint.provenance.extractor} · {Math.round(endpoint.provenance.confidence * 100)}%
        </span>
      </header>

      <div className="doc-panel-body">
        {endpoint.section.length > 0 && (
          <p className="doc-section">{endpoint.section.join(' › ')}</p>
        )}

        {endpoint.description && <p className="doc-description">{endpoint.description}</p>}

        {endpoint.warnings.length > 0 && (
          <div className="doc-warnings">
            {endpoint.warnings.map((warning) => (
              <span key={warning}>⚠ {warning}</span>
            ))}
          </div>
        )}

        {endpoint.documentedResponse && (
          <Section title="Documented response">
            <pre className="code">{endpoint.documentedResponse}</pre>
          </Section>
        )}

        {request.length > 0 && (
          <Section title="Fields you send">
            <FieldTable fields={request} />
          </Section>
        )}

        {response.length > 0 && (
          <Section title="Fields you get back">
            <FieldTable fields={response} />
          </Section>
        )}

        {endpoint.responseCodes.length > 0 && (
          <Section title="Response codes">
            <table className="mini">
              <tbody>
                {endpoint.responseCodes.map((code) => (
                  <tr key={code.code}>
                    <td className="code-cell">
                      <span className={`status ${statusClass(Number(code.code) || null)}`}>
                        {code.code}
                      </span>
                    </td>
                    <td>{code.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {bare && (
          <p className="muted">
            The document gave nothing beyond the request itself — no expected
            response, no field descriptions. Running it is the way to find out
            what it returns.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="doc-section-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function FieldTable({ fields }: { fields: Endpoint['params'] }) {
  return (
    <table className="mini">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={`${field.in}-${field.name}`}>
            <td className="mono">
              {field.name}
              {field.required && (
                <span className="required" title="Required">
                  *
                </span>
              )}
              {field.in !== 'body' && field.in !== 'response' && (
                <em className="in-badge">{field.in}</em>
              )}
            </td>
            <td>{field.dataType || '—'}</td>
            <td>
              {field.description || '—'}
              {field.expected && <div className="expected mono">{field.expected}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
