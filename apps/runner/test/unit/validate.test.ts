import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_QUEST_ALWAYS_DENY, DEFAULT_QUEST_MAX_ALLOWED_TOOLS } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFingerprint, recordSession, type Ledger } from '../../src/ledger.js';
import { validateQuestStart } from '../../src/validate.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

const cfg = {
  allowedProjectDirs: [] as string[],
  trustOverrideDirs: [] as string[],
  maxPermissionMode: 'acceptEdits' as const,
  allowBypassPermissions: false,
  questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
  processIsolation: 'auto' as const,
  stateDir: '/state',
};
const caps = { permissionModes: ['acceptEdits', 'plan'], systemdScope: false };

describe('validateQuestStart', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  function setup() {
    const root = mkSandbox();
    sandboxes.push(root);
    const project = join(root, 'proj');
    mkdirSync(project, { recursive: true });
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    return { root, project, claudeJson };
  }

  it('accepts a trusted dir within allowedProjectDirs with allowed tools', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Edit(./**)'], disallowedTools: [] },
      { ...cfg, allowedProjectDirs: [project] },
      caps,
      claudeJson,
      ledger,
    );
    expect(result.ok).toBe(true);
  });

  it('R2 (SC5 re-review): the stateDir deny uses a DOUBLED leading slash (`//...`), not a single one', () => {
    // A single leading `/` in a Claude Code rule glob is relative to the settings source, not the
    // filesystem root — `Edit(/state/**)` would silently match nothing. The deny must read
    // `Edit(//state/**)` so it actually matches the absolute stateDir.
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read'], disallowedTools: [] },
      { ...cfg, allowedProjectDirs: [project], stateDir: '/state' },
      caps,
      claudeJson,
      ledger,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        expect(result.disallowedTools).toContain(`${tool}(//state/**)`);
        expect(result.disallowedTools).not.toContain(`${tool}(/state/**)`);
      }
    }
  });

  it('dir_not_allowed for a dir outside allowedProjectDirs', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const result = validateQuestStart({ projectDir: project, permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [] }, { ...cfg, allowedProjectDirs: ['/somewhere/else'] }, caps, claudeJson, ledger);
    expect(result).toEqual({ ok: false, failure: 'dir_not_allowed' });
  });

  it('dir_not_trusted for an allowed but untrusted dir (fresh -p run per V14)', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const project = join(root, 'proj');
    mkdirSync(project, { recursive: true });
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
    const ledger: Ledger = new Map();
    const result = validateQuestStart({ projectDir: project, permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [] }, { ...cfg, allowedProjectDirs: [project] }, caps, claudeJson, ledger);
    expect(result).toEqual({ ok: false, failure: 'dir_not_trusted' });
  });

  it('mode_not_allowed propagates from the tool policy step', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'bypassPermissions', allowedTools: [], disallowedTools: [] },
      { ...cfg, allowedProjectDirs: [project] },
      caps,
      claudeJson,
      ledger,
    );
    expect(result).toEqual({ ok: false, failure: 'mode_not_allowed' });
  });

  it('resume_not_allowed for an unknown session id', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read'], disallowedTools: [], resumeSessionId: 'unknown-sess' },
      { ...cfg, allowedProjectDirs: [project] },
      caps,
      claudeJson,
      ledger,
    );
    expect(result).toEqual({ ok: false, failure: 'resume_not_allowed' });
  });

  it('resume succeeds for a recorded session with the identical fingerprint', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const fp = computeFingerprint({ tools: ['Read'], mode: 'acceptEdits', restricted: false, safeMode: false });
    recordSession(ledger, 'sess-1', fp, 100);
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read'], disallowedTools: [], resumeSessionId: 'sess-1' },
      { ...cfg, allowedProjectDirs: [project] },
      caps,
      claudeJson,
      ledger,
    );
    expect(result.ok).toBe(true);
  });

  it('V15 fail-closed: resume refused when the requested tools differ from what was recorded', () => {
    const { project, claudeJson } = setup();
    const ledger: Ledger = new Map();
    const fp = computeFingerprint({ tools: ['Read'], mode: 'acceptEdits', restricted: false, safeMode: false });
    recordSession(ledger, 'sess-1', fp, 100);
    const result = validateQuestStart(
      { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Edit(./**)'], disallowedTools: [], resumeSessionId: 'sess-1' },
      { ...cfg, allowedProjectDirs: [project] },
      caps,
      claudeJson,
      ledger,
    );
    expect(result).toEqual({ ok: false, failure: 'resume_not_allowed' });
  });
});
