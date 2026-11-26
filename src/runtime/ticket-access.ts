import { request } from 'node:http';

// How a ticket's agents reach the factory server for controller work: the
// address, the ticket's key, and its token, from the launch environment. It
// ships beside the child handshake, which Pi loads on its own, so it imports
// nothing but Node.

export const SERVER_URL_ENV = 'FACTORY_SERVER_URL';
export const TICKET_KEY_ENV = 'FACTORY_TICKET_KEY';
export const TICKET_TOKEN_ENV = 'FACTORY_TICKET_TOKEN';

export type TicketAccess = { key: string; token: string; url: string };

export function ticketAccessFrom(env: NodeJS.ProcessEnv): TicketAccess | null {
  const url = env[SERVER_URL_ENV] ?? '';
  const key = env[TICKET_KEY_ENV] ?? '';
  const token = env[TICKET_TOKEN_ENV] ?? '';
  return url.length === 0 || key.length === 0 || token.length === 0 ? null : { key, token, url };
}

// Posts JSON to the server and waits as long as it takes: a validation runs
// for minutes, past fetch's wait for response headers.
export function postJson(input: {
  access: TicketAccess;
  body: unknown;
  route: string;
  signal?: AbortSignal;
}): Promise<{ payload: unknown; status: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(input.body);
    const sent = request(
      new URL(input.route, input.access.url),
      {
        headers: {
          authorization: `Bearer ${input.access.token}`,
          'content-length': Buffer.byteLength(data),
          'content-type': 'application/json',
        },
        method: 'POST',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let payload: unknown = null;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            payload = null;
          }
          resolve({ payload, status: response.statusCode ?? 0 });
        });
        response.on('error', reject);
      },
    );
    sent.on('error', reject);
    sent.end(data);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seconds(ms: unknown): string {
  return typeof ms === 'number' ? ` in ${Math.round(ms / 1000)}s` : '';
}

// The server's answer to a requested validation, for the agent to read.
export function validationSummary(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload['checks'])) {
    return 'The controller answered without checks.';
  }
  const checks = payload['checks'].filter(isRecord);
  const lines = checks.map((check) => {
    const head = `- ${String(check['name'])}: ${String(check['status'])}${seconds(check['durationMs'])}`;
    const excerpt = typeof check['outputExcerpt'] === 'string' ? check['outputExcerpt'].trim() : '';
    return check['status'] === 'passed' || excerpt.length === 0
      ? head
      : `${head}\n${excerpt
          .split('\n')
          .slice(-40)
          .map((line) => `    ${line}`)
          .join('\n')}`;
  });
  const passed = payload['passed'] === true;
  const reusable = payload['reusable'] === true;
  const attached = payload['attached'] !== false;
  const verdict = passed
    ? reusable && attached
      ? 'Validation passed. If you change nothing more and call subagent_done with the same validation_selection, the controller reuses this pass instead of running the commands again.'
      : 'Validation passed, but files changed while the commands ran, so the controller runs them again when you submit.'
    : 'Validation failed. Fix what failed, then ask again or submit.';
  return [
    verdict,
    '',
    ...(lines.length === 0 ? ['No validation commands are configured.'] : lines),
  ].join('\n');
}
