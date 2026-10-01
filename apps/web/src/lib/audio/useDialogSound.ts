import { useEffect } from 'react';
import { uiSound } from './uiSound';

/** Plays `ui-open` when `open` becomes true (or on mount) and `ui-close` when it ends (or on unmount). */
export function useDialogSound(open = true): void {
  useEffect(() => {
    if (!open) return;
    uiSound('ui-open');
    return () => uiSound('ui-close');
  }, [open]);
}
