import { z } from 'zod';
import { ZONES } from './domain.js';

export const RoleSchema = z.object({
  /** Slug; also the Claude subagent `name` and file name `~/.claude/agents/<name>.md`. */
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  title: z.string().min(1),
  /** Tells Claude when to delegate to this role (subagent frontmatter `description`). */
  description: z.string().min(1),
  model: z.enum(['inherit', 'opus', 'sonnet', 'haiku']).default('inherit'),
  /** null = all tools. */
  tools: z.array(z.string()).nullable().default(null),
  prompt: z.string().min(1),
  zone: z.enum(ZONES).default('desks'),
  /** Hex color for badge + shirt tint. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f8cff'),
  /** Sprite variant index in the character sheet. */
  sprite: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  /** Synced to ~/.claude/agents when true. The main session role "pm" is not a subagent. */
  syncToClaude: z.boolean().default(true),
  builtin: z.boolean().default(false),
});
export type Role = z.infer<typeof RoleSchema>;
export type RoleInput = z.input<typeof RoleSchema>;

/** Role used for the main Claude session (not a subagent file). */
export const MAIN_ROLE = 'pm';
