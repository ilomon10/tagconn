import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { Button, Checkbox, Field, Input, Panel } from '../../components/ui';

/**
 * M8 8m pairing dialog (docs/design/runner-and-helpdesk.md section 5). Two flows depending on
 * `settings.auth.mode`:
 *   - `pairing` (default): redeem a one-time code from `pnpm office:pair` or the server's boot log.
 *     Prefilled and auto-opened by `AdminBadge` when the URL carries `#pair=<code>` (the format that
 *     link uses).
 *   - `same-origin` (file/env only): a single "bootstrap" button, no code needed — `POST
 *     /api/auth/bootstrap` 404s outside that mode, so the code form is hidden entirely there instead
 *     of just failing.
 */
export function PairingDialog({ onClose }: { onClose: () => void }) {
  const mode = useAuthStore((s) => s.status.mode);
  const prefilledCode = useAuthStore((s) => s.prefilledCode);
  const remember = useAuthStore((s) => s.remember);
  const setRemember = useAuthStore((s) => s.setRemember);
  const pair = useAuthStore((s) => s.pair);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const pairError = useAuthStore((s) => s.pairError);

  const [code, setCode] = useState(prefilledCode);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  // Adopt a fragment-supplied code even if the dialog was already open (e.g. a second pairing link).
  useEffect(() => setCode(prefilledCode), [prefilledCode]);

  const submitPair = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      await pair(code, label.trim() || undefined);
    } catch {
      // `pairError` (from the store) renders below; nothing else to do here.
    } finally {
      setBusy(false);
    }
  };

  const submitBootstrap = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bootstrap(label.trim() || undefined);
    } catch {
      // ditto
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
      onClick={onClose}
      data-modal="pairing"
      aria-modal="true"
      role="dialog"
      aria-label="Pair this browser"
    >
      <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <Panel
          title="Pair this browser"
          actions={
            <Button variant="ghost" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          }
        >
          <div className="space-y-3 p-3">
            <p className="rounded-md border border-amber-700/40 bg-amber-900/20 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
              Pairing gives this browser the power to run Claude on your machine — only pair a browser you trust. An admin
              session means code execution as the host user.
            </p>

            {mode === 'same-origin' ? (
              <div className="space-y-2">
                <Field label="Label (optional)" hint="Shown in the sessions list, e.g. “Firefox on laptop”.">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="This browser" maxLength={80} />
                </Field>
                <Checkbox checked={remember} onChange={setRemember} label="Remember on this device" />
                {pairError && (
                  <p role="alert" className="text-[11px] text-red-300">
                    {pairError}
                  </p>
                )}
                <Button variant="primary" className="w-full" disabled={busy} onClick={() => void submitBootstrap()}>
                  {busy ? 'Enabling…' : 'Enable admin access'}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Field label="Pairing code" hint="From `pnpm office:pair`, or the code the server printed at boot.">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitPair();
                    }}
                    placeholder="ABCD-EFGH-JKMN"
                    autoFocus
                    maxLength={20}
                  />
                </Field>
                <Field label="Label (optional)" hint="Shown in the sessions list, e.g. “Firefox on laptop”.">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="This browser" maxLength={80} />
                </Field>
                <Checkbox checked={remember} onChange={setRemember} label="Remember on this device" />
                {pairError && (
                  <p role="alert" className="text-[11px] text-red-300">
                    {pairError}
                  </p>
                )}
                <Button variant="primary" className="w-full" disabled={busy || !code.trim()} onClick={() => void submitPair()}>
                  {busy ? 'Pairing…' : 'Pair'}
                </Button>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
