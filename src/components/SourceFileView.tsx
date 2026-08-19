/**
 * Syntax-highlighted source viewer for the investigator's code tools.
 *
 * highlight.js is loaded lazily (dynamic import) so it stays out of the
 * main bundle — the sandboxed iframe's CSP is fine with it because the
 * chunk is same-origin. The whole file is highlighted once, then split
 * into lines (carrying open spans across newlines) so we can render a
 * line-number gutter and give grep-matched lines a distinct background.
 */
import { useEffect, useMemo, useState } from 'react';
import s from './SourceFileView.module.css';
import 'highlight.js/styles/github.css';

const EXT_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', go: 'go', py: 'python', rb: 'ruby',
  rs: 'rust', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'cpp',
  hpp: 'cpp', swift: 'swift', scala: 'scala', sh: 'bash', bash: 'bash',
  zsh: 'bash', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  html: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
  md: 'markdown', toml: 'ini', ini: 'ini', proto: 'protobuf',
  gradle: 'groovy', groovy: 'groovy', dart: 'dart', lua: 'lua',
};

/** Map a file path to a highlight.js language id (undefined ⇒ auto-detect). */
function extToLang(path: string): string | undefined {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? undefined : EXT_LANG[base.slice(dot + 1)];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split highlight.js output into per-line HTML, re-opening any spans that
 * straddle a newline so each line is self-contained (a multi-line string
 * or comment stays highlighted line-by-line).
 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let line = '';
  const reopen = () => stack.join('');
  const close = () => stack.map(() => '</span>').join('');
  const tokenRe = /<span[^>]*>|<\/span>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const tok = m[0];
    if (tok.startsWith('<span')) {
      stack.push(tok);
      line += tok;
    } else if (tok === '</span>') {
      stack.pop();
      line += tok;
    } else {
      const parts = tok.split('\n');
      for (let i = 0; i < parts.length; i++) {
        line += parts[i];
        if (i < parts.length - 1) {
          line += close();
          lines.push(line);
          line = reopen();
        }
      }
    }
  }
  line += close();
  lines.push(line);
  return lines;
}

/** Lazily highlight the whole file; null until the highlighter loads (or
 *  on failure), so callers fall back to a plain, escaped render. */
function useHighlightedLines(content: string, lang: string | undefined): string[] | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    import('highlight.js/lib/common')
      .then((mod) => {
        if (cancelled) return;
        const hljs = (mod as unknown as { default: typeof import('highlight.js').default }).default;
        try {
          const res =
            lang && hljs.getLanguage(lang)
              ? hljs.highlight(content, { language: lang, ignoreIllegals: true })
              : hljs.highlightAuto(content);
          setHtml(res.value);
        } catch {
          setHtml(null);
        }
      })
      .catch(() => setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [content, lang]);
  return useMemo(
    () => (html == null ? null : splitHighlightedLines(html)),
    [html],
  );
}

export interface SourceFileViewProps {
  content: string;
  path: string;
  /** 1-based line numbers to emphasize (e.g. grep matches for this file). */
  highlight?: ReadonlySet<number>;
  /** Fill the container (modal) instead of the capped inline height. */
  full?: boolean;
}

export function SourceFileView({ content, path, highlight, full }: SourceFileViewProps) {
  const highlighted = useHighlightedLines(content, extToLang(path));
  const lines = useMemo(
    () => highlighted ?? content.split('\n').map(escapeHtml),
    [highlighted, content],
  );
  return (
    <div className={`${s.fileView} ${full ? s.full : ''}`}>
      {lines.map((html, i) => {
        const n = i + 1;
        const hot = highlight?.has(n);
        return (
          <div key={i} className={`${s.row} ${hot ? s.rowHot : ''}`}>
            <span className={s.ln}>{n}</span>
            <code
              className={s.code}
              dangerouslySetInnerHTML={{ __html: html === '' ? ' ' : html }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function SourceFileModal({
  content,
  path,
  highlight,
  onClose,
}: {
  content: string;
  path: string;
  highlight?: ReadonlySet<number>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={s.backdrop} onClick={onClose} role="presentation">
      <div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={path}
      >
        <div className={s.modalHeader}>
          <code className={s.modalPath}>{path}</code>
          <button type="button" className={s.modalClose} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className={s.modalBody}>
          <SourceFileView content={content} path={path} highlight={highlight} full />
        </div>
      </div>
    </div>
  );
}
