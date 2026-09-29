import { useEffect, useState } from 'react';
import type { PairInfo } from '../lib/tauri';
import { countdown } from '../lib/wait';
import { Button, Dialog } from './ui';

/** Shows the one-time pairing code for the browser: it is typed there, never put on a command line. */
export function PairCodeDialog({ pairing, port, onCopy, onClose }: { pairing: PairInfo; port?: number; onCopy: (code: string) => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = countdown(pairing.expiresAt, now);
  return (
    <Dialog title="Pairing code" onClose={onClose}>
      <p className="text-sm">
        The office opened in your browser{port ? ` at http://127.0.0.1:${port}/` : ''}. Enter this code in its pairing dialog:
      </p>
      <p aria-label="Pairing code" className="my-3 select-all rounded-md bg-ink-950 p-3 text-center font-pixel text-2xl tracking-widest">
        {pairing.code}
      </p>
      <p role="status" className="text-xs text-ink-300">
        {left ? `Valid for ${left}. It works once.` : 'This code expired. Close this and choose Open in browser again for a new one.'}
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" data-autofocus onClick={() => onCopy(pairing.code)} disabled={!left}>
          Copy code
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
