// M13 alerts: the words (docs/design/office-life.md 3.3.3). Pure.
import type { AlertItem } from './types';

export interface AlertCopy {
  icon: string;
  title: string;
  body?: string;
}

type Style = 'modern' | 'guild' | 'rift';
const CREW: Record<Style, string> = { modern: 'teammates', guild: 'heroes', rift: 'crew' };

export function alertCopy(item: AlertItem, style: Style, names: readonly string[], description?: string): AlertCopy {
  const n = item.agentIds.length;
  const who = names[0] ?? 'Someone';
  if (n > 1) {
    const crew = CREW[style];
    if (item.kind === 'ask') return { icon: '❓', title: `${n} ${crew} need you` };
    if (item.kind === 'failure') return { icon: '💥', title: `${n} ${crew} stumbled` };
    return { icon: '⚔', title: `${n} quests complete!` };
  }
  if (item.kind === 'ask') return { icon: '❓', title: `${who} asks for you` };
  if (item.kind === 'failure') return { icon: '💥', title: `${who} stumbled: ${item.toolName ?? 'a tool'} failed` };
  return { icon: '⚔', title: 'Quest complete!', body: description ? `${who}: ${description}` : who };
}
