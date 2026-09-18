export const EXIT_OK = 0;
export const EXIT_IO = 1;
export const EXIT_ARGS = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_INVALID = 4;

export class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
