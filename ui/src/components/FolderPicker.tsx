import { useState } from 'react';
import type { DocFolder } from '../api.ts';

/**
 * Chooses which document an Add-to-doc lands in, and creates one inline.
 *
 * Deliberately a plain select rather than a menu that opens on Add: the target
 * is visible before the click, so filing ten requests into the right document
 * is one decision rather than ten dialogs.
 */
export function FolderPicker({
  folders,
  activeId,
  onSelect,
  onCreate,
}: {
  folders: DocFolder[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const commit = () => {
    const value = name.trim();
    setName('');
    setCreating(false);
    if (value.length > 0) onCreate(value);
  };

  if (creating) {
    return (
      <input
        className="folder-rename inline"
        autoFocus
        placeholder="Document name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setName('');
            setCreating(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <span className="hint">into</span>
      <select
        value={activeId ?? ''}
        title="Which document these are added to"
        disabled={folders.length === 0}
        onChange={(event) => onSelect(event.target.value)}
      >
        {folders.length === 0 ? (
          // What the server will create on the first add, named as it will be.
          <option value="">API notes</option>
        ) : (
          folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))
        )}
      </select>
      <button
        className="btn small"
        title="New document"
        aria-label="New document"
        onClick={() => setCreating(true)}
      >
        ＋
      </button>
    </>
  );
}
