import type { Activity } from '@tagconn/shared';
import type { ThemeDefinition } from './types';

/**
 * Bubble rule (docs/design/guild-hall.md section 3): the server bubble stays the source of truth
 * ("Editing auth.ts"). The theme prefixes or replaces only the generic templates: it uses the
 * plain verb when the bubble is empty or equals the tool name, and otherwise prefixes the bubble
 * with the verb ("Inscribing runes · auth.ts"). A theme with no verb for the activity (modern)
 * leaves the bubble untouched.
 */
export function themedBubble(
  theme: Pick<ThemeDefinition, 'activityVerbs'>,
  activity: Activity,
  bubble: string | undefined,
  tool?: string,
): string {
  const verb = theme.activityVerbs[activity];
  const text = (bubble ?? '').trim();
  if (!verb) return text;
  if (!text || text === tool) return verb;
  return `${verb} · ${text}`;
}
