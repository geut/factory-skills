import path from 'node:path';

// Whether `target` is `root` or below it, by path alone.
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
