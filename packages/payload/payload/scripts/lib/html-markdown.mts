import { createRequire } from 'node:module';
import { join } from 'node:path';

interface HtmlConverter {
  turndown(input: object): string;
  remove(filter: string[]): HtmlConverter;
}

type ConverterConstructor = new (options: {
  headingStyle: 'atx';
}) => HtmlConverter;

interface DomElement {
  querySelector(selector: string): DomElement | null;
}

interface DomDocument extends DomElement {
  body: DomElement | null;
  documentElement: DomElement;
}

interface Domino {
  createDocument(html: string): DomDocument;
}

/** Converts one HTML page to Markdown. */
export type MarkdownConverter = (html: string) => string;

const NOISE_TAGS = [
  'script',
  'style',
  'nav',
  'header',
  'footer',
  'aside',
  'noscript',
  'svg',
  'form',
  'button',
  'iframe',
];

/** The lines a script prints after its own sentence when `loadConverter` returns null. */
export const CONVERTER_INSTALL_LINES = [
  'Install it:',
  '  npm install -D turndown',
  '  pnpm add -D turndown',
  '  pnpm add -Dw turndown   (at a pnpm workspace root, where agents run the scripts)',
];

/**
 * Builds the HTML to Markdown function from the host's own `turndown`. The page is parsed
 * with the `@mixmark-io/domino` that `turndown` depends on, resolved from `turndown`'s own
 * module context, so the DOM parser is never a regular expression and never a new dependency.
 * Only `<main>`, else `<article>`, else the body is converted, with noise tags removed.
 *
 * @returns The converter, or null when the working directory cannot resolve `turndown`.
 */
export function loadConverter(): MarkdownConverter | null {
  const requireFromCwd = createRequire(join(process.cwd(), 'package.json'));
  try {
    const Converter = requireFromCwd('turndown') as ConverterConstructor;
    const domino = createRequire(requireFromCwd.resolve('turndown'))(
      '@mixmark-io/domino',
    ) as Domino;
    return (html) => {
      const document = domino.createDocument(html);
      const scope =
        document.querySelector('main') ??
        document.querySelector('article') ??
        document.body ??
        document.documentElement;
      return new Converter({ headingStyle: 'atx' })
        .remove(NOISE_TAGS)
        .turndown(scope);
    };
  } catch {
    return null;
  }
}
