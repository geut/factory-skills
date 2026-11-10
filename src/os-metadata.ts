// Files an operating system writes beside a person's files, such as macOS
// Finder's `.DS_Store`. A host's file browser can write them into a mounted
// repository at any time, so the factory never counts an untracked one as
// anyone's change.
const NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// Whether `file`, a path at any depth with `/` or the platform separator, is
// OS metadata: one of those names, or an AppleDouble `._<name>` file.
export function isOsMetadata(file: string): boolean {
  const name = file.split(/[/\\]/).at(-1) ?? '';
  return NAMES.has(name) || name.startsWith('._');
}
