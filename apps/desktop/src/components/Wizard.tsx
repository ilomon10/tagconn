import { useState } from 'react';
import type { SetupCheck } from '@tagconn/shared';
import { addFolder, removeFolder } from '../lib/paths';
import { visibleServices } from '../lib/state';
import type { Desktop } from '../lib/useDesktop';
import { STEP_TITLES, WIZARD_STEPS, blockingChecks, canAdvance, nextStep, prevStep, summarizeChecks, type WizardStep } from '../lib/wizard';
import { SERVICE_LABELS, ServiceRow } from './ServiceRow';
import { Button, CheckIcon, Toggle } from './ui';

function CheckRow({ check, d, gotoHooks }: { check: SetupCheck; d: Desktop; gotoHooks: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
      <CheckIcon status={check.status} />
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium">
          {check.title}
          {!check.required && <span className="ml-2 text-xs font-normal text-ink-300">(optional)</span>}
        </p>
        <p className="whitespace-pre-wrap text-xs text-ink-300">{check.detail}</p>
      </div>
      {check.fix && (
        <Button disabled={d.busy.has(`fix:${check.fix.action}`)} onClick={() => void d.applyFix(check.fix!, gotoHooks)}>
          {check.fix.label}
        </Button>
      )}
    </li>
  );
}

export function Wizard({ d, onFinish }: { d: Desktop; onFinish: () => void }) {
  const [step, setStep] = useState<WizardStep>('welcome');
  const gate = { checks: d.checks, checking: d.checking, installResult: d.installResult, services: d.state.services };
  const ok = canAdvance(step, gate);
  const idx = WIZARD_STEPS.indexOf(step);
  const config = d.config;
  const runMode = config?.runMode ?? 'native';
  const settingsPath = d.info ? `${d.info.paths.claudeDir}/settings.json` : '~/.claude/settings.json';

  const addDir = async () => {
    if (!config) return;
    try {
      const dir = await d.pickDir();
      if (dir) await d.saveConfig({ allowedProjectDirs: addFolder(config.allowedProjectDirs, dir) });
    } catch (e) {
      d.fail(e);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-4">
      <nav aria-label="Setup progress">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {WIZARD_STEPS.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? 'font-semibold text-cozy' : i < idx ? 'text-ink-100' : 'text-ink-300'}>
              {i + 1}. {STEP_TITLES[s]}
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="step-title" className="min-h-0 flex-1 space-y-3 overflow-auto">
        <h1 id="step-title" tabIndex={-1} className="text-xl font-semibold">
          {STEP_TITLES[step]}
        </h1>

        {step === 'welcome' && (
          <div className="space-y-2 text-sm">
            <p>tagconn shows your Claude Code sessions as characters in a small office. This wizard checks your system, installs the hooks that report sessions, and starts the services.</p>
            <ul className="list-inside list-disc text-ink-300">
              <li>No API key is used. Your own Claude Code login does the work.</li>
              <li>Everything runs on this computer (127.0.0.1).</li>
              <li>Every change to your files can be undone from the app.</li>
            </ul>
          </div>
        )}

        {step === 'check' && (
          <div className="space-y-3">
            {d.checks ? (
              <>
                <p role="status" className="text-sm text-ink-300">
                  {(() => {
                    const s = summarizeChecks(d.checks);
                    return `${s.ok} ok, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.fail} failed.`;
                  })()}
                  {blockingChecks(d.checks).length > 0 && ' Fix the required failures to continue.'}
                </p>
                <ul className="space-y-2">
                  {d.checks.map((c) => (
                    <CheckRow key={c.id} check={c} d={d} gotoHooks={() => setStep('hooks')} />
                  ))}
                </ul>
              </>
            ) : (
              <p role="status" className="text-sm text-ink-300">
                {d.checking ? 'Checking your system' : 'No results yet.'}
              </p>
            )}
            <Button onClick={() => void d.recheck()} disabled={d.checking}>
              {d.checking ? 'Checking' : 'Re-check'}
            </Button>
          </div>
        )}

        {step === 'folders' && config && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-300">Quests and the Receptionist may only work inside these folders. You can change this later.</p>
            {config.allowedProjectDirs.length === 0 ? (
              <p className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-300">No folders yet. Without one, the runner refuses to start quests.</p>
            ) : (
              <ul className="space-y-1">
                {config.allowedProjectDirs.map((dir) => (
                  <li key={dir} className="flex items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5">
                    <span className="break-all font-pixel text-xs">{dir}</span>
                    <Button variant="ghost" aria-label={`Remove ${dir}`} onClick={() => void d.saveConfig({ allowedProjectDirs: removeFolder(config.allowedProjectDirs, dir) })}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button onClick={() => void addDir()}>Add folder</Button>
            <div className="border-t border-ink-700 pt-3">
              <Toggle
                label="Write a small README into repos that use tagconn"
                hint="Adds .tagconn/README.md so teammates know what the folder is. Off by default; you can change it later."
                checked={config.attributionReadme}
                onChange={(v) => void d.saveConfig({ attributionReadme: v })}
              />
            </div>
          </div>
        )}

        {step === 'hooks' && (
          <div className="space-y-3 text-sm">
            <p>Hooks let Claude Code tell tagconn what sessions are doing. Installing will change these files:</p>
            <ul className="space-y-1.5 rounded-md border border-ink-700 bg-ink-850 p-3 text-xs">
              <li>
                <span className="font-semibold">Edits</span> <span className="break-all font-pixel">{settingsPath}</span>: adds tagconn hook entries. Other settings are kept.
              </li>
              <li>
                <span className="font-semibold">Backup</span>: a copy is saved next to it as <span className="break-all font-pixel">settings.json.tagconn-backup-&lt;time&gt;</span> before anything is written. The result below shows the exact path.
              </li>
              <li>
                <span className="font-semibold">Writes</span> a hook script and a private token file in <span className="break-all font-pixel">{d.info?.paths.config ?? 'the tagconn config folder'}</span>, and the tagconn staff roles and skills under <span className="break-all font-pixel">{d.info?.paths.claudeDir ?? '~/.claude'}</span>.
              </li>
              <li>If a write fails, the backup is restored automatically. "Uninstall hooks" in the control panel undoes everything.</li>
            </ul>
            {d.installResult ? (
              <div role="status" className="rounded-md border border-emerald-500/50 bg-emerald-950 p-3 text-xs text-emerald-50">
                <p className="font-semibold">Hooks installed.</p>
                <p className="mt-1">Changed:</p>
                <ul className="list-inside list-disc break-all font-pixel">
                  {d.installResult.changed.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <p className="mt-1 break-all">Backup: <span className="font-pixel">{d.installResult.backup ?? 'none (there was no settings.json yet)'}</span></p>
              </div>
            ) : d.checks?.find((c) => c.id === 'hooks')?.status === 'ok' ? (
              <p role="status" className="text-emerald-300">Hooks are already installed.</p>
            ) : null}
            <Button variant="primary" onClick={() => void d.install()} disabled={d.busy.has('install')}>
              {d.busy.has('install') ? 'Installing' : d.installResult ? 'Install again' : 'Install hooks'}
            </Button>
          </div>
        )}

        {step === 'start' && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-300">Start the {runMode === 'docker' ? SERVICE_LABELS.docker : SERVICE_LABELS.server} to continue. The runner is optional and only needed for browser quests.</p>
            <ul className="space-y-2">
              {visibleServices(runMode).map((id) => (
                <ServiceRow key={id} id={id} status={d.state.services[id]} busy={(k) => d.busy.has(k)} onOp={(sid, op) => void d.service(sid, op)} />
              ))}
            </ul>
            <Button variant="primary" onClick={() => void d.startAll()}>
              Start all
            </Button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3 text-sm">
            <p>The server is running. The office opens in its own window, already paired with this app.</p>
            <div className="flex gap-2">
              <Button variant="primary" data-autofocus onClick={() => void d.openOffice(false)} disabled={d.busy.has('office')}>
                Open office
              </Button>
              <Button onClick={() => void d.openOffice(true)}>Open in browser</Button>
            </div>
          </div>
        )}
      </section>

      <footer className="flex items-center justify-between border-t border-ink-700 pt-3">
        <Button variant="ghost" onClick={() => setStep(prevStep(step))} disabled={idx === 0 || step === 'done'}>
          Back
        </Button>
        {step === 'done' ? (
          <Button variant="primary" onClick={onFinish}>
            Go to control panel
          </Button>
        ) : (
          <Button variant="primary" disabled={!ok} onClick={() => setStep(nextStep(step))}>
            {step === 'welcome' ? 'Start setup' : 'Next'}
          </Button>
        )}
      </footer>
    </div>
  );
}
