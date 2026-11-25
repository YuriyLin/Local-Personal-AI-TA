import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

export const PAGE_MARKER = /^<!--\s*page:\s*(\d+)\s*-->$/gm;
const ASSET_PATH_RE = /^images\/[^/\\?#%]+\.(png|jpe?g|webp|gif)$/i;

const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

/**
 * Ensures paired $ and $$ KaTeX delimiters while leaving fenced/inline code,
 * escaped \$, and plain currency values ($50, $12.99) intact so malformed
 * AI-generated formulas never break page layout.
 */
export function sanitizeLatexDelimiters(source: string): string {
  if (!source || !source.includes('$')) return source;

  const codePlaceholders: Array<{ token: string; raw: string }> = [];
  let cIdx = 0;
  let working = source.replace(/(^|\n)(```[\s\S]*?\n```|~~~[\s\S]*?\n~~~)/g, (match) => {
    const token = `BIIBOCODEBLK${cIdx++}END`;
    codePlaceholders.push({ token, raw: match });
    return token;
  });
  working = working.replace(/(`+)([^`\n]+?)\1/g, (match) => {
    const token = `BIIBOCODEINL${cIdx++}END`;
    codePlaceholders.push({ token, raw: match });
    return token;
  });

  // 1. Balance display math $$ delimiters.
  const doublePositions: number[] = [];
  for (let i = 0; i < working.length - 1; i++) {
    if (working[i] === '$' && working[i + 1] === '$' && !isEscapedAt(working, i)) {
      doublePositions.push(i);
      i++; // advance past second $
    }
  }
  if (doublePositions.length % 2 === 1) {
    const lastPos = doublePositions[doublePositions.length - 1];
    const trailing = working.slice(lastPos + 2).trim();
    if (!trailing) {
      // Dangling $$ with nothing after it: escape it so it never swallows text.
      working = `${working.slice(0, lastPos)}\\$\\$${working.slice(lastPos + 2)}`;
    } else {
      working = `${working.trimEnd()}\n$$`;
    }
  }

  // 2. Temporarily shield paired $$...$$ blocks before checking inline $.
  const blockPlaceholders: Array<{ token: string; raw: string }> = [];
  let bIdx = 0;
  working = working.replace(/(^|[^\\])\$\$([\s\S]+?)\$\$/g, (match, lead: string, expr: string) => {
    const token = `BIIBODISPMATH${bIdx++}END`;
    blockPlaceholders.push({ token, raw: `${lead}$$${expr}$$` });
    return token;
  });

  // 3. Balance single-line inline $ delimiters and escape currency or lone $.
  const lines = working.split('\n');
  const sanitizedLines = lines.map((line) => {
    if (!line.includes('$')) return line;
    const rawPositions: number[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '$' && !isEscapedAt(line, i)) {
        rawPositions.push(i);
      }
    }
    if (!rawPositions.length) return line;

    const escapeIndices = new Set<number>();
    const mathCandidates: number[] = [];

    // First pass: detect standalone currency like $50, $12.99, $1,000 before pairing math.
    for (let idx = 0; idx < rawPositions.length; idx++) {
      const pos = rawPositions[idx];
      const after = line.slice(pos + 1);
      const currencyMatch = /^\d[\d,]*(?:\.\d+)?(?=$|[\s,.;:!?。，、）)\]])/.exec(after);
      const nextPos = rawPositions[idx + 1];
      const closesImmediatelyAsMath =
        nextPos !== undefined && /^\d[\d,]*(?:\.\d+)?$/.test(line.slice(pos + 1, nextPos));
      if (currencyMatch && !closesImmediatelyAsMath) {
        escapeIndices.add(pos);
      } else {
        mathCandidates.push(pos);
      }
    }

    // Second pass: pair adjacent inline math $...$ spans; escape any invalid/unpaired $.
    let idx = 0;
    while (idx < mathCandidates.length) {
      const start = mathCandidates[idx];
      if (idx + 1 < mathCandidates.length) {
        const end = mathCandidates[idx + 1];
        const inner = line.slice(start + 1, end);
        const validInline = inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner);
        if (validInline) {
          idx += 2;
          continue;
        }
      }
      escapeIndices.add(start);
      idx++;
    }

    if (!escapeIndices.size) return line;
    let out = '';
    for (let i = 0; i < line.length; i++) {
      if (escapeIndices.has(i)) out += '\\$';
      else out += line[i];
    }
    return out;
  });
  working = sanitizedLines.join('\n');

  // Restore display math and code placeholders in reverse order.
  for (let i = blockPlaceholders.length - 1; i >= 0; i--) {
    working = working.replace(blockPlaceholders[i].token, () => blockPlaceholders[i].raw);
  }
  for (let i = codePlaceholders.length - 1; i >= 0; i--) {
    working = working.replace(codePlaceholders[i].token, () => codePlaceholders[i].raw);
  }
  return working;
}

function extractMathAndRender(source: string): string {
  const safeSource = sanitizeLatexDelimiters(source);
  const placeholders: Array<{ token: string; html: string }> = [];
  let idx = 0;
  const stash = (html: string): string => {
    const token = `AITAMATHPLACEHOLDER${idx++}END`;
    placeholders.push({ token, html });
    return token;
  };

  // Protect fenced code blocks and inline code spans before processing dollar math.
  const codePlaceholders: Array<{ token: string; raw: string }> = [];
  let cIdx = 0;
  let protectedText = safeSource.replace(/(^|\n)(```[\s\S]*?\n```|~~~[\s\S]*?\n~~~)/g, (match) => {
    const token = `AITACODEBLOCK${cIdx++}END`;
    codePlaceholders.push({ token, raw: match });
    return token;
  });
  protectedText = protectedText.replace(/(`+)([^`\n]+?)\1/g, (match) => {
    const token = `AITACODEINLINE${cIdx++}END`;
    codePlaceholders.push({ token, raw: match });
    return token;
  });

  // Shield escaped \$ so it can never be mistaken for an inline/block math delimiter.
  const ESCAPED_DOLLAR_TOKEN = 'BIIBOESCAPEDDOLLAREND';
  protectedText = protectedText.replace(/\\\$/g, ESCAPED_DOLLAR_TOKEN);

  // Block math: $$ ... $$
  protectedText = protectedText.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
    return `\n\n${stash(`<div class="math block">${escapeHtml(expr.trim())}</div>`)}\n\n`;
  });

  // Inline math: $ ... $ (single line, non-empty, not starting/ending with space)
  protectedText = protectedText.replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/g, (_m, expr: string) => {
    return stash(`<span class="math inline">${escapeHtml(expr.trim())}</span>`);
  });

  // Restore escaped dollars and code blocks before MarkdownIt rendering
  protectedText = protectedText.replace(new RegExp(ESCAPED_DOLLAR_TOKEN, 'g'), '\\$');
  for (let i = codePlaceholders.length - 1; i >= 0; i--) {
    protectedText = protectedText.replace(codePlaceholders[i].token, () => codePlaceholders[i].raw);
  }

  let html = md.render(protectedText);
  for (const { token, html: mathHtml } of placeholders) {
    html = html.replace(new RegExp(`<p>${token}</p>`, 'g'), () => mathHtml);
    html = html.replace(new RegExp(token, 'g'), () => mathHtml);
  }
  return html;
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol',
  'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

export function renderMarkdown(text: string, documentId = ''): string {
  const cleanedSource = text.replace(PAGE_MARKER, '');
  let rawHtml = extractMathAndRender(cleanedSource);
  rawHtml = rawHtml
    .replace(/<li>\s*\[\s\]\s+/g, '<li class="task-item"><span class="md-check" aria-hidden="true"></span>')
    .replace(/<li>\s*\[[xX]\]\s+/g, '<li class="task-item is-checked"><span class="md-check is-checked" aria-hidden="true">✓</span>');

  return sanitizeHtml(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      div: ['class'],
      span: ['class'],
      li: ['class'],
      code: ['class'],
      th: ['align', 'colspan', 'rowspan'],
      td: ['align', 'colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https'],
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src || '';
        const next: Record<string, string> = {};
        if (attribs.alt !== undefined) next.alt = attribs.alt;
        if (attribs.title !== undefined) next.title = attribs.title;
        if (documentId && ASSET_PATH_RE.test(src)) {
          next.src = `/api/documents/${documentId}/assets/${src}`;
        }
        return { tagName, attribs: next };
      },
      a: (tagName, attribs) => {
        const href = (attribs.href || '').trim();
        const next: Record<string, string> = {};
        if (attribs.title !== undefined) next.title = attribs.title;
        if (href.startsWith('#')) {
          next.href = href;
        } else if (/^https?:\/\//i.test(href)) {
          next.href = href;
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
        return { tagName, attribs: next };
      },
    },
  });
}
