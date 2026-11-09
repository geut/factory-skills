// A single-quoted shell word: the shell runs none of `value`, such as a
// backtick or `$` in a pull request title.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
