import type { TicketSource } from '../tickets.ts';

export type ParsedCommand =
  | { kind: 'start'; source: TicketSource }
  | { answer: string; kind: 'reply'; ref: string }
  | { kind: 'retry'; ref: string }
  | { kind: 'status'; ref: string }
  | { kind: 'agents' }
  | { kind: 'invalid'; message: string };

export function parseFactoryCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { kind: 'invalid', message: 'Usage: /factory start|reply|retry|status <ticket>' };
  }
  const space = trimmed.indexOf(' ');
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
  switch (head) {
    case 'start':
      if (rest.startsWith('--text')) {
        const body = rest.slice('--text'.length).trim();
        const split = body.indexOf(' ');
        if (split === -1) {
          return { kind: 'invalid', message: 'Usage: /factory start --text <id> <ticket text>' };
        }
        return {
          kind: 'start',
          source: { body: body.slice(split + 1).trim(), id: body.slice(0, split), kind: 'text' },
        };
      }
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory start <ticket>' };
      }
      return { kind: 'start', source: { kind: 'ref', value: rest } };
    case 'reply': {
      const replySpace = rest.indexOf(' ');
      if (replySpace === -1) {
        return { kind: 'invalid', message: 'Usage: /factory reply <ticket> "answer"' };
      }
      const ref = rest.slice(0, replySpace);
      let answer = rest.slice(replySpace + 1).trim();
      if (answer.startsWith('"') && answer.endsWith('"') && answer.length >= 2) {
        answer = answer.slice(1, -1);
      }
      if (answer.length === 0) {
        return { kind: 'invalid', message: 'Reply needs an answer.' };
      }
      return { answer, kind: 'reply', ref };
    }
    case 'retry':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory retry <ticket>' };
      }
      return { kind: 'retry', ref: rest };
    case 'status':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory status <ticket>' };
      }
      return { kind: 'status', ref: rest };
    case 'agents':
      return { kind: 'agents' };
    default:
      return {
        kind: 'invalid',
        message: 'Usage: /factory start|reply|retry|status <ticket> | /factory agents',
      };
  }
}
