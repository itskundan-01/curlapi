import { useCallback, useRef, useState } from 'react';
import { api, type ImportSummary } from './api.ts';
import { ConfirmButton } from '../curl-extractor/components/ConfirmButton.tsx';
import { IconDocument, IconSpinner } from '../../shell/icons.tsx';

/**
 * What the app opens on: drop the document in.
 *
 * Files are uploaded one at a time and reported individually, because a batch
 * that half-fails is worse than either outcome — the reader needs to know which
 * document could not be read, not that "an import failed".
 */
export function Upload({
  imports,
  onOpen,
  onChanged,
}: {
  imports: ImportSummary[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Array<{ file: string; message: string }>>([]);
  const input = useRef<HTMLInputElement>(null);

  const ingest = useCallback(
    async (files: FileList | File[]) => {
      setErrors([]);
      const failures: Array<{ file: string; message: string }> = [];
      let lastId: string | null = null;

      for (const file of Array.from(files)) {
        setBusy(file.name);
        try {
          const result = await api.import(file);
          lastId = result.id;
        } catch (err) {
          failures.push({
            file: file.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      setBusy(null);
      setErrors(failures);
      onChanged();
      // Straight into the last document that worked; there is nothing to decide.
      if (lastId) onOpen(lastId);
    },
    [onChanged, onOpen],
  );

  return (
    <main className="upload">
      <header className="upload-hero">
        <h1>Turn an API document into runnable requests</h1>
        <p>
          Drop in the file the department sent. Every endpoint in it comes back as
          a request you can read, run and export — instead of retyping each one
          into Postman to find out whether it works.
        </p>
      </header>

      <div
        className={`dropzone${dragging ? ' over' : ''}${busy ? ' busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length > 0) void ingest(event.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.current?.click();
          }
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".docx,.pdf,.md,.markdown,.txt,.json"
          onChange={(event) => {
            if (event.target.files?.length) void ingest(event.target.files);
            // Cleared so re-picking the same file fires change again.
            event.target.value = '';
          }}
        />
        {busy ? (
          <>
            <span className="dropzone-icon spin" aria-hidden="true">
              <IconSpinner size={20} />
            </span>
            <strong>Reading {busy}…</strong>
          </>
        ) : (
          <>
            <span className="dropzone-icon" aria-hidden="true">
              <IconDocument size={22} />
            </span>
            <strong>Drop a document here, or click to choose one</strong>
            <span className="dropzone-formats">
              Word (.docx) · PDF · Markdown · plain text · Postman &amp; OpenAPI JSON
            </span>
          </>
        )}
      </div>

      {errors.length > 0 && (
        <div className="upload-errors">
          {errors.map((error) => (
            <div key={error.file}>
              <strong>{error.file}</strong>
              <span>{error.message}</span>
            </div>
          ))}
        </div>
      )}

      <p className="upload-note">
        The document is read on this machine and never uploaded anywhere. Bear in
        mind that these files usually carry live API keys — treat what comes out
        of them the same way.
      </p>

      {imports.length > 0 && (
        <section className="upload-list">
          <h2>Imported documents</h2>
          <ul>
            {imports.map((entry) => (
              <li key={entry.id}>
                <button className="stored" onClick={() => onOpen(entry.id)}>
                  <span className="stored-label">{entry.title}</span>
                  <span className="stored-host">{entry.format}</span>
                  <span className="stored-counts">
                    {entry.endpointCount} endpoint{entry.endpointCount === 1 ? '' : 's'}
                  </span>
                  <span className="stored-when">
                    {new Date(entry.importedAt).toLocaleString()}
                  </span>
                </button>
                <ConfirmButton
                  className="btn small danger"
                  confirmLabel="Delete?"
                  title="Remove this import"
                  onConfirm={() => void api.deleteImport(entry.id).then(onChanged)}
                >
                  ✕
                </ConfirmButton>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
