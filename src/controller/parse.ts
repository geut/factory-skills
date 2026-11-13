import type { TicketSource } from '../tickets.ts';

export type ParsedCommand =
  | { kind: 'start'; source: TicketSource }
  | { answer: string; kind: 'reply'; ref: string }
  | { kind: 'retry'; ref: string }
  | { kind: 'complete'; ref: string }
  // `--list` shows the pending comments and changes nothing; otherwise a round
  // starts on all of them, `--only` some, or all but `--skip` ones.
  | {
      kind: 'feedback';
      list: boolean;
      note: string | null;
      only: Array<string> | null;
      ref: string;
      skip: Array<string>;
    }
  | { kind: 'stop'; ref: string }
  | { kind: 'rerun'; ref: string }
  | { kind: 'cancel'; reason: string | null; ref: string }
  | { kind: 'status'; ref: string }
  | { kind: 'agents' }
  | { kind: 'ticket'; ref: string | null }
  | { kind: 'invalid'; message: string };

const FEEDBACK_USAGE =
  'Usage: /factory feedback <ticket> [--list] [--only <ref,ref>] [--skip <ref,ref>] ["note"]';

function refList(value: string | undefined): Array<string> | null {
  const refs = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return refs.length === 0 ? null : refs;
}

function parseFeedback(rest: string): ParsedCommand {
  const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
  const ref = tokens.shift();
  if (ref === undefined || ref.startsWith('--')) {
    return { kind: 'invalid', message: FEEDBACK_USAGE };
  }
  let list = false;
  let only: Array<string> | null = null;
  let skip: Array<string> = [];
  while (tokens[0]?.startsWith('--') === true) {
    const flag = tokens.shift();
    if (flag === '--list') {
      list = true;
    } else if (flag === '--only' || flag === '--skip') {
      const refs = refList(tokens.shift());
      if (refs === null) {
        return {
          kind: 'invalid',
          message: `${flag} needs refs, such as ${flag} r2841,c6799. ${FEEDBACK_USAGE}`,
        };
      }
      if (flag === '--only') {
        only = refs;
      } else {
        skip = refs;
      }
    } else {
      return { kind: 'invalid', message: FEEDBACK_USAGE };
    }
  }
  let note = tokens.join(' ').trim();
  if (note.startsWith('"') && note.endsWith('"') && note.length >= 2) {
    note = note.slice(1, -1);
  }
  return { kind: 'feedback', list, note: note.length === 0 ? null : note, only, ref, skip };
}

export function parseFactoryCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'invalid',
      message:
        'Usage: /factory start|reply|retry|complete|feedback|stop|cancel|rerun|status <ticket> | /factory agents | /factory ticket',
    };
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
    case 'complete':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory complete <ticket>' };
      }
      return { kind: 'complete', ref: rest };
    case 'feedback':
      return parseFeedback(rest);
    case 'cancel': {
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory cancel <ticket> ["reason"]' };
      }
      const cut = rest.indexOf(' ');
      let reason = cut === -1 ? '' : rest.slice(cut + 1).trim();
      if (reason.startsWith('"') && reason.endsWith('"') && reason.length >= 2) {
        reason = reason.slice(1, -1);
      }
      return {
        kind: 'cancel',
        reason: reason.length === 0 ? null : reason,
        ref: cut === -1 ? rest : rest.slice(0, cut),
      };
    }
    case 'rerun':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory rerun <ticket>' };
      }
      return { kind: 'rerun', ref: rest };
    case 'stop':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory stop <ticket>' };
      }
      return { kind: 'stop', ref: rest };
    case 'status':
      if (rest.length === 0) {
        return { kind: 'invalid', message: 'Usage: /factory status <ticket>' };
      }
      return { kind: 'status', ref: rest };
    case 'agents':
      return { kind: 'agents' };
    case 'ticket':
      return { kind: 'ticket', ref: rest.length === 0 ? null : rest };
    default:
      return {
        kind: 'invalid',
        message:
          'Usage: /factory start|reply|retry|complete|feedback|stop|cancel|rerun|status <ticket> | /factory agents | /factory ticket',
      };
  }
}
