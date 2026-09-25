import { basename } from 'node:path';
import type { Activity, ActivityRule, Zone } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';

export interface ActivityMatch {
  activity: Activity;
  /** Undefined when the rule leaves the zone to the agent's role. */
  zone?: Zone;
  bubble: string;
}

interface CompiledRule {
  rule: ActivityRule;
  tool: RegExp;
  input?: RegExp;
}

// Keyed by the rules array: settings updates replace the array, so a change recompiles automatically.
const compiledCache = new WeakMap<readonly ActivityRule[], CompiledRule[]>();

function compile(rules: readonly ActivityRule[]): CompiledRule[] {
  let compiled = compiledCache.get(rules);
  if (!compiled) {
    compiled = rules.flatMap((rule) => {
      try {
        return [{ rule, tool: new RegExp(`^(?:${rule.tool})$`), input: rule.input ? new RegExp(rule.input) : undefined }];
      } catch {
        return []; // invalid regexes are rejected by SettingsService; skip defensively
      }
    });
    compiledCache.set(rules, compiled);
  }
  return compiled;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function templateVars(toolName: string, input: Record<string, unknown>): Record<string, string> {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const command = str(input.command)?.replace(/\s+/g, ' ').trim();
  return {
    tool: toolName,
    file: file ? basename(file) : '',
    command: command ? (command.length > 40 ? `${command.slice(0, 40)}…` : command) : '',
    description: str(input.description) ?? '',
    pattern: str(input.pattern) ?? str(input.query) ?? str(input.url) ?? '',
  };
}

export function renderBubble(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '')
    .replace(/[\s:$]+$/, '')
    .trim();
}

/** First matching rule wins; `tool` is anchored, `input` is searched in JSON.stringify(tool_input). */
export function mapRule(toolName: string, toolInput: unknown, rules: readonly ActivityRule[]): ActivityMatch {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  let inputJson: string | undefined;
  for (const { rule, tool, input: inputRe } of compile(rules)) {
    if (!tool.test(toolName)) continue;
    if (inputRe) {
      inputJson ??= JSON.stringify(toolInput ?? {});
      if (!inputRe.test(inputJson)) continue;
    }
    const bubble = rule.bubble ? renderBubble(rule.bubble, templateVars(toolName, input)) : '';
    return { activity: rule.activity, zone: rule.zone, bubble: bubble || toolName };
  }
  return { activity: 'thinking', bubble: toolName };
}

export class ActivityService {
  constructor(private readonly deps: Deps<'settings'>) {}

  /** Maps a tool call using the live rules; a rule without a zone falls back to `roleZone`. */
  map(toolName: string, toolInput: unknown, roleZone: Zone): ActivityMatch & { zone: Zone } {
    const match = mapRule(toolName, toolInput, this.deps.settings.get().activity.rules);
    return { ...match, zone: match.zone ?? roleZone };
  }
}
