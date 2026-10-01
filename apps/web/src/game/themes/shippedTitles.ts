/** The built-in roles' shipped titles (`packages/agent-templates/roles/*.md`). A role whose title still
 * equals this is "unedited", so a style may rename it (guild: "Guild Master"); an edited title wins. */
export const SHIPPED_ROLE_TITLES: Record<string, string> = {
  pm: 'Project Manager',
  analyst: 'Business Analyst',
  architect: 'Architect',
  developer: 'Developer',
  'qa-engineer': 'QA Engineer',
  'code-reviewer': 'Code Reviewer',
  'security-engineer': 'Security Engineer',
  'devops-engineer': 'DevOps Engineer',
  devops: 'DevOps Engineer',
  'tech-writer': 'Tech Writer',
};
