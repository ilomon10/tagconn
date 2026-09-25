// L5 Receptionist watchdog (docs/design/runner-and-helpdesk.md §4.4): `init.tools` must EQUAL the
// `--tools` set exactly, and `init.mcpServers` must be empty. Any `mcp__*` tool, or any `tool_use`
// outside the set, kills the run with `policy_violation`. This is the layer that catches a CLI that
// silently ignored --tools or --strict-mcp-config (SC3 V1 confirmed exact equality on 2.1.282).

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

/** Checked once, against the run's `init` event. Returns a violation message, or undefined if clean. */
export function checkInitWatchdog(init: { tools: readonly string[]; mcpServers: readonly string[] }, expectedToolSet: readonly string[]): string | undefined {
  if (!sortedEqual(init.tools, expectedToolSet)) {
    return `init.tools [${[...init.tools].sort().join(',')}] != expected [--tools=${[...expectedToolSet].sort().join(',')}]`;
  }
  if (init.mcpServers.length > 0) {
    return `init.mcpServers not empty: [${init.mcpServers.join(',')}]`;
  }
  return undefined;
}

/** Checked on every `tool_use` event for the lifetime of the run. */
export function checkToolUseWatchdog(toolName: string, expectedToolSet: readonly string[]): string | undefined {
  if (toolName.startsWith('mcp__')) return `tool_use for an MCP tool "${toolName}" (mcpServers must be empty)`;
  if (!expectedToolSet.includes(toolName)) return `tool_use for "${toolName}" is outside the --tools set`;
  return undefined;
}
