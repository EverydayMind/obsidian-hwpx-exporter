/**
 * Template marker grammar (plan 3.2): `{{KIND[:arg][|option[=value]]…}}`.
 *
 * Examples: `{{H1|pageBreak}}`, `{{H3|num=%1.%2.%3.}}`, `{{H2:1.|strip}}`,
 * `{{TABLE|width=avail}}`, `{{BODY:요약}}` (variant, plan 3.6).
 *
 * The loader reads options once, here, and rewrites each marker in the
 * template XML to its option-free form (`{{H1}}`, `{{H2:1.:strip}}`), so the
 * style lookups that find a marker by its text keep working. Markers without
 * `|` are left as written (legacy syntax stays valid). `{{META:…|format=…}}`
 * is filled in before this runs.
 */

export type MarkerOptions = Record<string, string | true>;

export interface ParsedMarker {
    /** Option-free marker text as it stays in the template XML. */
    canonical: string;
    kind: string;
    arg: string | null;
    options: MarkerOptions;
}

const HEADING = /^H[1-9]$/;
// Options each marker kind understands; anything else is reported and ignored.
const OPTIONS_BY_KIND: Array<[RegExp, string[]]> = [
    [HEADING, ['pageBreak', 'num', 'strip', 'keep', 'list']],
    [/^TABLE$/, ['width', 'columns', 'pageBreak']],
    [/^QUOTE(?:_[A-Z0-9]+)?$/, ['callouts', 'emoji', 'lead']],
];

/** Parses `KIND[:arg]|opt…` (the text between `{{` and `}}`). Null when it has no options or is not a named marker. */
export function parseMarkerOptions(inner: string): (ParsedMarker & { unknown: string[] }) | null {
    if (!inner.includes('|')) return null;
    const [head, ...parts] = inner.split('|');
    // Prefix markers such as {{|}} or {{□}} are not named markers.
    const match = /^([A-Z][\p{L}\p{N}_]*)(?::(.+))?$/u.exec(head);
    if (!match) return null;
    const kind = match[1];
    let arg = match[2] ?? null;
    const options: MarkerOptions = {};
    for (const part of parts) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const key = (eq < 0 ? part : part.slice(0, eq)).trim();
        if (key) options[key] = eq < 0 ? true : unescapeXmlText(part.slice(eq + 1));
    }
    const allowed = OPTIONS_BY_KIND.find(([pattern]) => pattern.test(kind))?.[1] ?? [];
    const unknown = Object.keys(options).filter((key) => !allowed.includes(key));

    // {{H2:1.|strip}} is the new spelling of the numbered-heading rule {{H2:1.:strip}}.
    let canonicalHead = head;
    if (HEADING.test(kind) && arg && !arg.includes(':') && (options.strip || options.keep)) {
        canonicalHead = `${kind}:${arg}:${options.strip ? 'strip' : 'keep'}`;
        arg = `${arg}:${options.strip ? 'strip' : 'keep'}`;
    }
    return { canonical: `{{${canonicalHead}}}`, kind, arg, options, unknown };
}

/** Invalid named variants only; numbered/prefix headings and other marker families keep their grammar. */
export function invalidStyleVariantSuggestion(marker: string): string | null {
    const parsed = parseMarkerOptions(marker.slice(2, -2));
    // Heading keep/strip options belong to the heading-prefix grammar.
    if (parsed && HEADING.test(parsed.kind) && parsed.arg?.includes(':')) return null;
    const match = /^\{\{((?:H[1-9]|BODY|CODE|QUOTE|HR|CAPTION|TABLE_CAPTION|FOOTNOTE|CELL_[A-Z_]+):)([^{}:|<>]+)((?:\|[^{}<>]*)?)\}\}$/.exec(marker);
    if (!match || !/\s/.test(match[2])) return null;
    return `{{${match[1]}${match[2].replace(/\s+/g, '_')}${match[3]}}}`;
}

export function invalidStyleVariantMarkers(xml: string): Array<{ marker: string; suggestion: string }> {
    const invalid = new Map<string, string>();
    for (const match of xml.matchAll(/\{\{[^{}<>]+\}\}/g)) {
        const suggestion = invalidStyleVariantSuggestion(match[0]);
        if (suggestion) invalid.set(match[0], suggestion);
    }
    return [...invalid].map(([marker, suggestion]) => ({ marker, suggestion }));
}

export function normalizeTemplateMarkers(xml: string): {
    xml: string;
    /** Canonical marker text → its options (first definition wins). */
    options: Map<string, MarkerOptions>;
    /** Markers (as written) that carried options their kind does not understand. */
    unknownOptions: string[];
} {
    const options = new Map<string, MarkerOptions>();
    const unknownOptions: string[] = [];
    if (!xml.includes('|')) return { xml, options, unknownOptions };
    const normalized = xml.replace(/\{\{([^{}<>\r\n]{1,120})\}\}/g, (marker, inner: string) => {
        if (invalidStyleVariantSuggestion(marker)) return marker;
        const parsed = parseMarkerOptions(inner);
        if (!parsed) return marker;
        if (!options.has(parsed.canonical)) options.set(parsed.canonical, parsed.options);
        if (parsed.unknown.length > 0) unknownOptions.push(unescapeXmlText(marker));
        return parsed.canonical;
    });
    return { xml: normalized, options, unknownOptions };
}

/** true / yes / on / 1 (or a bare option) → true; no / off / false / 0 → false. */
export function optionFlag(value: string | true | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    if (value === true) return true;
    return !/^(?:no|off|false|0)$/i.test(value.trim());
}

function unescapeXmlText(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&amp;/g, '&');
}
