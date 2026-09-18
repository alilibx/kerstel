export interface FrontMatter {
  title: string;
  description: string;
  /** Pages with section "docs" appear in the docs sub-navigation. */
  section?: string;
  /** Sort key within a section. */
  order?: number;
}

export interface ParsedPage {
  meta: FrontMatter;
  body: string;
}

const FENCE = "---";

/**
 * Splits a Markdown page into front matter and body.
 * Front matter is a `---` fenced block of flat `key: value` lines. No nesting,
 * no quoting, no YAML. `file` is used only for error messages.
 */
export function parseFrontMatter(source: string, file: string): ParsedPage {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== FENCE) {
    throw new Error(`${file}: missing front matter fence on line 1`);
  }
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) {
    throw new Error(`${file}: front matter never closed`);
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`${file}: bad front matter line "${line}"`);
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const { title, description, section, order } = raw;
  if (!title) throw new Error(`${file}: front matter needs a title`);
  if (!description) throw new Error(`${file}: front matter needs a description`);

  const meta: FrontMatter = { title, description };
  if (section) meta.section = section;
  if (order !== undefined) {
    const n = Number(order);
    if (!Number.isInteger(n)) throw new Error(`${file}: order must be an integer, got "${order}"`);
    meta.order = n;
  }

  return { meta, body: lines.slice(end + 1).join("\n") };
}
