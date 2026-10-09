// Converts the SGR colour codes Pi's themes emit into HTML spans. Other
// control sequences (OSC hyperlinks, cursor moves) are dropped.

type Style = {
  bg: string | null;
  bold: boolean;
  dim: boolean;
  fg: string | null;
  inverse: boolean;
  italic: boolean;
  underline: boolean;
};

const basic = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
];
const bright = [
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];

function fresh(): Style {
  return {
    bg: null,
    bold: false,
    dim: false,
    fg: null,
    inverse: false,
    italic: false,
    underline: false,
  };
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function level(step: number): number {
  return step === 0 ? 0 : 55 + step * 40;
}

function palette256(index: number): string {
  if (index < 8) {
    return basic[index] ?? '#ffffff';
  }
  if (index < 16) {
    return bright[index - 8] ?? '#ffffff';
  }
  if (index < 232) {
    const value = index - 16;
    return hex(level(Math.floor(value / 36)), level(Math.floor(value / 6) % 6), level(value % 6));
  }
  const gray = 8 + (index - 232) * 10;
  return hex(gray, gray, gray);
}

function apply(style: Style, codes: Array<number>): void {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      Object.assign(style, fresh());
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.inverse = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code === 27) {
      style.inverse = false;
    } else if (code === 39) {
      style.fg = null;
    } else if (code === 49) {
      style.bg = null;
    } else if (code >= 30 && code <= 37) {
      style.fg = basic[code - 30] ?? null;
    } else if (code >= 90 && code <= 97) {
      style.fg = bright[code - 90] ?? null;
    } else if (code >= 40 && code <= 47) {
      style.bg = basic[code - 40] ?? null;
    } else if (code >= 100 && code <= 107) {
      style.bg = bright[code - 100] ?? null;
    } else if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      let color: string | null = null;
      if (mode === 2) {
        color = hex(codes[index + 2] ?? 0, codes[index + 3] ?? 0, codes[index + 4] ?? 0);
        index += 4;
      } else if (mode === 5) {
        color = palette256(codes[index + 2] ?? 0);
        index += 2;
      }
      if (code === 38) {
        style.fg = color;
      } else {
        style.bg = color;
      }
    }
  }
}

function css(style: Style): string {
  const fg = style.inverse ? style.bg : style.fg;
  const bg = style.inverse ? style.fg : style.bg;
  const rules: Array<string> = [];
  if (fg !== null) {
    rules.push(`color:${fg}`);
  }
  if (bg !== null) {
    rules.push(`background:${bg}`);
  }
  if (style.bold) {
    rules.push('font-weight:700');
  }
  if (style.dim) {
    rules.push('opacity:.7');
  }
  if (style.italic) {
    rules.push('font-style:italic');
  }
  if (style.underline) {
    rules.push('text-decoration:underline');
  }
  return rules.join(';');
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// SGR codes, OSC strings (hyperlinks), and any other CSI sequence.
const sequence = new RegExp(
  `${ESC}\\[([0-9;]*)m|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[A-Za-z]`,
  'g',
);

export function ansiToHtml(line: string): string {
  const style = fresh();
  let html = '';
  let cursor = 0;
  const emit = (text: string) => {
    if (text.length === 0) {
      return;
    }
    const rules = css(style);
    html +=
      rules.length === 0 ? escapeHtml(text) : `<span style="${rules}">${escapeHtml(text)}</span>`;
  };
  for (const match of line.matchAll(sequence)) {
    emit(line.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[0].endsWith('m') && match[1] !== undefined) {
      apply(style, match[1].length === 0 ? [0] : match[1].split(';').map(Number));
    }
  }
  emit(line.slice(cursor));
  return html;
}
