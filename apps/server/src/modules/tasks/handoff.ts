import type { TaskStatus } from '@tagconn/shared';

export interface Handoff {
  status?: string;
  fields: Record<string, string>;
}

/** Parses the last ```handoff fenced block (`key: value` lines) in a subagent's final message. */
export function parseHandoff(message: string | undefined): Handoff | undefined {
  if (!message) return undefined;
  const blocks = [...message.matchAll(/```handoff[^\n]*\n([\s\S]*?)```/g)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return undefined;
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m?.[1]) fields[m[1].toLowerCase()] = m[2] ?? '';
  }
  return { status: fields.status?.toLowerCase(), fields };
}

/** Handoff status → task status; anything unknown or missing counts as done. */
export function taskStatusFromHandoff(h: Handoff | undefined): TaskStatus {
  switch (h?.status?.split(/[\s|,]/)[0]) {
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'review';
    default:
      return 'done';
  }
}
