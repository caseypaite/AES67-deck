import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Shared modal shell — matches the patchbay/FX dialog style. Rendered through
// a portal to <body> so it clears every ancestor stacking context / overflow
// clip (mastering panel, FX rack, …), not just its local subtree.
function Shell({ title, onClose, children, width = 340 }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-[#1a1c22] border border-[#2a2d33] rounded-sm p-4 flex flex-col gap-3 shadow-2xl"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-bold text-white text-sm">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface SaveDialogProps {
  title: string;
  label?: string;
  existing: string[];
  initialName?: string;
  confirmLabel?: string;
  /** Label for existing entries, e.g. "scenes" / "projects". */
  existingLabel?: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

// Name-and-replace save dialog. Pick an existing entry to overwrite it, or
// type a new name.
export function SaveDialog({
  title, label = 'Name', existing, initialName = '', confirmLabel = 'Save',
  existingLabel = 'existing', onSave, onClose,
}: SaveDialogProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const trimmed = name.trim();
  const replaces = existing.includes(trimmed);
  const canSave = trimmed.length > 0;

  const commit = () => { if (canSave) { onSave(trimmed); onClose(); } };

  return (
    <Shell title={title} onClose={onClose}>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-black tracking-widest uppercase text-gray-500">{label}</span>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          className="bg-[#0b0c10] border border-[#2a2d33] text-gray-200 text-sm px-2 py-1.5 rounded-sm outline-none focus:border-blue-500"
        />
      </label>

      {existing.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-black tracking-widest uppercase text-gray-500">Replace {existingLabel}</span>
          <div className="max-h-40 overflow-y-auto flex flex-col gap-0.5 bg-[#0b0c10] border border-[#2a2d33] rounded-sm p-1">
            {existing.map((n) => (
              <button
                key={n}
                onClick={() => setName(n)}
                className={`text-left text-xs px-2 py-1 rounded-sm truncate ${
                  n === trimmed ? 'bg-amber-700/60 text-white' : 'text-gray-300 hover:bg-[#23262d]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold rounded-sm bg-[#23262d] text-gray-300 hover:bg-[#2c2f37]">
          Cancel
        </button>
        <button
          onClick={commit}
          disabled={!canSave}
          className={`px-3 py-1.5 text-xs font-bold rounded-sm text-white disabled:opacity-40 ${
            replaces ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'
          }`}
        >
          {replaces ? 'Replace' : confirmLabel}
        </button>
      </div>
    </Shell>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Optional extra content (e.g. a checkbox) rendered between the message and buttons. */
  children?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = 'OK', danger, children, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Shell title={title} onClose={onClose} width={360}>
      <div className="text-xs text-gray-300 leading-relaxed">{message}</div>
      {children}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold rounded-sm bg-[#23262d] text-gray-300 hover:bg-[#2c2f37]">
          Cancel
        </button>
        <button
          onClick={() => { onConfirm(); onClose(); }}
          className={`px-3 py-1.5 text-xs font-bold rounded-sm text-white ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Shell>
  );
}
