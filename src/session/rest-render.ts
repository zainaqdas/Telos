/**
 * Markdown rest-render (Scale Batch 5, docs/SCALE_ROADMAP.md item 18).
 *
 * Raw streaming is preserved while the model talks (Part 60: the terminal
 * shows progress as it happens); at turn END the finished answer is re-printed
 * in a clean form: code fences get minimal, syntax-AGNOSTIC highlighting
 * (strings, comments, numbers, keywords — zero deps, no language grammar),
 * headings/bullets get subtle weight. The rest-render goes through the same
 * StreamPrinter width logic as the live stream, so piped output wraps too.
 */

export interface RenderOptions {
  /** Width for wrapping; Infinity = TTY passthrough (no wrapping). */
  width: number;
  write?: (s: string) => void;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  faint: "\x1b[22m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[36m",
} as const;

/** Syntax-agnostic token classes for one line of code-fence content. */
function highlightCodeLine(line: string): string {
  // Comments first: everything after # or // dims out.
  const commentIdx = [line.indexOf("#"), line.indexOf("//")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (commentIdx !== undefined) {
    return highlightCodeLine(line.slice(0, commentIdx)) + ANSI.dim + line.slice(commentIdx) + ANSI.reset;
  }
  // Strings (single, double, backtick — no nesting in a line).
  const out: string[] = [];
  let rest = line;
  const strRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;
  while (rest.length > 0) {
    const m = strRe.exec(rest);
    if (!m || m.index === undefined) {
      out.push(highlightKeywords(rest));
      break;
    }
    out.push(highlightKeywords(rest.slice(0, m.index)));
    out.push(ANSI.green + m[0] + ANSI.reset);
    rest = rest.slice(m.index + m[0].length);
  }
  return out.join("");
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from",
  "class", "extends", "new", "await", "async", "try", "catch", "finally", "throw", "typeof", "interface",
  "type", "enum", "def", "elif", "lambda", "pass", "None", "True", "False", "null", "undefined", "true", "false", "fn", "pub", "impl", "struct", "match",
]);

function highlightKeywords(chunk: string): string {
  // Keyword or number tokens get color; punctuation stays plain.
  return chunk.replace(/([A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?)/g, (tok) => {
    if (KEYWORDS.has(tok)) return ANSI.blue + tok + ANSI.reset;
    if (/^\d/.test(tok)) return ANSI.yellow + tok + ANSI.reset;
    return tok;
  });
}

/**
 * Re-render a finished assistant answer. Fenced code gets minimal
 * highlighting; headings are bolded; bullets/quotes keep their markers.
 */
export function restRenderMarkdown(text: string, opts: RenderOptions): void {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const wrap = opts.width !== Number.POSITIVE_INFINITY;
  const width = Math.max(20, opts.width);

  const lines = text.split("\n");
  let inFence = false;
  for (const line of lines) {
    const fence = line.trimStart().startsWith("```");
    if (fence) {
      inFence = !inFence;
      write(`${ANSI.dim}${line}${ANSI.reset}\n`);
      continue;
    }
    if (inFence) {
      const painted = highlightCodeLine(line);
      if (wrap && painted.length > width) {
        // Code lines are never hard-wrapped mid-token by the printer; clip
        // instead — a broken line of code is worse than a clipped one.
        write(painted + "\n");
      } else {
        write(painted + "\n");
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      write(`${ANSI.bold}${heading[1]} ${heading[2]}${ANSI.reset}\n`);
      continue;
    }
    // Prose: soft-wrap long lines at the width (word boundaries, no colors).
    if (wrap && line.length > width) {
      write(wrapWords(line, width) + "\n");
    } else {
      write(line + "\n");
    }
  }
}

function wrapWords(line: string, width: number): string {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(/(\s+)/)) {
    if (current.length + word.length <= width) {
      current += word;
    } else {
      if (current.trim()) out.push(current.trimEnd());
      current = word.trimStart();
    }
  }
  if (current.trim()) out.push(current.trimEnd());
  return out.join("\n");
}
