/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process HTML to markdown. No network, no DOM library: a small tolerant
 * tokenizer plus a block/inline renderer, ported from oh-my-pi's
 * `htmlToBasicMarkdown` (which delegates to Turndown) with the same intent —
 * keep the document's structure and, unlike the raw-text fallback in
 * `web_fetch`, keep link targets.
 */

/** Elements dropped together with their subtree. */
const DROPPED_ELEMENTS: Record<string, true> = {
  applet: true,
  aside: true,
  audio: true,
  button: true,
  canvas: true,
  dialog: true,
  embed: true,
  fieldset: true,
  footer: true,
  form: true,
  frame: true,
  frameset: true,
  header: true,
  iframe: true,
  input: true,
  label: true,
  math: true,
  nav: true,
  noframes: true,
  noscript: true,
  object: true,
  optgroup: true,
  option: true,
  script: true,
  select: true,
  style: true,
  svg: true,
  template: true,
  textarea: true,
  title: true,
  track: true,
  video: true,
};

/** Elements rendered as their own markdown block. */
const BLOCK_ELEMENTS: Record<string, true> = {
  address: true,
  article: true,
  blockquote: true,
  dd: true,
  details: true,
  div: true,
  dl: true,
  dt: true,
  figcaption: true,
  figure: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hr: true,
  li: true,
  main: true,
  ol: true,
  p: true,
  pre: true,
  section: true,
  summary: true,
  table: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  thead: true,
  tr: true,
  ul: true,
};

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const VOID_ELEMENTS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

/** Elements whose content is text, not markup. */
const RAW_TEXT_ELEMENTS: Record<string, true> = {
  script: true,
  style: true,
  textarea: true,
  title: true,
};

/** Siblings implicitly closed when the named element opens. */
const IMPLICIT_CLOSERS: Record<string, readonly string[]> = {
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt'],
  li: ['li'],
  option: ['option'],
  p: ['p'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['tr', 'td', 'th'],
};

/** Block elements that implicitly close an open `<p>`. */
const CLOSES_PARAGRAPH: Record<string, true> = {
  article: true,
  aside: true,
  blockquote: true,
  div: true,
  dl: true,
  figure: true,
  footer: true,
  form: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  header: true,
  hr: true,
  li: true,
  main: true,
  nav: true,
  ol: true,
  p: true,
  pre: true,
  section: true,
  table: true,
  ul: true,
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  deg: '°',
  divide: '÷',
  emsp: ' ',
  ensp: ' ',
  euro: '€',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  minus: '−',
  nbsp: ' ',
  ndash: '–',
  pound: '£',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  sect: '§',
  shy: '',
  thinsp: ' ',
  times: '×',
  trade: '™',
  yen: '¥',
  zwj: '',
  zwnj: '',
};

interface HtmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: HtmlNode[];
}

interface HtmlText {
  readonly kind: 'text';
  readonly value: string;
}

type HtmlNode = HtmlElement | HtmlText;

interface RenderContext {
  readonly baseUrl: string | undefined;
}

interface Chunk {
  /** Block chunks are separated from their neighbours by a blank line. */
  readonly block: boolean;
  readonly text: string;
}

const TAG_PATTERN =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/;
const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(source);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attrs[name.toLowerCase()] = decodeEntities(value);
    }
    match = ATTRIBUTE_PATTERN.exec(source);
  }
  return attrs;
}

function findRawTextEnd(
  html: string,
  name: string,
  from: number,
): { end: number; next: number } {
  const pattern = new RegExp(`</${name}\\s*>`, 'i');
  const rest = html.slice(from);
  const match = pattern.exec(rest);
  if (match === null) {
    return { end: html.length, next: html.length };
  }
  return {
    end: from + match.index,
    next: from + match.index + match[0].length,
  };
}

/**
 * Tolerant HTML tokenizer. Unbalanced or stray tags never abort the parse: an
 * unmatched close tag is ignored, an unclosed element swallows the rest.
 */
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = {
    kind: 'element',
    name: '#document',
    attrs: {},
    children: [],
  };
  const stack: HtmlElement[] = [root];
  let index = 0;

  const top = (): HtmlElement => {
    const current = stack[stack.length - 1];
    return current ?? root;
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      top().children.push({ kind: 'text', value: html.slice(index) });
      break;
    }
    if (next > index) {
      top().children.push({ kind: 'text', value: html.slice(index, next) });
    }
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    const match = TAG_PATTERN.exec(html.slice(next));
    if (match === null) {
      top().children.push({ kind: 'text', value: '<' });
      index = next + 1;
      continue;
    }
    const tag = match[2].toLowerCase();
    const selfClosing = match[4] === '/';
    index = next + match[0].length;

    if (match[1] === '/') {
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]?.name === tag) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    for (const closer of IMPLICIT_CLOSERS[tag] ?? []) {
      if (top().name === closer) {
        stack.pop();
      }
    }
    if (CLOSES_PARAGRAPH[tag] === true && top().name === 'p') {
      stack.pop();
    }

    const element: HtmlElement = {
      kind: 'element',
      name: tag,
      attrs: parseAttributes(match[3] ?? ''),
      children: [],
    };
    top().children.push(element);

    if (RAW_TEXT_ELEMENTS[tag] === true) {
      const bounds = findRawTextEnd(html, tag, index);
      element.children.push({
        kind: 'text',
        value: html.slice(index, bounds.end),
      });
      index = bounds.next;
      continue;
    }
    if (selfClosing !== true && VOID_ELEMENTS[tag] !== true) {
      stack.push(element);
    }
  }

  return root.children;
}

/** Concatenates text content verbatim, honouring `<br>` as a newline. */
function rawText(nodes: readonly HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += decodeEntities(node.value);
      continue;
    }
    out += node.name === 'br' ? '\n' : rawText(node.children);
  }
  return out;
}

function resolveUrl(
  href: string,
  baseUrl: string | undefined,
): string | undefined {
  const value = href.trim();
  if (value.length === 0 || value.startsWith('#')) {
    return undefined;
  }
  if (baseUrl === undefined || baseUrl.length === 0) {
    return value.startsWith('//') ? `https:${value}` : value;
  }
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function collectChunks(
  nodes: readonly HtmlNode[],
  ctx: RenderContext,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const node of nodes) {
    const chunk = renderNode(node, ctx);
    if (chunk !== null) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function joinChunks(chunks: readonly Chunk[]): string {
  let out = '';
  let afterBlock = false;
  for (const chunk of chunks) {
    if (chunk.text.trim().length === 0) {
      if (!chunk.block && out.length > 0 && !/\s$/.test(out)) {
        out += ' ';
      }
      continue;
    }
    if (chunk.block) {
      if (out.length > 0) {
        out = `${out.replace(/\s+$/, '')}\n\n`;
      }
      out += chunk.text.trim();
      afterBlock = true;
      continue;
    }
    out += afterBlock ? chunk.text.replace(/^\s+/, '') : chunk.text;
    afterBlock = false;
  }
  return out;
}

function renderChildren(
  nodes: readonly HtmlNode[],
  ctx: RenderContext,
): string {
  return joinChunks(collectChunks(nodes, ctx));
}

function renderEmphasis(
  node: HtmlElement,
  ctx: RenderContext,
  marker: string,
): Chunk | null {
  const inner = renderChildren(node.children, ctx).trim();
  if (inner.length === 0) {
    return null;
  }
  return { block: false, text: `${marker}${inner}${marker}` };
}

function renderLink(node: HtmlElement, ctx: RenderContext): Chunk | null {
  const inner = renderChildren(node.children, ctx).trim();
  const href = node.attrs['href'];
  const target = href === undefined ? undefined : resolveUrl(href, ctx.baseUrl);
  if (target === undefined) {
    return inner.length > 0 ? { block: false, text: inner } : null;
  }
  const label = inner.length > 0 ? inner : target;
  return { block: false, text: `[${label}](${target})` };
}

function renderImage(node: HtmlElement, ctx: RenderContext): Chunk | null {
  const alt = (node.attrs['alt'] ?? '').trim();
  const src = node.attrs['src'];
  const target = src === undefined ? undefined : resolveUrl(src, ctx.baseUrl);
  if (target === undefined) {
    return alt.length > 0 ? { block: false, text: alt } : null;
  }
  return { block: false, text: `![${alt}](${target})` };
}

function renderCodeBlock(node: HtmlElement): Chunk | null {
  const code = rawText(node.children).replace(/\n+$/, '');
  if (code.trim().length === 0) {
    return null;
  }
  let language = '';
  for (const child of node.children) {
    if (child.kind !== 'element' || child.name !== 'code') {
      continue;
    }
    language =
      /(?:language|lang)-([\w+#.-]+)/.exec(child.attrs['class'] ?? '')?.[1] ??
      '';
    break;
  }
  const fence = code.includes('```') ? '````' : '```';
  return { block: true, text: `${fence}${language}\n${code}\n${fence}` };
}

function renderListItem(
  node: HtmlElement,
  ctx: RenderContext,
  indent: string,
): string {
  const text = renderChildren(node.children, ctx).replace(/\s+$/, '');
  if (text.trim().length === 0) {
    return '';
  }
  const lines = text.split('\n');
  const head = (lines[0] ?? '').replace(/^\s+/, '');
  const rest = lines
    .slice(1)
    .map((line) => (line.trim().length === 0 ? '' : indent + line.trim()));
  return [head, ...rest].join('\n');
}

function renderList(node: HtmlElement, ctx: RenderContext): Chunk | null {
  const ordered = node.name === 'ol';
  const parsedStart = Number.parseInt(node.attrs['start'] ?? '1', 10);
  let counter = Number.isFinite(parsedStart) ? parsedStart : 1;
  const lines: string[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') {
      continue;
    }
    if (child.name !== 'li') {
      const loose = renderChildren([child], ctx).trim();
      if (loose.length > 0) {
        lines.push(loose);
      }
      continue;
    }
    const marker = ordered ? `${counter}. ` : '- ';
    counter += 1;
    const body = renderListItem(child, ctx, ' '.repeat(marker.length));
    if (body.length > 0) {
      lines.push(marker + body);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return { block: true, text: lines.join('\n') };
}

function renderTableCell(node: HtmlElement, ctx: RenderContext): string {
  return renderChildren(node.children, ctx)
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function renderTable(node: HtmlElement, ctx: RenderContext): Chunk | null {
  const rows: string[][] = [];
  const collectRows = (parent: HtmlElement): void => {
    for (const child of parent.children) {
      if (child.kind !== 'element') {
        continue;
      }
      if (child.name === 'tr') {
        const cells: string[] = [];
        for (const cell of child.children) {
          if (cell.kind !== 'element') {
            continue;
          }
          if (cell.name === 'td' || cell.name === 'th') {
            cells.push(renderTableCell(cell, ctx));
          }
        }
        if (cells.length > 0) {
          rows.push(cells);
        }
        continue;
      }
      if (
        child.name === 'thead' ||
        child.name === 'tbody' ||
        child.name === 'tfoot'
      ) {
        collectRows(child);
      }
    }
  };
  collectRows(node);
  if (rows.length === 0) {
    return null;
  }
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) {
      padded.push('');
    }
    return padded;
  });
  const header = normalized[0];
  if (header === undefined) {
    return null;
  }
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of normalized.slice(1)) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return { block: true, text: lines.join('\n') };
}

function renderNode(node: HtmlNode, ctx: RenderContext): Chunk | null {
  if (node.kind === 'text') {
    return {
      block: false,
      text: decodeEntities(node.value).replace(/\s+/g, ' '),
    };
  }
  const name = node.name;
  if (DROPPED_ELEMENTS[name] === true) {
    return null;
  }
  if (name === 'br') {
    return { block: false, text: '\n' };
  }
  if (name === 'hr') {
    return { block: true, text: '---' };
  }
  if (name === 'a') {
    return renderLink(node, ctx);
  }
  if (name === 'img') {
    return renderImage(node, ctx);
  }
  if (name === 'pre') {
    return renderCodeBlock(node);
  }
  if (name === 'code') {
    const text = rawText(node.children).replace(/\s+/g, ' ').trim();
    return text.length > 0 ? { block: false, text: `\`${text}\`` } : null;
  }
  if (name === 'strong' || name === 'b') {
    return renderEmphasis(node, ctx, '**');
  }
  if (name === 'em' || name === 'i') {
    return renderEmphasis(node, ctx, '*');
  }
  if (name === 'del' || name === 's' || name === 'strike') {
    return renderEmphasis(node, ctx, '~~');
  }
  if (name === 'blockquote') {
    const inner = renderChildren(node.children, ctx).trim();
    if (inner.length === 0) {
      return null;
    }
    return {
      block: true,
      text: inner
        .split('\n')
        .map((line) => (line.length === 0 ? '>' : `> ${line}`))
        .join('\n'),
    };
  }
  if (name === 'ul' || name === 'ol') {
    return renderList(node, ctx);
  }
  if (name === 'table') {
    return renderTable(node, ctx);
  }
  const level = HEADING_LEVELS[name];
  if (level >= 1 && level <= 6) {
    const inner = renderChildren(node.children, ctx).trim();
    if (inner.length === 0) {
      return null;
    }
    return { block: true, text: `${'#'.repeat(level)} ${inner}` };
  }
  if (BLOCK_ELEMENTS[name] === true) {
    const inner = renderChildren(node.children, ctx);
    return inner.trim().length > 0 ? { block: true, text: inner } : null;
  }
  return { block: false, text: renderChildren(node.children, ctx) };
}

/**
 * Converts HTML to markdown, keeping headings, lists, code blocks, tables and —
 * unlike a plain-text conversion — link targets. Relative `href`/`src` values
 * are resolved against `baseUrl` when it is given.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  if (html.length === 0) {
    return '';
  }
  const ctx: RenderContext = { baseUrl };
  const markdown = renderChildren(parseHtml(html), ctx);
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Below this many non-whitespace characters a page carries almost no signal. */
const MIN_USEFUL_CHARS = 200;

/** Phrases that identify a JS gate or a cookie/nav banner rather than content. */
const BANNER_PHRASES: readonly string[] = [
  'accept all cookies',
  'browser does not support',
  'cookie consent',
  'cookie policy',
  'enable javascript',
  'javascript is disabled',
  'javascript is required',
  'please enable javascript',
  'privacy policy',
  'skip to main content',
  'terms of service',
  'we use cookies',
];

const LINK_SYNTAX_PATTERN = /!?\[[^\]]*\]\([^)]*\)/g;
const LIST_PREFIX_PATTERN = /^(?:[-*+]|\d+\.)\s+/;

/**
 * Quality gate applied to every reader's output: true means "this is probably
 * an interstitial, not the page you were asked for".
 */
export function isLowQualityOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const nonWhitespace = trimmed.replace(/\s+/g, '').length;
  if (nonWhitespace < MIN_USEFUL_CHARS) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (
    trimmed.length < 1024 &&
    BANNER_PHRASES.some((phrase) => lower.includes(phrase))
  ) {
    return true;
  }
  const lines = trimmed
    .split('\n')
    .map((line) =>
      line
        .replace(LINK_SYNTAX_PATTERN, '')
        .replace(/^#+\s*/, '')
        .replace(LIST_PREFIX_PATTERN, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
  if (
    lines.length > 0 &&
    lines.every((line) =>
      BANNER_PHRASES.some((phrase) => line.toLowerCase().includes(phrase)),
    )
  ) {
    return true;
  }
  const shortLines = lines.filter((line) => line.length < 40);
  if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
    return true;
  }
  return false;
}
