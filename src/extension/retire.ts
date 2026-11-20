// Clients of a Pi session that ended (a /reload, a quit, a switch), closed
// once no command or view still uses them: closing a database under a
// command that awaits would break it.

export type Retirement<T extends { close: () => void }> = {
  // Closes these clients now, or when the last running work finishes.
  retire: (clients: Iterable<T>) => void;
  // Runs a command or view; retired clients wait for it.
  tracked: <R>(work: () => Promise<R>) => Promise<R>;
};

export function createRetirement<T extends { close: () => void }>(): Retirement<T> {
  const retiring: Array<T> = [];
  let running = 0;
  const closeIdle = (): void => {
    if (running > 0) {
      return;
    }
    for (const client of retiring.splice(0)) {
      client.close();
    }
  };
  return {
    retire: (clients) => {
      retiring.push(...clients);
      closeIdle();
    },
    tracked: async (work) => {
      running += 1;
      try {
        return await work();
      } finally {
        running -= 1;
        closeIdle();
      }
    },
  };
}
