/** Folders list helpers for the runner folders step. */
export function addFolder(dirs: string[], dir: string): string[] {
  const d = dir.trim();
  if (!d || dirs.includes(d)) return dirs;
  return [...dirs, d];
}
export function removeFolder(dirs: string[], dir: string): string[] {
  return dirs.filter((d) => d !== dir);
}
