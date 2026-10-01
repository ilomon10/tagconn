// M13 alerts: the words (docs/design/office-life.md 3.3.3). Pure.
import { clipDisplayText } from '../../../lib/displayText';
import { encounterLine } from '../../battle/copy';
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
  if (item.kind === 'encounter' && item.encounter) {
    const name = clipDisplayText(item.encounter.name, MAX_NAME) || 'stranger';
    const title = style === 'guild' ? `A wild ${name} blocks the hall!` : style === 'rift' ? `Hostile ${name} detected!` : `A wild ${name} appeared!`;
    return { icon: '⚔', title, body: encounterLine(style, item.encounter.kind) };
  }
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
  if (item.kind === 'encounter') return { icon: '⚔', title: 'A wild stranger appeared!' };
  return { icon: '⚔', title: 'Quest complete!', body: clipped ? `${who}: ${clipped}` : who };
}
