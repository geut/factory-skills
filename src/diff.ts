import { sha256 } from './hash.ts';

// The files a git patch touches, read from its `diff --git a/<from> b/<to>`
// headers. collectWorkDiff asks git for the a/ and b/ prefixes, whatever the
// repository's diff config says.

export type DiffFile = { from: string; to: string };

const HEADER = 'diff --git ';

// An unchanged path's header is `a/P b/P`: split it at its middle, so a path
// holding " b/" is still read whole.
function samePath(header: string): DiffFile | null {
  const length = (header.length - 5) / 2;
  if (!Number.isInteger(length) || length < 1) {
    return null;
  }
  const file = header.slice(2, 2 + length);
  return header === `a/${file} b/${file}` ? { from: file, to: file } : null;
}

// A renamed or copied file names both paths on their own lines.
function movedPaths(lines: Array<string>, start: number): DiffFile | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const line of lines.slice(start)) {
    if (line.startsWith(HEADER) || line.startsWith('@@') || line.startsWith('--- ')) {
      break;
    }
    const source = /^(?:rename|copy) from (.+)$/.exec(line)?.[1];
    const target = /^(?:rename|copy) to (.+)$/.exec(line)?.[1];
    from = source ?? from;
    to = target ?? to;
  }
  return from === null || to === null ? null : { from, to };
}

function looseHeader(header: string): DiffFile | null {
  const match = /^a\/(.+?) b\/(.+)$/.exec(header);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { from: match[1], to: match[2] };
}

// Each file section's paths, in order.
export function diffFiles(diff: string): Array<DiffFile> {
  const lines = diff.split('\n');
  const files: Array<DiffFile> = [];
  lines.forEach((line, index) => {
    if (!line.startsWith(HEADER)) {
      return;
    }
    const header = line.slice(HEADER.length);
    const file = samePath(header) ?? movedPaths(lines, index + 1) ?? looseHeader(header);
    if (file !== null) {
      files.push(file);
    }
  });
  return files;
}

// Every path the patch touches, both sides of a rename, in order.
export function diffPaths(diff: string): Array<string> {
  return [...new Set(diffFiles(diff).flatMap((file) => [file.from, file.to]))];
}

// The paths the patch leaves changed: each file's new side.
export function changedPaths(diff: string): Array<string> {
  return [...new Set(diffFiles(diff).map((file) => file.to))];
}

// Each file's section of the patch, its header through the next header.
export function diffSections(diff: string): Array<{ file: DiffFile; text: string }> {
  return diff.split(/^(?=diff --git )/m).flatMap((text) => {
    const [file] = diffFiles(text);
    return file === undefined ? [] : [{ file, text }];
  });
}

// Each changed path's section hash, by both sides of a rename: what the
// change to that file is, apart from the rest of the patch.
export function fileDiffHashes(diff: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const { file, text } of diffSections(diff)) {
    // Trimmed: the work diff joins untracked files' parts with a newline.
    const hash = sha256(text.trim());
    hashes[file.from] = hash;
    hashes[file.to] = hash;
  }
  return hashes;
}
