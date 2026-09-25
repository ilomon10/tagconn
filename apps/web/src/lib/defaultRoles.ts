import type { Role } from '@tagconn/shared';

/**
 * Local copy of the builtin role templates (packages/agent-templates/roles) used before the
 * server answers `roles:list`, and as the whole role set in demo mode.
 */
const base = { model: 'inherit', tools: null, enabled: true, syncToClaude: true, builtin: true } as const;

export const DEFAULT_ROLES: Role[] = [
  { ...base, name: 'pm', title: 'Project Manager', description: 'Main-session orchestrator.', prompt: 'You are the PM of a small software house.', zone: 'pm-office', color: '#f5a623', sprite: 0, syncToClaude: false },
  { ...base, name: 'analyst', title: 'Business Analyst', description: 'Turns a request into user stories and acceptance criteria.', prompt: 'You are a business analyst.', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], zone: 'meeting-room', color: '#7ed321', sprite: 1 },
  { ...base, name: 'architect', title: 'Architect', description: 'Designs module boundaries and splits work.', prompt: 'You are a software architect.', model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Write', 'WebSearch'], zone: 'whiteboard', color: '#9013fe', sprite: 2 },
  { ...base, name: 'developer', title: 'Developer', description: 'Implements one scoped task.', prompt: 'You are a software developer.', model: 'sonnet', zone: 'desks', color: '#4a90e2', sprite: 3 },
  { ...base, name: 'qa-engineer', title: 'QA Engineer', description: 'Verifies acceptance criteria with tests.', prompt: 'You are a QA engineer.', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'], zone: 'qa-lab', color: '#50e3c2', sprite: 4 },
  { ...base, name: 'code-reviewer', title: 'Code Reviewer', description: 'Reviews diffs for correctness.', prompt: 'You are a code reviewer.', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash'], zone: 'review-booth', color: '#bd10e0', sprite: 5 },
  { ...base, name: 'security-engineer', title: 'Security Engineer', description: 'Threat-models and audits changes.', prompt: 'You are an application security engineer.', model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Bash'], zone: 'server-room', color: '#d0021b', sprite: 6 },
  { ...base, name: 'devops-engineer', title: 'DevOps Engineer', description: 'CI/CD, containers and infrastructure.', prompt: 'You are a DevOps engineer.', model: 'sonnet', zone: 'server-room', color: '#8b572a', sprite: 7, enabled: false },
  { ...base, name: 'tech-writer', title: 'Tech Writer', description: 'Writes README, API docs and changelogs.', prompt: 'You are a technical writer.', model: 'haiku', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], zone: 'library', color: '#417505', sprite: 8 },
];

export const FALLBACK_COLOR = '#8e8e9e';
