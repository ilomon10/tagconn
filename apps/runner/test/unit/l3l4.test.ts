import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEST_ALWAYS_DENY, DESKTOP_APP_IDENTIFIER, QUEST_DENY_READ_GLOBS, RECEPTIONIST_DENY_READ_GLOBS } from '@tagconn/shared';
import { makePlatform, parseCmdShim } from '../../src/platform.js';

describe('L3: desktop webview profile dirs (POSIX)', () => {
  it('the identifier matches tauri.conf.json', () => {
    const conf = JSON.parse(readFileSync(resolve(__dirname, '../../../desktop/src-tauri/tauri.conf.json'), 'utf8')) as { identifier: string };
    expect(DESKTOP_APP_IDENTIFIER).toBe(conf.identifier);
  });
  it('quests and the Receptionist are denied Read, quests also every edit tool', () => {
    for (const base of ['~/.local/share', '~/.config']) {
      const g = `${base}/${DESKTOP_APP_IDENTIFIER}/**`;
      expect(QUEST_DENY_READ_GLOBS).toContain(g);
      expect(RECEPTIONIST_DENY_READ_GLOBS).toContain(g);
      for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(DEFAULT_QUEST_ALWAYS_DENY).toContain(`${tool}(${g})`);
    }
  });
});

// Keep in sync with packages/setup/test/checks.test.ts (SHIM_CASES): the two parsers must accept the same shims.
const DIR = 'C:\\npm';
const CLI = `${DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const EXE = `${DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const own = 'C:\\own\\node.exe';
const line = (t: string) => `"%_prog%"  "%dp0%\\${t}" %*`;
const SHIM_CASES: Array<{ name: string; text: string; files: string[]; expected: { cmd: string; args: string[] } | null }> = [
  { name: 'npm cli.js, no local node -> own node', text: line('node_modules\\@anthropic-ai\\claude-code\\cli.js'), files: [CLI], expected: { cmd: own, args: [CLI] } },
  { name: 'local node.exe wins', text: line('node_modules\\@anthropic-ai\\claude-code\\cli.js'), files: [CLI, `${DIR}\\node.exe`], expected: { cmd: `${DIR}\\node.exe`, args: [CLI] } },
  { name: 'native bin exe', text: line('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'), files: [EXE], expected: { cmd: EXE, args: [] } },
  { name: 'case-insensitive and forward slashes', text: line('Node_Modules/@Anthropic-AI/Claude-Code/CLI.JS'), files: [`${DIR}\\Node_Modules\\@Anthropic-AI\\Claude-Code\\CLI.JS`], expected: { cmd: own, args: [`${DIR}\\Node_Modules\\@Anthropic-AI\\Claude-Code\\CLI.JS`] } },
  { name: 'the LAST target wins (evil last)', text: `${line('node_modules\\@anthropic-ai\\claude-code\\cli.js')}\r\n${line('evil.exe')}`, files: [CLI, `${DIR}\\evil.exe`], expected: null },
  { name: 'the LAST target wins (good last)', text: `${line('evil.exe')}\r\n${line('node_modules\\@anthropic-ai\\claude-code\\cli.js')}`, files: [CLI, `${DIR}\\evil.exe`], expected: { cmd: own, args: [CLI] } },
  { name: '%~dp0% form is not accepted', text: '"%~dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js"', files: [CLI], expected: null },
  { name: 'target file missing', text: line('node_modules\\@anthropic-ai\\claude-code\\cli.js'), files: [], expected: null },
  { name: 'dotdot', text: line('node_modules\\..\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), files: [CLI], expected: null },
  { name: 'other package file', text: line('node_modules\\@anthropic-ai\\claude-code\\evil.js'), files: [`${DIR}\\node_modules\\@anthropic-ai\\claude-code\\evil.js`], expected: null },
  { name: 'nested claude.exe not at the allowed spot', text: line('node_modules\\@anthropic-ai\\claude-code\\x\\claude.exe'), files: [`${DIR}\\node_modules\\@anthropic-ai\\claude-code\\x\\claude.exe`], expected: null },
  { name: 'no target', text: '@echo hi & calc.exe', files: [], expected: null },
];

describe('N16: parseCmdShim shared fixtures', () => {
  for (const c of SHIM_CASES) {
    it(c.name, () => {
      const shim = `${DIR}\\claude.cmd`;
      const p = makePlatform({
        os: 'win32',
        env: {},
        exists: (x) => c.files.includes(x),
        realpath: (x) => x,
        readText: () => c.text,
        nodeExecPath: own,
      });
      const r = parseCmdShim(shim, p);
      expect(r ? { cmd: r.command, args: r.args } : null).toEqual(c.expected);
    });
  }
});
