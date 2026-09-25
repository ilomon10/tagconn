import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Role, RoleSchema } from '@tagconn/shared';
import matter from 'gray-matter';

/**
 * OFFICE_TEMPLATES_DIR (the agent-templates root containing `roles/`, or the roles folder itself),
 * else the `roles/` folder of the @tagconn/agent-templates package.
 */
export function resolveTemplatesDir(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.OFFICE_TEMPLATES_DIR) {
    const nested = join(env.OFFICE_TEMPLATES_DIR, 'roles');
    return existsSync(nested) ? nested : env.OFFICE_TEMPLATES_DIR;
  }
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve('@tagconn/agent-templates/package.json')), 'roles');
    return existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

const titleCase = (name: string) =>
  name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

function parseTools(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

/** Role markdown: Claude frontmatter (name, description, tools, model) + office-* fields; body = prompt. */
export function parseRoleMarkdown(source: string, fallbackName: string): Role {
  const { data, content } = matter(source);
  const fm = data as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name : fallbackName;
  const model = ['inherit', 'opus', 'sonnet', 'haiku'].includes(String(fm.model)) ? fm.model : 'inherit';
  return RoleSchema.parse({
    name,
    title: fm['office-title'] ?? fm.title ?? titleCase(name),
    description: fm.description,
    model,
    tools: parseTools(fm.tools),
    prompt: content.trim(),
    zone: fm['office-zone'],
    color: fm['office-color'],
    sprite: fm['office-sprite'] === undefined ? undefined : Number(fm['office-sprite']),
    enabled: fm['office-enabled'] ?? true,
    syncToClaude: fm['office-sync'] ?? true,
    builtin: true,
  });
}

export function loadTemplates(dir: string, onError: (file: string, err: unknown) => void = () => {}): Role[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      try {
        return [parseRoleMarkdown(readFileSync(join(dir, file), 'utf8'), file.replace(/\.md$/, ''))];
      } catch (err) {
        onError(file, err);
        return [];
      }
    });
}
