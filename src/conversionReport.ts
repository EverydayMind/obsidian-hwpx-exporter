import { L } from "./locale";
/**
 * Conversion report: what the converter could not express as written, so a
 * user (Obsidian notice), a script (convertString result) or an agent tool
 * (pure JSON, DECISIONS 6) can see it. The converter still logs to the
 * console for developers; this is the user-facing record.
 */

export type ConversionWarningCode =
    | 'body_start_controls_unused'
    | 'image_missing'
    | 'image_remote'
    | 'image_blocked'
    | 'image_limit'
    | 'image_unreadable'
    | 'render_capture_disabled'
    | 'render_capture_failed'
    | 'render_capture_mapping_failed'
    | 'render_capture_unbound'
    | 'table_template_fallback'
    | 'table_skipped'
    | 'table_row_page_break'
    | 'style_fallback'
    | 'style_variant_missing'
    | 'style_variant_name_invalid'
    | 'style_variant_unsupported'
    | 'control_chars_removed'
    | 'counter_out_of_range'
    | 'counter_token_split'
    | 'emphasis_literal'
    | 'literal_syntax'
    | 'footnote_undefined'
    | 'table_parse_mismatch'
    | 'template_marker_ignored'
    | 'template_marker_duplicate'
    | 'template_option_unknown'
    | 'meta_missing';

export interface ConversionWarning {
    code: ConversionWarningCode;
    /** One Korean sentence for people. */
    message: string;
    count: number;
    /** Up to MAX_EXAMPLES distinct samples (image paths, marker names, …). */
    examples: string[];
}

export interface ConversionReport {
    warnings: ConversionWarning[];
}

const MAX_EXAMPLES = 5;

export class ConversionReportCollector {
    private readonly warnings = new Map<ConversionWarningCode, ConversionWarning>();

    add(code: ConversionWarningCode, message: string, example?: string, count = 1): void {
        if (count <= 0) return;
        let warning = this.warnings.get(code);
        if (!warning) {
            warning = { code, message, count: 0, examples: [] };
            this.warnings.set(code, warning);
        }
        warning.count += count;
        if (example !== undefined && warning.examples.length < MAX_EXAMPLES && !warning.examples.includes(example)) {
            warning.examples.push(example);
        }
    }

    merge(report: ConversionReport): void {
        for (const warning of report.warnings) {
            const [first, ...others] = warning.examples;
            this.add(warning.code, warning.message, first, warning.count);
            const merged = this.warnings.get(warning.code)!;
            for (const example of others) {
                if (merged.examples.length < MAX_EXAMPLES && !merged.examples.includes(example)) {
                    merged.examples.push(example);
                }
            }
        }
    }

    toJSON(): ConversionReport {
        return { warnings: [...this.warnings.values()].map((w) => ({ ...w, examples: [...w.examples] })) };
    }
}

const MAX_SUMMARY_EXAMPLES = 2;
const MAX_EXAMPLE_CHARS = 40;

function truncateExample(example: string): string {
    const chars = [...example];
    return chars.length > MAX_EXAMPLE_CHARS ? `${chars.slice(0, MAX_EXAMPLE_CHARS).join('')}…` : example;
}

/** Short summary for a notice, e.g. "그림을 찾지 못함 2건 (예: a.png) · 표 템플릿 규칙 없음". */
export function summarizeReport(report: ConversionReport, maxItems = 3): string {
    const parts = report.warnings.slice(0, maxItems).map((w) => {
        const base = w.count > 1 ? L({ ko: `${w.message} ${w.count}건`, en: `${w.message} ${w.count} item(s)` }) : w.message;
        if (w.examples.length === 0) return base;
        const examples = w.examples.slice(0, MAX_SUMMARY_EXAMPLES).map(truncateExample).join(', ');
        return base + L({ ko: ` (예: ${examples})`, en: ` (e.g. ${examples})` });
    });
    const rest = report.warnings.length - parts.length;
    return rest > 0 ? L({ ko: `${parts.join(' · ')} 외 ${rest}종`, en: `${parts.join(' · ')} plus ${rest} other type(s)` }) : parts.join(' · ');
}
