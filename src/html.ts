/**
 * Shared HTML → plain-text stripping utility.
 *
 * Two variants:
 *   stripHtml()     — safe for content that may be round-tripped back into HTML
 *                     rendering contexts (e.g. Azure DevOps). Does NOT decode
 *                     &lt; / &gt; to prevent reintroducing <script> etc.
 *   stripHtmlFull() — decodes all common entities including angle brackets.
 *                     Use when the output is plain text only (logs, display).
 */

/**
 * Iteratively strip HTML tags, converting block elements to newlines.
 * Handles list items for readable plain-text output.
 */
function stripTags(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<[^>]+>/g, '');
  } while (text !== previous);
  return text;
}

/**
 * Strip HTML tags from Azure rich-text fields.
 *
 * Does NOT decode &lt; / &gt; — this is intentional to prevent XSS when
 * the output is later embedded back into HTML (e.g. Azure TC descriptions
 * that travel through push → pull cycles).
 */
export function stripHtml(html: string): string {
  return stripTags(html)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip HTML and decode all common entities including angle brackets.
 *
 * Use only when the result is consumed as plain text and never re-rendered
 * as HTML (e.g. terminal display, AI prompts, story context feeds).
 */
export function stripHtmlFull(html: string | undefined): string | undefined {
  if (!html) return undefined;

  const text = stripTags(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text || undefined;
}
