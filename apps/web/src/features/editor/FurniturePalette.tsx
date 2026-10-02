import { useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { kindGlyph, kindLabel } from './glyphs';

/**
 * Furniture tool palette (M16, docs/design/furnishing.md section 6.3): pick a kind and the next click on a
 * room's interior drops a free pin of that size (`PlanCanvas` does the placing; Esc disarms). Read-only
 * on a builtin layout, where nothing can be placed.
 */

export interface PaletteKind {
  kind: string;
  w: number;
  h: number;
}

export const PALETTE_GROUPS: { title: string; kinds: PaletteKind[] }[] = [
  {
    title: 'Seating',
    kinds: [
      { kind: 'chair', w: 1, h: 1 },
      { kind: 'armchair', w: 1, h: 1 },
      { kind: 'sofa', w: 3, h: 1 },
      { kind: 'bench', w: 2, h: 1 },
    ],
  },
  {
    title: 'Desks and tables',
    kinds: [
      { kind: 'work-desk', w: 2, h: 1 },
      { kind: 'table', w: 2, h: 1 },
      { kind: 'counter', w: 2, h: 1 },
      { kind: 'board-game-table', w: 2, h: 1 },
    ],
  },
  {
    title: 'Storage',
    kinds: [
      { kind: 'bookcase', w: 2, h: 1 },
      { kind: 'cabinet', w: 1, h: 1 },
      { kind: 'filing-cabinet', w: 1, h: 1 },
      { kind: 'crate', w: 1, h: 1 },
      { kind: 'bin', w: 1, h: 1 },
    ],
  },
  {
    title: 'Decor',
    kinds: [
      { kind: 'plant', w: 1, h: 1 },
      { kind: 'lamp', w: 1, h: 1 },
      { kind: 'rug', w: 3, h: 2 },
      { kind: 'board', w: 2, h: 1 },
      { kind: 'notice-board', w: 1, h: 1 },
      { kind: 'roster-board', w: 1, h: 1 },
    ],
  },
  {
    title: 'Fun and appliances',
    kinds: [
      { kind: 'arcade', w: 1, h: 1 },
      { kind: 'ping-pong', w: 2, h: 1 },
      { kind: 'foosball', w: 2, h: 1 },
      { kind: 'water-cooler', w: 1, h: 1 },
      { kind: 'coffee-machine', w: 1, h: 1 },
      { kind: 'printer', w: 1, h: 1 },
      { kind: 'fridge', w: 1, h: 1 },
    ],
  },
];

/** Every palette entry, flat (tests and the placing hint read it). */
export const PALETTE_KINDS: PaletteKind[] = PALETTE_GROUPS.flatMap((g) => g.kinds);

export function FurniturePalette({ disabled }: { disabled: boolean }) {
  const placing = useEditorStore((s) => s.placing);
  const setPlacing = useEditorStore((s) => s.setPlacing);
  const [open, setOpen] = useState(true);

  return (
    <div className="absolute left-2 top-2 z-10 w-52 overflow-hidden rounded-lg border border-ink-600 bg-ink-850/95 text-xs shadow-xl backdrop-blur">
      <button
        type="button"
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-ink-300 hover:bg-ink-800"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Add furniture</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="max-h-[55vh] space-y-2 overflow-y-auto border-t border-ink-700 p-2">
          {disabled ? (
            <p className="text-[11px] text-ink-400">Read-only builtin: Duplicate to edit to place furniture.</p>
          ) : (
            <>
              {PALETTE_GROUPS.map((g) => (
                <div key={g.title}>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-400">{g.title}</div>
                  <div className="grid grid-cols-3 gap-1">
                    {g.kinds.map((k) => {
                      const active = placing?.kind === k.kind;
                      return (
                        <button
                          key={k.kind}
                          type="button"
                          title={`${kindLabel(k.kind)} (${k.w} x ${k.h})`}
                          aria-pressed={active}
                          onClick={() => setPlacing(active ? null : k)}
                          className={
                            'flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 transition-colors duration-100 active:scale-[0.97] ' +
                            (active ? 'border-cozy bg-cozy/20 text-cozy' : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-ink-600 hover:bg-ink-800')
                          }
                        >
                          <span className="text-base leading-none" aria-hidden>
                            {kindGlyph(k.kind)}
                          </span>
                          <span className="w-full truncate text-center text-[9px] leading-tight">{kindLabel(k.kind)}</span>
                          <span className="font-mono text-[8px] text-ink-400">
                            {k.w}x{k.h}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-ink-400">{placing ? 'Click inside a room to place it. Esc to cancel.' : 'Pick a piece, then click inside a room.'}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
