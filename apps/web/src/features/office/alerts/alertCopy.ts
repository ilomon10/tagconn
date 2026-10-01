// M13 alerts: the words (docs/design/office-life.md 3.3.3). Pure.
import { clipDisplayText } from '../../../lib/displayText';
import type { AlertItem } from './types';

const MAX_NAME = 40;
const MAX_TOOL = 40;
const MAX_DESCRIPTION = 140;

export interface AlertCopy {
  icon: string;
  title: string;
  body?: string;
}

type Style = 'modern' | 'guild' | 'rift';
const CREW: Record<Style, string> = { modern: 'teammates', guild: 'heroes', rift: 'crew' };

export function alertCopy(item: AlertItem, style: Style, names: readonly string[], description?: string): AlertCopy {
  const n = item.agentIds.length;
  const clipped = clipDisplayText(description, MAX_DESCRIPTION);
  const who = clipDisplayText(names[0], MAX_NAME) || 'Someone';
  if (n > 1) {
    const crew = CREW[style];
    if (item.kind === 'ask') return { icon: '❓', title: `${n} ${crew} need you` };
    if (item.kind === 'failure') return { icon: '💥', title: `${n} ${crew} stumbled` };
    return { icon: '⚔', title: `${n} quests complete!` };
  }
  if (item.kind === 'ask') return { icon: '❓', title: `${who} asks for you` };
  if (item.kind === 'failure') return { icon: '💥', title: `${who} stumbled: ${clipDisplayText(item.toolName, MAX_TOOL) || 'a tool'} failed` };
  return { icon: '⚔', title: 'Quest complete!', body: clipped ? `${who}: ${clipped}` : who };
}
