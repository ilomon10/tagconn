import { Button, Dialog } from './ui';

/** Blocking panel: the service manager is gone and one relaunch did not help. */
export function SidecarDown({ reason, logs, retrying, onRetry, onCopy }: { reason: string; logs: string[]; retrying: boolean; onRetry: () => void; onCopy: (text: string) => void }) {
  const text = logs.join('\n');
  return (
    <Dialog title="Service manager stopped" blocking>
      <p className="text-sm">{reason}</p>
      <p className="mt-1 text-sm text-ink-300">Your services are not managed right now. Retry starts the service manager again.</p>
      <pre tabIndex={0} aria-label="Service manager log" className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink-950 p-2 font-pixel text-xs">
        {text || 'No output was captured.'}
      </pre>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" data-autofocus onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying' : 'Retry'}
        </Button>
        <Button onClick={() => onCopy(text)} disabled={!text}>
          Copy logs
        </Button>
      </div>
    </Dialog>
  );
}
