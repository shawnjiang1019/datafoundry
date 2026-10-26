import { readFileSync, statSync } from "node:fs";

/**
 * D-Trail environment annotation, as exported by `dtrail-annotate --export-agent-json`: per table,
 * the sampled column roles (eligibility flags, competing measures, identifiers) and the metadata
 * links to other tables. Everything here is advisory: it enriches inspect_schema / preview_table
 * results and adds warnings to run_sql_readonly results, and never blocks or rewrites a call.
 */
export type EnvAnnotationColumn = {
  type?: string;
  roles?: string[];
  role_details?: {
    eligibility_flag?: { keep_value?: string };
    competing_measures?: { group?: string[] };
  };
  value_sample?: string[];
  cardinality?: string;
};

export type EnvAnnotationLink = {
  column: string;
  other_table: string;
  other_column: string;
  kind: string;
  signals?: string[];
  score?: number | null;
};

/**
 * Verbatim text from the source's own README / notes tables (deterministic, with its origin).
 * `role` says who wrote it: "stated" (the authors' statements about the data: footnotes, README
 * rows), "context" (titles, sections, source lines) or "ingest" (notes about ingest's own
 * conversions). Entries without a role are shown as context.
 */
export type EnvAnnotationTextEntry = { kind?: string; text: string; source?: string; role?: string };

/** One model-written sentence: "checked" (numbers/values matched its facts) or "inferred". */
export type EnvAnnotationClaim = { text: string; verdict?: string };

/** A soft table edge seen from one table (table_edges layer): another table it probably relates to. */
export type EnvAnnotationRelatedTable = {
  other_table: string;
  /** Share of this table's linked columns that reach the other table (m / n). */
  weight: number;
  /** Column pairs, this table's column first. */
  via: [string, string][];
  /** Every link is from value overlap alone: the names differ (a renamed key). */
  value_only?: boolean;
};

export type EnvAnnotationTable = {
  columns: Record<string, EnvAnnotationColumn>;
  links?: EnvAnnotationLink[];
  /** Present only with the `author_text` layer enabled. */
  author_text?: { table: EnvAnnotationTextEntry[]; columns: Record<string, EnvAnnotationTextEntry[]> };
  /** Present only with the `descriptions` layer enabled. */
  descriptions?: { summary?: EnvAnnotationClaim; columns: Record<string, EnvAnnotationClaim> };
  /** Present only with the `table_edges` layer enabled. */
  related_tables?: EnvAnnotationRelatedTable[];
};

export type EnvAnnotation = {
  environment_id?: string;
  tables: Record<string, EnvAnnotationTable>;
};

/** Environment variable naming the exported annotation file the runtime attaches to every run. */
export const ENV_ANNOTATION_PATH_VARIABLE = "DF_ENV_ANNOTATION_PATH";

/**
 * Optional annotation layers to show beyond roles and links, comma-separated: `author_text`
 * (the source's own README / notes text, verbatim) and `descriptions` (model-written, labelled).
 * Unset or empty shows neither, so runs keep exactly the base annotation.
 */
export const ENV_ANNOTATION_LAYERS_VARIABLE = "DF_ENV_ANNOTATION_LAYERS";
export type EnvAnnotationLayer = "author_text" | "descriptions" | "table_edges";
const KNOWN_LAYERS: readonly EnvAnnotationLayer[] = ["author_text", "descriptions", "table_edges"];

/**
 * Optional character budget for the annotation block in one tool result (default 2,500). Above
 * the default the per-table limits below are lifted too, so only the budget decides what fits.
 */
export const ENV_ANNOTATION_MAX_CHARS_VARIABLE = "DF_ENV_ANNOTATION_MAX_CHARS";

const DEFAULT_MAX_ANNOTATION_CHARS = 2500;
/** Per-table limits, applied only at (or below) the default budget. */
const MAX_LINKS_PER_TABLE = 6;
const MAX_AUTHOR_TEXT_CHARS = 400;
const MAX_DESCRIBED_COLUMNS = 8;
const MAX_RELATED_TABLES = 4;
const ANNOTATION_NOTE =
  "D-Trail environment annotation. Roles, links and model descriptions come from sampled metadata "
  + "(advisory; verify against the data); author_stated lines are the source's own documentation.";
const AUTHOR_STATED_NOTE =
  "author_stated is the source authors' own statements about the data (footnotes, README rows), "
  + "copied word for word: facts about how the numbers were counted and defined. Each line ends with "
  + "[kind, where]: notes#N is row N of the table's <table>__notes companion table.";
const AUTHOR_TEXT_NOTE = "author_text is the source's titles, sections and source lines, copied word for word.";
const INGEST_NOTES_NOTE =
  "ingest_notes were written while loading the files (type conversions, moved rows), not by the authors.";
const DESCRIPTIONS_NOTE =
  "model_descriptions are model-written readings of the facts, not facts: [inferred] is an "
  + "interpretation; [checked] only had its numbers and quoted values matched to the facts. "
  + "Verify before relying on either.";
const RELATED_TABLES_NOTE =
  "related_tables are soft edges rolled up from unverified column links (names, formats, sampled "
  + "value overlap): candidates to check, not confirmed joins. Verify with a join before relying on one.";

/** The layers named by DF_ENV_ANNOTATION_LAYERS (unknown names are ignored). */
export const envAnnotationLayersFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): EnvAnnotationLayer[] => {
  const named = new Set((env[ENV_ANNOTATION_LAYERS_VARIABLE] ?? "").split(",").map((part) => part.trim()));
  return KNOWN_LAYERS.filter((layer) => named.has(layer));
};

/** The budget named by DF_ENV_ANNOTATION_MAX_CHARS; unset or not a positive integer gives the default. */
export const envAnnotationMaxCharsFromEnvironment = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = Number.parseInt(env[ENV_ANNOTATION_MAX_CHARS_VARIABLE] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ANNOTATION_CHARS;
};

/**
 * Accept the exporter's `{environment_id, tables: {...}, author_text?, descriptions?, table_edges?}`
 * file; anything else is ignored. The optional sections are attached to their tables only for the
 * enabled `layers` (default: DF_ENV_ANNOTATION_LAYERS).
 */
export const parseEnvAnnotation = (
  value: unknown,
  layers: readonly EnvAnnotationLayer[] = envAnnotationLayersFromEnvironment()
): EnvAnnotation | undefined => {
  if (!isRecord(value) || !isRecord(value.tables)) {
    return undefined;
  }
  const authorText = layers.includes("author_text") && isRecord(value.author_text) ? value.author_text : {};
  const described = layers.includes("descriptions") && isRecord(value.descriptions)
    && isRecord(value.descriptions.tables)
    ? value.descriptions.tables
    : {};
  const related = layers.includes("table_edges") ? relatedTablesByTable(value.table_edges) : new Map();
  const tables: Record<string, EnvAnnotationTable> = {};
  for (const [name, table] of Object.entries(value.tables)) {
    if (isRecord(table) && isRecord(table.columns)) {
      const text = parseAuthorText(authorText[name]);
      const descriptions = parseDescriptions(described[name]);
      const relatedTables = related.get(name);
      tables[name] = {
        columns: table.columns as Record<string, EnvAnnotationColumn>,
        links: Array.isArray(table.links) ? table.links.filter(isLink) : [],
        ...(text ? { author_text: text } : {}),
        ...(descriptions ? { descriptions } : {}),
        ...(relatedTables ? { related_tables: relatedTables } : {})
      };
    }
  }
  return {
    ...(typeof value.environment_id === "string" ? { environment_id: value.environment_id } : {}),
    tables
  };
};

/** The exporter's `table_edges.edges` (left/right, directional weights, `via` pairs), seen from each end. */
const relatedTablesByTable = (value: unknown): Map<string, EnvAnnotationRelatedTable[]> => {
  const byTable = new Map<string, EnvAnnotationRelatedTable[]>();
  const edges = isRecord(value) && Array.isArray(value.edges) ? value.edges.filter(isEdge) : [];
  for (const edge of edges) {
    const valueOnly = edge.value_only === true ? { value_only: true } : {};
    const add = (table: string, entry: EnvAnnotationRelatedTable) =>
      byTable.set(table, [...(byTable.get(table) ?? []), entry]);
    add(edge.left, {
      other_table: edge.right,
      weight: edge.left_to_right,
      via: edge.via.map(([a, b]) => [a, b] as [string, string]),
      ...valueOnly
    });
    add(edge.right, {
      other_table: edge.left,
      weight: edge.right_to_left,
      via: edge.via.map(([a, b]) => [b, a] as [string, string]),
      ...valueOnly
    });
  }
  return byTable;
};

type ExportedEdge = {
  left: string;
  right: string;
  left_to_right: number;
  right_to_left: number;
  via: [string, string][];
  value_only?: boolean;
};

const isEdge = (value: unknown): value is ExportedEdge =>
  isRecord(value)
  && typeof value.left === "string"
  && typeof value.right === "string"
  && typeof value.left_to_right === "number"
  && typeof value.right_to_left === "number"
  && Array.isArray(value.via)
  && value.via.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((c) => typeof c === "string"));

const parseAuthorText = (value: unknown): EnvAnnotationTable["author_text"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const table = Array.isArray(value.table) ? value.table.filter(isTextEntry) : [];
  const columns: Record<string, EnvAnnotationTextEntry[]> = {};
  for (const [column, entries] of Object.entries(isRecord(value.columns) ? value.columns : {})) {
    const kept = Array.isArray(entries) ? entries.filter(isTextEntry) : [];
    if (kept.length > 0) {
      columns[column] = kept;
    }
  }
  return table.length > 0 || Object.keys(columns).length > 0 ? { table, columns } : undefined;
};

const parseDescriptions = (value: unknown): EnvAnnotationTable["descriptions"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const summary = isClaim(value.summary) ? value.summary : undefined;
  const columns: Record<string, EnvAnnotationClaim> = {};
  for (const [column, claim] of Object.entries(isRecord(value.columns) ? value.columns : {})) {
    if (isClaim(claim)) {
      columns[column] = claim;
    }
  }
  return summary || Object.keys(columns).length > 0 ? { ...(summary ? { summary } : {}), columns } : undefined;
};

const fileCache = new Map<string, { mtimeMs: number; annotation: EnvAnnotation | undefined }>();

/** Load an exported annotation file; unreadable or malformed files yield undefined (advisory input). */
export const loadEnvAnnotationFile = (
  path: string,
  layers: readonly EnvAnnotationLayer[] = envAnnotationLayersFromEnvironment()
): EnvAnnotation | undefined => {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const key = `${path}\u0000${layers.join(",")}`;
    const cached = fileCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.annotation;
    }
    const annotation = parseEnvAnnotation(JSON.parse(readFileSync(path, "utf8")), layers);
    fileCache.set(key, { mtimeMs, annotation });
    return annotation;
  } catch {
    return undefined;
  }
};

/** The annotation named by DF_ENV_ANNOTATION_PATH, or undefined when the variable is unset. */
export const envAnnotationFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): EnvAnnotation | undefined => {
  const path = env[ENV_ANNOTATION_PATH_VARIABLE]?.trim();
  return path ? loadEnvAnnotationFile(path, envAnnotationLayersFromEnvironment(env)) : undefined;
};

type TableSummary = {
  eligibility_flags?: { column: string; keep_value?: string }[];
  competing_measures?: string[][];
  identifiers?: string[];
  /** The authors' statements about the data, verbatim, with kind and origin (author_text layer);
   * shown as lines by `statedLine`. */
  author_stated?: EnvAnnotationTextEntry[];
  links?: string[];
  /** Soft table edges, strongest first (table_edges layer). */
  related_tables?: string[];
  /** Titles, sections and source lines, verbatim (author_text layer). */
  author_text?: string[];
  /** Ingest's notes on its own conversions (author_text layer). */
  ingest_notes?: string[];
  /** Model-written sentences, each ending in its verdict (descriptions layer). */
  model_descriptions?: { table?: string; columns?: Record<string, string> };
};

/**
 * The annotation for the named tables only, compact and capped at `maxChars`: tables with an
 * eligibility flag come first, then the rest in the given order. To fit, links (and related tables)
 * are dropped first, then the optional text layers, and whole tables only last. The authors'
 * statements (`author_stated`) outlast every text layer and are dropped only to avoid dropping a
 * table; one shared by several shown tables is listed once (`author_stated_shared`). A budget
 * above the default also lifts the per-table limits.
 * Undefined when no named table has anything to report.
 */
export const envAnnotationForTables = (
  annotation: EnvAnnotation,
  tableNames: string[],
  maxChars = envAnnotationMaxCharsFromEnvironment()
): Record<string, unknown> | undefined => {
  const limits = maxChars > DEFAULT_MAX_ANNOTATION_CHARS ? UNLIMITED : PER_TABLE_LIMITS;
  const summaries = tableNames.flatMap((name) => {
    const table = lookupTable(annotation, name);
    const summary = table ? summarizeTable(table, limits) : undefined;
    return summary ? [{ name, summary }] : [];
  });
  if (summaries.length === 0) {
    return undefined;
  }
  const ordered = [
    ...summaries.filter((entry) => entry.summary.eligibility_flags),
    ...summaries.filter((entry) => !entry.summary.eligibility_flags)
  ];
  const render = (entries: typeof ordered, withLinks: boolean, withText: boolean, withStated = true) => {
    // A statement on several shown tables (a footnote repeated across a report's sections) is
    // listed once, with where each table's copy comes from, instead of under each.
    const statedBy = new Map<string, { kind?: string; from: string[] }>();
    for (const { name, summary } of withStated ? entries : []) {
      for (const entry of summary.author_stated ?? []) {
        const seen = statedBy.get(entry.text) ?? { ...(entry.kind ? { kind: entry.kind } : {}), from: [] };
        statedBy.set(entry.text, { ...seen, from: [...seen.from, entry.source ?? name] });
      }
    }
    const shared = [...statedBy].filter(([, { from }]) => from.length > 1);
    const tables = Object.fromEntries(entries.flatMap(({ name, summary }) => {
      const { author_stated, links, related_tables, author_text, ingest_notes, model_descriptions, ...rest } = summary;
      const ownStated = (author_stated ?? [])
        .filter((entry) => (statedBy.get(entry.text)?.from.length ?? 0) === 1)
        .map((entry) => statedLine(entry, name));
      const shown = {
        ...rest,
        ...(withStated && ownStated.length ? { author_stated: ownStated } : {}),
        ...(withLinks && links ? { links } : {}),
        ...(withLinks && related_tables ? { related_tables } : {}),
        ...(withText && author_text ? { author_text } : {}),
        ...(withText && ingest_notes ? { ingest_notes } : {}),
        ...(withText && model_descriptions ? { model_descriptions } : {})
      };
      return Object.keys(shown).length > 0 ? [[name, shown]] : [];
    }));
    const shownText = (key: "author_text" | "ingest_notes" | "model_descriptions") =>
      withText && entries.some((entry) => entry.summary[key]);
    const omitted = ordered.length - entries.length;
    const shownRelated = withLinks && entries.some((entry) => entry.summary.related_tables);
    return {
      note: ANNOTATION_NOTE,
      ...(statedBy.size > 0 ? { author_stated_note: AUTHOR_STATED_NOTE } : {}),
      ...(shared.length > 0
        ? { author_stated_shared: shared.map(([text, { kind, from }]) => ({ text, ...(kind ? { kind } : {}), from })) }
        : {}),
      ...(shownRelated ? { related_tables_note: RELATED_TABLES_NOTE } : {}),
      ...(shownText("author_text") ? { author_text_note: AUTHOR_TEXT_NOTE } : {}),
      ...(shownText("ingest_notes") ? { ingest_notes_note: INGEST_NOTES_NOTE } : {}),
      ...(shownText("model_descriptions") ? { model_descriptions_note: DESCRIPTIONS_NOTE } : {}),
      tables,
      ...(omitted > 0 ? { omitted_tables: omitted, hint: "inspect_schema with table_names shows a table's annotation" } : {})
    };
  };
  const fits = (rendered: unknown): boolean => JSON.stringify(rendered).length <= maxChars;
  // Full text, then compact text, then the base annotation (links kept), then the base with only
  // the authors' statements, before cutting further -- so enabling a text layer never shows less
  // than the base would, and no table is dropped to make room for statements.
  const compact = ordered.map(({ name, summary }) => ({ name, summary: compactText(summary) }));
  const attempts: Array<[typeof ordered, boolean, boolean, boolean]> = [
    [ordered, true, true, true],
    [ordered, false, true, true],
    [compact, true, true, true],
    [compact, false, true, true],
    [ordered, true, false, true],
    [ordered, false, false, true],
    [ordered, true, false, false]
  ];
  for (const [entries, withLinks, withText, withStated] of attempts) {
    const rendered = render(entries, withLinks, withText, withStated);
    if (fits(rendered)) {
      return rendered;
    }
  }
  const kept = [...ordered];
  let rendered = render(kept, false, false, false);
  while (kept.length > 1 && !fits(rendered)) {
    kept.pop();
    rendered = render(kept, false, false, false);
  }
  return rendered;
};

type TableLimits = { links: number; authorTextChars: number; describedColumns: number; relatedTables: number };
const PER_TABLE_LIMITS: TableLimits = {
  links: MAX_LINKS_PER_TABLE,
  authorTextChars: MAX_AUTHOR_TEXT_CHARS,
  describedColumns: MAX_DESCRIBED_COLUMNS,
  relatedTables: MAX_RELATED_TABLES
};
const UNLIMITED: TableLimits = {
  links: Infinity,
  authorTextChars: Infinity,
  describedColumns: Infinity,
  relatedTables: Infinity
};

const summarizeTable = (table: EnvAnnotationTable, limits: TableLimits): TableSummary | undefined => {
  const flags: { column: string; keep_value?: string }[] = [];
  const groups = new Map<string, string[]>();
  const identifiers: string[] = [];
  for (const [column, info] of Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))) {
    const roles = info.roles ?? [];
    if (roles.includes("eligibility_flag")) {
      const keep = info.role_details?.eligibility_flag?.keep_value;
      flags.push({ column, ...(keep ? { keep_value: keep } : {}) });
    }
    const group = info.role_details?.competing_measures?.group;
    if (roles.includes("competing_measures") && group && group.length > 1) {
      groups.set(group.join("\u0000"), group);
    }
    if (roles.includes("identifier")) {
      identifiers.push(column);
    }
  }
  const links = [...(table.links ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || linkText(a).localeCompare(linkText(b)))
    .slice(0, limits.links)
    .map(linkText);
  const relatedTables = [...(table.related_tables ?? [])]
    .sort((a, b) => b.weight - a.weight || a.other_table.localeCompare(b.other_table))
    .slice(0, limits.relatedTables)
    .map(relatedTableText);
  const authorStated = authorTextEntries(table.author_text, "stated", limits.authorTextChars);
  const authorText = authorTextEntries(table.author_text, "context", limits.authorTextChars).map((e) => e.text);
  const ingestNotes = authorTextEntries(table.author_text, "ingest", limits.authorTextChars).map((e) => e.text);
  const modelDescriptions = describedLines(table.descriptions, table.columns, limits.describedColumns);
  const summary: TableSummary = {
    ...(flags.length ? { eligibility_flags: flags } : {}),
    ...(groups.size ? { competing_measures: [...groups.values()] } : {}),
    ...(identifiers.length ? { identifiers } : {}),
    ...(authorStated.length ? { author_stated: authorStated } : {}),
    ...(links.length ? { links } : {}),
    ...(relatedTables.length ? { related_tables: relatedTables } : {}),
    ...(authorText.length ? { author_text: authorText } : {}),
    ...(ingestNotes.length ? { ingest_notes: ingestNotes } : {}),
    ...(modelDescriptions ? { model_descriptions: modelDescriptions } : {})
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
};

/** The entries with `role` (missing roles count as "context"): table-level text, then column
 * notes, verbatim, whole entries only, up to `maxChars` of text in all. */
const authorTextEntries = (
  text: EnvAnnotationTable["author_text"],
  role: string,
  maxChars: number
): EnvAnnotationTextEntry[] => {
  if (!text) {
    return [];
  }
  const hasRole = (entry: EnvAnnotationTextEntry) => (entry.role ?? "context") === role;
  const all = [...text.table.filter(hasRole), ...Object.values(text.columns).flatMap((entries) => entries.filter(hasRole))];
  const kept: EnvAnnotationTextEntry[] = [];
  let used = 0;
  for (const entry of all) {
    if (used + entry.text.length > maxChars) {
      break;  // never a cut line: a partial quote would change what the source says
    }
    kept.push(entry);
    used += entry.text.length;
  }
  return kept;
};

/**
 * An author statement as shown: the verbatim text, then `[kind, where]` -- e.g. `[footnote,
 * notes#2]` for row 2 of `<table>__notes`; other origins are named in full.
 */
const statedLine = (entry: EnvAnnotationTextEntry, table: string): string => {
  const notesRow = `${table}__notes#`;
  const where = entry.source?.startsWith(notesRow) ? `notes#${entry.source.slice(notesRow.length)}` : entry.source;
  const label = [entry.kind, where].filter(Boolean).join(", ");
  return label ? `${entry.text} [${label}]` : entry.text;
};

/** Roles whose columns' descriptions are shown first, in this order. */
const DESCRIBED_ROLE_ORDER = ["eligibility_flag", "identifier"];

/** Sort key for a described column: by DESCRIBED_ROLE_ORDER, then columns without roles, and
 * other roles (competing measures, many look-alike sentences) last. */
const rolePriority = (column: EnvAnnotationColumn | undefined): number => {
  const roles = column?.roles ?? [];
  const ranked = DESCRIBED_ROLE_ORDER.findIndex((role) => roles.includes(role));
  return ranked >= 0 ? ranked : DESCRIBED_ROLE_ORDER.length + (roles.length > 0 ? 1 : 0);
};

/**
 * The table sentence and up to `maxColumns` column sentences, each tagged [verdict];
 * columns ordered by role (eligibility flags first), then name.
 */
const describedLines = (
  described: EnvAnnotationTable["descriptions"],
  columnInfo: Record<string, EnvAnnotationColumn>,
  maxColumns: number
): TableSummary["model_descriptions"] | undefined => {
  if (!described) {
    return undefined;
  }
  const tag = (claim: EnvAnnotationClaim): string => `${claim.text} [${claim.verdict ?? "inferred"}]`;
  const columns = Object.entries(described.columns)
    .sort(([a], [b]) => rolePriority(columnInfo[a]) - rolePriority(columnInfo[b]) || a.localeCompare(b))
    .slice(0, maxColumns);
  return {
    ...(described.summary ? { table: tag(described.summary) } : {}),
    ...(columns.length ? { columns: Object.fromEntries(columns.map(([name, claim]) => [name, tag(claim)])) } : {})
  };
};

/** The compact form of a table's text layers: the table sentence, the first two column
 * sentences (already ordered by role), and the first line of author text (the authors'
 * statements are kept whole; ingest notes are left out). */
const compactText = (summary: TableSummary): TableSummary => {
  const { author_text, ingest_notes: _ingestNotes, model_descriptions, ...rest } = summary;
  const columns = Object.entries(model_descriptions?.columns ?? {}).slice(0, 2);
  const compactDescriptions = model_descriptions
    ? {
        ...(model_descriptions.table ? { table: model_descriptions.table } : {}),
        ...(columns.length ? { columns: Object.fromEntries(columns) } : {})
      }
    : undefined;
  return {
    ...rest,
    ...(author_text?.length ? { author_text: author_text.slice(0, 1) } : {}),
    ...(compactDescriptions && Object.keys(compactDescriptions).length ? { model_descriptions: compactDescriptions } : {})
  };
};

/** e.g. `mmc7 via idx=idx, MLH1=MLH1 (2 more); 40% of this table's linked columns` */
const relatedTableText = (related: EnvAnnotationRelatedTable): string => {
  const pairs = related.via.slice(0, 3).map(([here, there]) => `${here}=${there}`).join(", ");
  const more = related.via.length > 3 ? ` (${related.via.length - 3} more)` : "";
  const share = `${Math.round(related.weight * 100)}% of this table's linked columns`;
  return `${related.other_table} via ${pairs}${more}; ${share}`
    + `${related.value_only ? "; value-only (names differ, values match)" : ""}`;
};

const linkText = (link: EnvAnnotationLink): string =>
  `${link.column} -> ${link.other_table}.${link.other_column} (${link.kind}`
  + `${link.signals?.length ? `: ${link.signals.join(", ")}` : ""})`;

/**
 * How the annotation reaches the agent. `inline` (the default) attaches it to inspect_schema and
 * preview_table results as before. `tool` keeps only the deciding roles inline in inspect_schema,
 * adds a one-line index per table, and serves everything else through the describe_tables tool.
 */
export const ENV_ANNOTATION_DELIVERY_VARIABLE = "DF_ENV_ANNOTATION_DELIVERY";
export type EnvAnnotationDelivery = "inline" | "tool";

/** The delivery named by DF_ENV_ANNOTATION_DELIVERY; anything but "tool" is "inline". */
export const envAnnotationDeliveryFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): EnvAnnotationDelivery => (env[ENV_ANNOTATION_DELIVERY_VARIABLE]?.trim() === "tool" ? "tool" : "inline");

export const DESCRIBE_TABLES_SECTIONS = [
  "roles",
  "author_stated",
  "links",
  "related_tables",
  "author_text",
  "descriptions",
  "columns"
] as const;
export type DescribeTablesSection = (typeof DESCRIBE_TABLES_SECTIONS)[number];
const DEFAULT_DESCRIBE_SECTIONS: readonly DescribeTablesSection[] = [
  "roles",
  "author_stated",
  "links",
  "related_tables",
  "author_text",
  "descriptions"
];
/** Sections dropped first when a describe_tables result does not fit its budget. */
const DESCRIBE_DROP_ORDER: readonly DescribeTablesSection[] = [
  "columns",
  "descriptions",
  "author_text",
  "links",
  "related_tables",
  "author_stated"
];
const INDEX_NOTE =
  "Deciding roles are shown inline. `more` lists what else is annotated for a table; read it with "
  + "describe_tables before querying or joining that table.";

type RoleSummary = Pick<TableSummary, "eligibility_flags" | "competing_measures" | "identifiers">;

const pickRoles = (summary: TableSummary | undefined): RoleSummary => ({
  ...(summary?.eligibility_flags ? { eligibility_flags: summary.eligibility_flags } : {}),
  ...(summary?.competing_measures ? { competing_measures: summary.competing_measures } : {}),
  ...(summary?.identifiers ? { identifiers: summary.identifiers } : {})
});

/** e.g. `describe_tables: 19 links, 1 related table, README/notes, 4 descriptions` */
const indexLine = (summary: TableSummary | undefined): string | undefined => {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const descriptions = summary?.model_descriptions;
  const described = (descriptions?.table ? 1 : 0) + Object.keys(descriptions?.columns ?? {}).length;
  const parts = [
    ...(summary?.links?.length ? [plural(summary.links.length, "link")] : []),
    ...(summary?.author_stated?.length ? [plural(summary.author_stated.length, "author statement")] : []),
    ...(summary?.related_tables?.length ? [plural(summary.related_tables.length, "related table")] : []),
    ...(summary?.author_text?.length || summary?.ingest_notes?.length ? ["README/notes"] : []),
    ...(described ? [plural(described, "description")] : [])
  ];
  return parts.length ? `describe_tables: ${parts.join(", ")}` : undefined;
};

/**
 * The inspect_schema annotation under `tool` delivery: per table, the deciding roles (eligibility
 * flags, competing measures, identifiers) plus a `more` index line naming what describe_tables
 * holds. Index lines are dropped before whole tables when even this does not fit.
 */
export const envAnnotationIndexForTables = (
  annotation: EnvAnnotation,
  tableNames: string[],
  maxChars = envAnnotationMaxCharsFromEnvironment()
): Record<string, unknown> | undefined => {
  const entries = tableNames.flatMap((name) => {
    const table = lookupTable(annotation, name);
    const summary = table ? summarizeTable(table, UNLIMITED) : undefined;
    const roles = pickRoles(summary);
    const more = indexLine(summary);
    return Object.keys(roles).length > 0 || more ? [{ name, roles, more }] : [];
  });
  if (entries.length === 0) {
    return undefined;
  }
  const ordered = [
    ...entries.filter((entry) => entry.roles.eligibility_flags),
    ...entries.filter((entry) => !entry.roles.eligibility_flags)
  ];
  const render = (kept: typeof ordered, withMore: boolean) => {
    const tables = Object.fromEntries(kept.flatMap(({ name, roles, more }) => {
      const shown = { ...roles, ...(withMore && more ? { more } : {}) };
      return Object.keys(shown).length > 0 ? [[name, shown]] : [];
    }));
    const omitted = ordered.length - kept.length;
    return {
      note: ANNOTATION_NOTE,
      describe_note: INDEX_NOTE,
      tables,
      ...(omitted > 0 ? { omitted_tables: omitted, hint: "inspect_schema with table_names shows a table's index" } : {})
    };
  };
  const fits = (rendered: unknown): boolean => JSON.stringify(rendered).length <= maxChars;
  for (const withMore of [true, false]) {
    const rendered = render(ordered, withMore);
    if (fits(rendered)) {
      return rendered;
    }
  }
  const kept = [...ordered];
  let rendered = render(kept, false);
  while (kept.length > 1 && !fits(rendered)) {
    kept.pop();
    rendered = render(kept, false);
  }
  return rendered;
};

export type DescribeTablesOptions = {
  sections?: readonly string[];
  /** Restricts the `columns` section to these column names (case-insensitive). */
  columns?: readonly string[];
  maxChars?: number;
};

/**
 * The full annotation for the named tables (the describe_tables tool): each requested section, in
 * full, with the layer notes that say how far to trust it. To fit `maxChars`, whole sections are
 * dropped in DESCRIBE_DROP_ORDER and then whole tables, and `omitted` lists what was left out, so
 * the result is always valid JSON. Unknown names are reported with close matches.
 */
export const describeTables = (
  annotation: EnvAnnotation,
  tableNames: readonly string[],
  options: DescribeTablesOptions = {}
): Record<string, unknown> => {
  const maxChars = options.maxChars ?? envAnnotationMaxCharsFromEnvironment();
  const requested = (options.sections ?? []).filter((section): section is DescribeTablesSection =>
    (DESCRIBE_TABLES_SECTIONS as readonly string[]).includes(section));
  const sections = requested.length > 0 ? requested : DEFAULT_DESCRIBE_SECTIONS;
  const found: { name: string; detail: Record<string, unknown> }[] = [];
  const unknown: { name: string; close_matches: string[] }[] = [];
  for (const name of unique([...tableNames])) {
    const table = lookupTable(annotation, name);
    if (table) {
      found.push({ name, detail: describeTable(name, table, sections, options.columns) });
    } else {
      unknown.push({ name, close_matches: closeTableNames(annotation, name) });
    }
  }
  const omitted: Record<string, string[]> = {};
  const render = (entries: typeof found) => {
    const shown = (key: string) => entries.some(({ detail }) => detail[key] !== undefined);
    return {
      note: ANNOTATION_NOTE,
      ...(shown("author_stated") ? { author_stated_note: AUTHOR_STATED_NOTE } : {}),
      ...(shown("author_text") ? { author_text_note: AUTHOR_TEXT_NOTE } : {}),
      ...(shown("ingest_notes") ? { ingest_notes_note: INGEST_NOTES_NOTE } : {}),
      ...(shown("descriptions") ? { descriptions_note: DESCRIPTIONS_NOTE } : {}),
      ...(shown("related_tables") ? { related_tables_note: RELATED_TABLES_NOTE } : {}),
      tables: Object.fromEntries(entries.map(({ name, detail }) => [name, detail])),
      ...(unknown.length > 0 ? { unknown_tables: unknown } : {}),
      ...(Object.keys(omitted).length > 0
        ? { omitted, hint: "call describe_tables for fewer tables or specific sections to see what was omitted" }
        : {})
    };
  };
  const fits = (rendered: unknown): boolean => JSON.stringify(rendered).length <= maxChars;
  const entries = found.map(({ name, detail }) => ({ name, detail: { ...detail } }));
  for (const section of DESCRIBE_DROP_ORDER) {
    if (fits(render(entries))) {
      return render(entries);
    }
    const keys = section === "author_text" ? ["author_text", "ingest_notes"] : [section];
    for (const { name, detail } of entries) {
      if (keys.some((key) => detail[key] !== undefined)) {
        keys.forEach((key) => delete detail[key]);
        omitted[name] = [...(omitted[name] ?? []), section];
      }
    }
  }
  while (entries.length > 1 && !fits(render(entries))) {
    const dropped = entries.pop()!;
    omitted[dropped.name] = ["table"];
  }
  return render(entries);
};

const describeTable = (
  name: string,
  table: EnvAnnotationTable,
  sections: readonly DescribeTablesSection[],
  columnFilter: readonly string[] | undefined
): Record<string, unknown> => {
  const summary = summarizeTable(table, UNLIMITED);
  const wanted = new Set(columnFilter?.map((column) => column.toLowerCase()));
  const columns = Object.entries(table.columns)
    .filter(([name]) => wanted.size === 0 || wanted.has(name.toLowerCase()))
    .map(([name, info]) => [name, {
      ...(info.type ? { type: info.type } : {}),
      ...(info.cardinality ? { cardinality: info.cardinality } : {}),
      ...(info.roles?.length ? { roles: info.roles } : {}),
      ...(info.value_sample?.length ? { value_sample: info.value_sample } : {})
    }]);
  const roles = pickRoles(summary);
  const detail: Record<string, unknown> = {
    ...(sections.includes("roles") && Object.keys(roles).length ? { roles } : {}),
    ...(sections.includes("author_stated") && summary?.author_stated
      ? { author_stated: summary.author_stated.map((entry) => statedLine(entry, name)) }
      : {}),
    ...(sections.includes("links") && summary?.links ? { links: summary.links } : {}),
    ...(sections.includes("related_tables") && summary?.related_tables ? { related_tables: summary.related_tables } : {}),
    ...(sections.includes("author_text") && summary?.author_text ? { author_text: summary.author_text } : {}),
    ...(sections.includes("author_text") && summary?.ingest_notes ? { ingest_notes: summary.ingest_notes } : {}),
    ...(sections.includes("descriptions") && summary?.model_descriptions ? { descriptions: summary.model_descriptions } : {}),
    ...(sections.includes("columns") && columns.length ? { columns: Object.fromEntries(columns) } : {})
  };
  return Object.keys(detail).length > 0 ? detail : { note: "nothing annotated for the requested sections" };
};

/** Up to five annotated table names that contain, or are contained in, the wanted name. */
const closeTableNames = (annotation: EnvAnnotation, name: string): string[] => {
  const wanted = name.toLowerCase().slice(name.lastIndexOf(".") + 1);
  return Object.keys(annotation.tables)
    .filter((candidate) => {
      const lower = candidate.toLowerCase();
      return lower.includes(wanted) || wanted.includes(lower.split("__").pop() ?? lower);
    })
    .slice(0, 5);
};

const unique = (values: string[]): string[] => [...new Set(values)];

export type EnvAnnotationGuard = {
  /** Advisory warnings for one SQL statement; each warning is returned at most once per guard. */
  check(sql: string): string[];
};

/**
 * Check SQL against the annotation's roles: (1) a query that reads a table with an eligibility flag
 * but never mentions the flag column, and (2) a query that uses one column of a competing-measures
 * group without its siblings. Matching is lexical (identifier boundaries, case-insensitive); a
 * column only counts for a table the query mentions. One guard per run deduplicates warnings.
 */
export const createEnvAnnotationGuard = (annotation: EnvAnnotation): EnvAnnotationGuard => {
  const issued = new Set<string>();
  return {
    check(sql: string): string[] {
      const warnings: string[] = [];
      const add = (key: string, text: string): void => {
        if (!issued.has(key)) {
          issued.add(key);
          warnings.push(text);
        }
      };
      for (const [tableName, table] of Object.entries(annotation.tables).sort(([a], [b]) => a.localeCompare(b))) {
        if (!mentions(sql, tableName)) {
          continue;
        }
        for (const [column, info] of Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))) {
          const roles = info.roles ?? [];
          if (roles.includes("eligibility_flag") && !mentions(sql, column)) {
            const keep = info.role_details?.eligibility_flag?.keep_value;
            const values = keep ? `keep ${keep}` : `values ${(info.value_sample ?? []).join(", ")}`;
            add(
              `eligibility:${tableName}:${column}`,
              `Table ${tableName} has eligibility flag ${column} (${values}) that this query does not filter; `
              + "if the question concerns samples/patients in the study, filter it"
              + (keep ? ` (${column} = ${keep}).` : ".")
            );
          }
          const group = info.role_details?.competing_measures?.group ?? [];
          if (roles.includes("competing_measures") && group.length > 1 && mentions(sql, column)) {
            // Only when no sibling is used too: a query reading several variants already chose.
            const alternatives = group.filter((name) => name !== column);
            if (alternatives.every((name) => !mentions(sql, name))) {
              add(
                `competing:${tableName}:${column}`,
                `Column ${column} of ${tableName} has competing variants: ${alternatives.join(", ")}; `
                + `confirm ${column} is the measure the question asks for.`
              );
            }
          }
        }
      }
      return warnings;
    }
  };
};

const lookupTable = (annotation: EnvAnnotation, name: string): EnvAnnotationTable | undefined => {
  const direct = annotation.tables[name];
  if (direct) {
    return direct;
  }
  const wanted = name.toLowerCase();
  const unqualified = wanted.slice(wanted.lastIndexOf(".") + 1);
  const match = Object.keys(annotation.tables).find((key) => {
    const lowered = key.toLowerCase();
    return lowered === wanted || lowered === unqualified;
  });
  return match ? annotation.tables[match] : undefined;
};

/** Whether `name` occurs in `sql` as a whole identifier (not inside a longer one), ignoring case. */
const mentions = (sql: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}($|[^A-Za-z0-9_])`, "iu").test(sql);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const isLink = (value: unknown): value is EnvAnnotationLink =>
  isRecord(value)
  && typeof value.column === "string"
  && typeof value.other_table === "string"
  && typeof value.other_column === "string"
  && typeof value.kind === "string";

const isTextEntry = (value: unknown): value is EnvAnnotationTextEntry =>
  isRecord(value) && typeof value.text === "string" && value.text.length > 0;

const isClaim = (value: unknown): value is EnvAnnotationClaim =>
  isRecord(value) && typeof value.text === "string" && value.text.length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
