// OS-level process lifecycle for one run (docs/design/runner-and-helpdesk.md §2.5 "Stop, timeout or
// shutdown"): spawn, stream stdout/stderr into RunEvents, and kill semantics per wrapper kind.
//
//  - systemd-scope: `systemctl --user stop <unit>` is a cgroup kill, reaching setsid'd grandchildren
//    (V13: a plain process-group SIGTERM does not).
//  - bwrap: SIGTERM/SIGKILL the bwrap process itself. `--unshare-pid --die-with-parent` makes bwrap
//    pid 1 of its own PID namespace, so killing it takes the whole namespace down with it.
//  - plain (no wrapper): SIGTERM the process group, then SIGKILL after killGraceMs. Only quests that
//    cannot execute commands are ever spawned this way (toolPolicy.ts already refused the rest).

import { spawn, spawnSync } from 'node:child_process';
import type { RunEvent } from '@tagconn/shared';
import { createLineSplitter, mapClaudeLine, stderrNotice } from './streamParser.js';

export type SpawnWrapper = 'plain' | 'systemd-scope' | 'bwrap';

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  wrapper: SpawnWrapper;
  /** systemd-scope only: the transient unit name, used by `systemctl --user stop`. */
  scopeUnitName?: string;
  /** Sent on stdin then the stream is closed (V9 stdin prompt delivery). Omit for the `-- <prompt>` fallback. */
  stdin?: string;
}

export interface RunProcessLimits {
  previewChars: number;
  maxStderrLines: number;
  maxLineBytes: number;
}

export interface RunProcessCallbacks {
  /** One mapped RunEvent from stdout, or a synthetic notice (overflow, stderr, wrapper). */
  onEvent(event: RunEvent): void;
  onExit(info: { exitCode: number | null; signal: NodeJS.Signals | null }): void;
  /** Malformed JSON lines are reported, never crash the parser. */
  onParseError?(line: string): void;
}

export interface RunProcessHandle {
  pid: number | undefined;
  stop(): void;
}

/** Spawns `spec` and wires stdout/stderr parsing with bounded buffers; returns a stop()-able handle. */
export function spawnRun(spec: SpawnSpec, limits: RunProcessLimits, killGraceMs: number, callbacks: RunProcessCallbacks): RunProcessHandle {
  const detachForGroupKill = spec.wrapper === 'plain';
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: detachForGroupKill,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (spec.stdin !== undefined) {
    child.stdin.end(spec.stdin);
  } else {
    child.stdin.end();
  }

  const outSplitter = createLineSplitter(limits.maxLineBytes);
  const errSplitter = createLineSplitter(limits.maxLineBytes);
  let stderrLinesSeen = 0;
  let stderrCapNoticeSent = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const { lines, overflowed } = outSplitter.push(chunk);
    if (overflowed) callbacks.onEvent(stderrNotice('a stdout line exceeded maxLineBytes and was dropped'));
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        callbacks.onParseError?.(line);
        continue;
      }
      for (const event of mapClaudeLine(parsed, limits.previewChars)) callbacks.onEvent(event);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const { lines } = errSplitter.push(chunk);
    for (const line of lines) {
      stderrLinesSeen += 1;
      if (stderrLinesSeen <= limits.maxStderrLines) {
        callbacks.onEvent(stderrNotice(line));
      } else if (!stderrCapNoticeSent) {
        stderrCapNoticeSent = true;
        callbacks.onEvent({ kind: 'notice', level: 'warn', message: `stderr output capped at ${limits.maxStderrLines} lines` });
      }
    }
  });

  child.on('exit', (exitCode, signal) => {
    const outFlush = outSplitter.flush();
    for (const line of outFlush.lines) {
      try {
        for (const event of mapClaudeLine(JSON.parse(line), limits.previewChars)) callbacks.onEvent(event);
      } catch {
        callbacks.onParseError?.(line);
      }
    }
    callbacks.onExit({ exitCode, signal });
  });

  function stop(): void {
    if (spec.wrapper === 'systemd-scope' && spec.scopeUnitName) {
      spawnSync('systemctl', ['--user', 'stop', spec.scopeUnitName], { stdio: 'ignore' });
      return;
    }
    const target = detachForGroupKill && child.pid ? -child.pid : child.pid;
    if (target === undefined) return;
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, killGraceMs);
    timer.unref();
  }

  return { pid: child.pid, stop };
}

/** Deterministic transient scope unit name, so `stop()` can find it later without tracking state elsewhere. */
export function questScopeUnitName(runId: string): string {
  return `tagconn-quest-${runId}`;
}
