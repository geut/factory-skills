// A status card travels as plain text: the Pi message content, the user
// notification, and the `/factory` command reply all carry it. The first
// lines are `key: value` headers; everything after them is the body.

export type CardTone = 'attention' | 'done' | 'failed' | 'progress';

export type FactoryCard = {
  body: string;
  displayRef: string;
  // Lines shown even when the card is collapsed (plan tasks, findings).
  items: Array<string>;
  next: string | null;
  outcome: string;
  progress: string | null;
  round: number | null;
  stage: string;
  task: string | null;
  tone: CardTone;
};

const tones: ReadonlyArray<CardTone> = ['attention', 'done', 'failed', 'progress'];

export function card(input: Partial<FactoryCard> & { displayRef: string }): FactoryCard {
  return {
    body: '',
    items: [],
    next: null,
    outcome: '',
    progress: null,
    round: null,
    stage: '',
    task: null,
    tone: 'progress',
    ...input,
  };
}

export function encodeCard(value: FactoryCard): string {
  const lines = [value.displayRef];
  if (value.stage.length > 0) {
    lines.push(`stage: ${value.stage}`);
  }
  if (value.outcome.length > 0) {
    lines.push(`status: ${value.outcome}`);
  }
  if (value.task !== null) {
    lines.push(`task: ${value.task}`);
  }
  if (value.round !== null) {
    lines.push(`round: ${value.round}`);
  }
  if (value.progress !== null) {
    lines.push(`progress: ${value.progress}`);
  }
  if (value.tone !== 'progress') {
    lines.push(`tone: ${value.tone}`);
  }
  for (const item of value.items) {
    lines.push(`item: ${item}`);
  }
  if (value.next !== null) {
    lines.push(`next: ${value.next}`);
  }
  if (value.body.trim().length > 0) {
    lines.push(value.body.trim());
  }
  return lines.join('\n');
}

const header = /^(stage|status|task|round|progress|tone|item|next): (.*)$/;

// Plain text without headers still decodes: its first line is the title.
export function decodeCard(text: string): FactoryCard {
  const lines = text.split('\n');
  const result = card({ displayRef: lines[0]?.trim() ?? '' });
  let cursor = 1;
  for (; cursor < lines.length; cursor += 1) {
    const match = header.exec(lines[cursor] ?? '');
    if (match === null) {
      break;
    }
    const value = (match[2] ?? '').trim();
    switch (match[1]) {
      case 'stage':
        result.stage = value;
        break;
      case 'status':
        result.outcome = value;
        break;
      case 'task':
        result.task = value;
        break;
      case 'round': {
        const round = Number(value);
        result.round = Number.isInteger(round) ? round : null;
        break;
      }
      case 'progress':
        result.progress = value;
        break;
      case 'tone':
        result.tone = tones.find((tone) => tone === value) ?? 'progress';
        break;
      case 'item':
        result.items.push(value);
        break;
      case 'next':
        result.next = value;
        break;
      default:
        break;
    }
  }
  result.body = lines.slice(cursor).join('\n').trim();
  return result;
}
