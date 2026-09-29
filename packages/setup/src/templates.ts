import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { touch, type SetupContext } from './context.ts';
import { ensureDir } from './fsutil.ts';
import { isValidRoleName, ROLE_NAME_RE } from './validate.ts';

export const AGENT_MARKER = '<!-- managed-by: tagconn -->';
export const SKILL_MARKER = '.tagconn-managed';

// Frontmatter parsing (hand-written; no deps).

export interface ParsedTemplate {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedTemplate {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  const frontmatter: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter, body };
}

/** True when a frontmatter boolean-ish value spells out "false". */
export function isExplicitFalse(value: string | undefined): boolean {
  return value === 'false' || value === 'no' || value === '0';
}

// Role subagents.

const CLAUDE_FRONTMATTER_KEYS = ['name', 'description', 'tools', 'model'];

/**
 * Renders a role template's frontmatter + body into a Claude Code agent
 * file: keeps only the frontmatter keys Claude Code understands (name,
 * description, tools, model - drops tagconn's office-* keys), re-quotes
 * values that need it, and appends the managed-by marker.
 */
export function buildAgentFile(frontmatter: Record<string, string>, body: string): string {
  const outFrontmatterLines = CLAUDE_FRONTMATTER_KEYS.filter((k) => frontmatter[k] !== undefined).map((k) => {
    const v = frontmatter[k] as string;
    // Re-quote values that need it (description usually does).
    const needsQuote = /:/.test(v) && !(v.startsWith('"') || v.startsWith("'"));
    return needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`;
  });
  return `---\n${outFrontmatterLines.join('\n')}\n---\n${body.replace(/\s*$/, '')}\n\n${AGENT_MARKER}\n`;
}

export function installAgents(ctx: SetupContext, claudeDir: string): void {
  const rolesDir = ctx.resources.rolesDir;
  const agentsDir = join(claudeDir, 'agents');
  if (!existsSync(rolesDir)) {
    ctx.log('  no role templates found, skipping');
    return;
  }
  ensureDir(ctx, agentsDir);
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.md'));
  let written = 0;
  let skippedDisabled = 0;
  let skippedUnmanaged = 0;
  let skippedInvalidName = 0;
  for (const file of files) {
    const src = join(rolesDir, file);
    const raw = readFileSync(src, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (isExplicitFalse(frontmatter['office-enabled']) || isExplicitFalse(frontmatter['office-sync'])) {
      skippedDisabled++;
      continue;
    }
    const name = frontmatter['name'] || file.replace(/\.md$/, '');
    if (!isValidRoleName(name)) {
      ctx.warn(`  WARNING: skipping ${file} - invalid role name ${JSON.stringify(name)} (must match ${ROLE_NAME_RE})`);
      skippedInvalidName++;
      continue;
    }
    const destPath = join(agentsDir, `${name}.md`);
    if (existsSync(destPath)) {
      const existing = readFileSync(destPath, 'utf8');
      if (!existing.includes(AGENT_MARKER)) {
        ctx.warn(`  WARNING: skipping ${destPath} - exists and is not managed by tagconn`);
        skippedUnmanaged++;
        continue;
      }
    }
    const out = buildAgentFile(frontmatter, body);
    if (ctx.dryRun) {
      ctx.log(`  [dry-run] would write ${destPath}`);
    } else {
      writeFileSync(destPath, out, 'utf8');
      touch(ctx, destPath);
    }
    written++;
  }
  ctx.log(
    `  agents: ${written} written, ${skippedDisabled} disabled by template, ${skippedUnmanaged} skipped (unmanaged file exists), ${skippedInvalidName} skipped (invalid name)`,
  );
}

export function uninstallAgents(ctx: SetupContext, claudeDir: string): void {
  const agentsDir = join(claudeDir, 'agents');
  if (!existsSync(agentsDir)) return;
  let removed = 0;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(agentsDir, file);
    const content = readFileSync(path, 'utf8');
    if (content.includes(AGENT_MARKER)) {
      if (ctx.dryRun) {
        ctx.log(`  [dry-run] would remove ${path}`);
      } else {
        rmSync(path);
        touch(ctx, path);
      }
      removed++;
    }
  }
  ctx.log(`  agents: removed ${removed} managed file(s)`);
}

// Skills.

export function installSkills(ctx: SetupContext, claudeDir: string): void {
  const skillsSrcDir = ctx.resources.skillsDir;
  const skillsDestDir = join(claudeDir, 'skills');
  if (!existsSync(skillsSrcDir)) {
    ctx.log('  no skill templates found, skipping');
    return;
  }
  ensureDir(ctx, skillsDestDir);
  const skills = readdirSync(skillsSrcDir).filter((f) => statSync(join(skillsSrcDir, f)).isDirectory());
  let written = 0;
  let skippedUnmanaged = 0;
  for (const skill of skills) {
    const src = join(skillsSrcDir, skill);
    const dest = join(skillsDestDir, skill);
    if (existsSync(dest) && !existsSync(join(dest, SKILL_MARKER))) {
      ctx.warn(`  WARNING: skipping ${dest} - exists and is not managed by tagconn`);
      skippedUnmanaged++;
      continue;
    }
    if (ctx.dryRun) {
      ctx.log(`  [dry-run] would copy ${src} -> ${dest}`);
    } else {
      cpSync(src, dest, { recursive: true });
      writeFileSync(join(dest, SKILL_MARKER), '', 'utf8');
      touch(ctx, dest);
    }
    written++;
  }
  ctx.log(`  skills: ${written} written, ${skippedUnmanaged} skipped (unmanaged dir exists)`);
}

export function uninstallSkills(ctx: SetupContext, claudeDir: string): void {
  const skillsDestDir = join(claudeDir, 'skills');
  if (!existsSync(skillsDestDir)) return;
  let removed = 0;
  for (const entry of readdirSync(skillsDestDir)) {
    const dest = join(skillsDestDir, entry);
    if (!statSync(dest).isDirectory()) continue;
    if (existsSync(join(dest, SKILL_MARKER))) {
      if (ctx.dryRun) {
        ctx.log(`  [dry-run] would remove ${dest}`);
      } else {
        rmSync(dest, { recursive: true, force: true });
        touch(ctx, dest);
      }
      removed++;
    }
  }
  ctx.log(`  skills: removed ${removed} managed dir(s)`);
}
