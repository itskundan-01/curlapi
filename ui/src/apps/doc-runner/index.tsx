import { useCallback, useEffect, useState } from 'react';
import { api, type ImportSummary } from './api.ts';
import { Upload } from './Upload.tsx';
import { Workspace } from './Workspace.tsx';

/**
 * The app's two states: nothing imported yet, and one document open.
 *
 * Which import is open is held here rather than in the URL, because a document
 * is working state a reader moves between — not a place worth a bookmark.
 */
export function DocRunner() {
  const [imports, setImports] = useState<ImportSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api
      .imports()
      .then((list) => {
        setImports(list);
        // An import deleted from elsewhere should not leave a dead workspace up.
        setOpenId((current) =>
          current && list.some((entry) => entry.id === current) ? current : null,
        );
      })
      .catch(() => setImports([]));
  }, []);

  useEffect(() => refresh(), [refresh]);

  if (imports === null) return <div className="app-loading">Loading…</div>;

  if (openId) {
    return (
      <Workspace
        importId={openId}
        onBack={() => {
          setOpenId(null);
          refresh();
        }}
      />
    );
  }

  return <Upload imports={imports} onOpen={setOpenId} onChanged={refresh} />;
}
