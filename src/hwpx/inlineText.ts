/**
 * Plain text views of Pandoc-like inlines and metadata values.
 * Split out of markdownToHwpx.ts (plan 2.1).
 */

import type { PandocInline, InlineImage, MetaValue } from '../types';

/** Caption of a figure: the image title, else its alt text unless that is just a file name. */
export function figureCaption(image: InlineImage): string {
    const title = image.c[2][1]?.trim();
    if (title) return title;
    const alt = getPlainText(image.c[1]).trim();
    return alt && !/\.(?:png|jpe?g|gif|svg|webp|bmp)$/i.test(alt) && !/^hwpx-render-/.test(alt) ? alt : '';
}


export function metaValueToText(value: MetaValue): string {
    switch (value.t) {
        case 'MetaString': return value.c;
        case 'MetaBool': return value.c ? 'true' : 'false';
        case 'MetaInlines': return getPlainText(value.c);
        case 'MetaList': return value.c.map(metaValueToText).filter(Boolean).join(', ');
        default: return '';
    }
}


/** YYYY/YY/MM/M/DD/D tokens over a date value; other text is left as written. */
export function formatMetaDate(value: string, format: string): string {
    const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return value;
    const [, year, month, day] = match;
    return format.replace(/YYYY|YY|MM|M|DD|D/g, (token) => {
        switch (token) {
            case 'YYYY': return year;
            case 'YY': return year.slice(2);
            case 'MM': return month.padStart(2, '0');
            case 'M': return String(Number(month));
            case 'DD': return day.padStart(2, '0');
            default: return String(Number(day));
        }
    });
}


export function getPlainText(inlines: PandocInline[]): string {
    if (!Array.isArray(inlines)) return '';
    return inlines.map((item) => {
        if (item.t === 'Str') return item.c;
        if (item.t === 'Math') return item.c[1];
        if (item.t === 'Space') return ' ';
        if (['Strong', 'Emph', 'Strikeout', 'Underline', 'Superscript', 'Subscript'].includes(item.t)) {
            return getPlainText((item as { c: PandocInline[] }).c);
        }
        if (item.t === 'Span') return getPlainText(item.c[1]);
        return '';
    }).join('');
}


export function getPrefixComparableText(inlines: PandocInline[], includeOtherWrappers = false): string {
    let result = '';
    for (const item of inlines) {
        if (item.t === 'Str') {
            result += item.c;
            continue;
        }
        if (item.t === 'Space') {
            result += ' ';
            continue;
        }
        if (['Strong', 'Emph', 'Strikeout', 'Underline'].includes(item.t)
            || (includeOtherWrappers && ['Superscript', 'Subscript', 'SmallCaps'].includes(item.t))) {
            result += getPrefixComparableText((item as { c: PandocInline[] }).c, includeOtherWrappers);
            continue;
        }
        if (item.t === 'Code') {
            result += item.c[1];
            continue;
        }
        if (item.t === 'Link') {
            result += getPrefixComparableText(item.c[1], includeOtherWrappers);
            continue;
        }
        // Derived role-line splitting also crosses these formatting wrappers.
        // Keep ordinary export prefix selection unchanged.
        if (includeOtherWrappers && (item.t === 'Span' || item.t === 'Quoted')) {
            result += getPrefixComparableText(item.c[1], includeOtherWrappers);
            continue;
        }

        // An image, raw inline HTML, line break, note, or other non-text
        // inline terminates the visible prefix. Text collected before it is
        // still sufficient for startsWith matching; text after it must not
        // make an image-led paragraph look like a marker-led paragraph.
        break;
    }
    return result;
}


export function removePrefixComparableCharacters(
    inlines: PandocInline[],
    charactersToRemove: number,
    includeOtherWrappers = false
): PandocInline[] {
    const strip = (
        items: PandocInline[],
        initialRemaining: number
    ): { inlines: PandocInline[]; remaining: number } => {
        let remaining = initialRemaining;
        const result: PandocInline[] = [];

        for (const item of items) {
            if (remaining <= 0) {
                result.push(item);
                continue;
            }

            if (item.t === 'Str') {
                if (item.c.length <= remaining) {
                    remaining -= item.c.length;
                } else {
                    result.push({ ...item, c: item.c.slice(remaining) });
                    remaining = 0;
                }
                continue;
            }

            if (item.t === 'Space') {
                remaining -= 1;
                continue;
            }

            if (
                item.t === 'Strong'
                || item.t === 'Emph'
                || item.t === 'Strikeout'
                || item.t === 'Underline'
                || (includeOtherWrappers && (item.t === 'Superscript' || item.t === 'Subscript' || item.t === 'SmallCaps'))
            ) {
                const nested = strip(item.c, remaining);
                remaining = nested.remaining;
                if (nested.inlines.length > 0) {
                    result.push({ ...item, c: nested.inlines });
                }
                continue;
            }

            if (item.t === 'Code') {
                const code = item.c[1];
                if (code.length <= remaining) {
                    remaining -= code.length;
                } else {
                    result.push({ ...item, c: [item.c[0], code.slice(remaining)] });
                    remaining = 0;
                }
                continue;
            }

            if (item.t === 'Link') {
                const nested = strip(item.c[1], remaining);
                remaining = nested.remaining;
                if (nested.inlines.length > 0) {
                    result.push({ ...item, c: [item.c[0], nested.inlines, item.c[2]] });
                }
                continue;
            }
            if (includeOtherWrappers && (item.t === 'Span' || item.t === 'Quoted')) {
                const nested = strip(item.c[1], remaining);
                remaining = nested.remaining;
                if (nested.inlines.length > 0) {
                    if (item.t === 'Span') result.push({ ...item, c: [item.c[0], nested.inlines] });
                    else result.push({ ...item, c: [item.c[0], nested.inlines] });
                }
                continue;
            }

            // Prefix matching stops at non-comparable inline nodes, so a
            // matched prefix never needs to consume this item or anything
            // after it. Keep the remaining content intact defensively.
            result.push(item);
            remaining = 0;
        }

        return { inlines: result, remaining };
    };

    return strip(inlines, Math.max(0, charactersToRemove)).inlines;
}
