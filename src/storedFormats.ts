import { getLocale, type Locale } from './locale';

/** Stored vocabulary: bilingual read; only newly created files use the app locale. */
export const STORED_FORMATS = {
    '한글 템플릿.hwpx': { ko: '한글 템플릿.hwpx', en: 'Hangul template.hwpx' },
    '한글보고서 템플릿.hwpx': { ko: '한글보고서 템플릿.hwpx', en: 'Hangul report template.hwpx' },
    '견본 템플릿.hwpx': { ko: '견본 템플릿.hwpx', en: 'Sample template.hwpx' },
    'KORDOC 보고서.hwpx': { ko: 'KORDOC 보고서.hwpx', en: 'KORDOC report.hwpx' },
    '옵시디언 테마 - AnuPpuccin.hwpx': { ko: '옵시디언 테마 - AnuPpuccin.hwpx', en: 'Obsidian theme - AnuPpuccin.hwpx' },
    '옵시디언 테마 - Blue Topaz.hwpx': { ko: '옵시디언 테마 - Blue Topaz.hwpx', en: 'Obsidian theme - Blue Topaz.hwpx' },
    '옵시디언 테마 - Minimal.hwpx': { ko: '옵시디언 테마 - Minimal.hwpx', en: 'Obsidian theme - Minimal.hwpx' },
    '옵시디언 테마 - Obsidian 기본.hwpx': { ko: '옵시디언 테마 - Obsidian 기본.hwpx', en: 'Obsidian theme - Obsidian default.hwpx' },
    '옵시디언 테마 - Primary.hwpx': { ko: '옵시디언 테마 - Primary.hwpx', en: 'Obsidian theme - Primary.hwpx' },
    '옵시디언 테마 - Things.hwpx': { ko: '옵시디언 테마 - Things.hwpx', en: 'Obsidian theme - Things.hwpx' },
    '적용템플릿.hwpx': { ko: '적용템플릿.hwpx', en: 'Active template.hwpx' },
    guide: { ko: 'HWPX 템플릿 작성 가이드.md', en: 'HWPX template authoring guide.md' },
    styleSummary: { ko: '## 서식 요약', en: '## Style summary' },
    guidance: { ko: '## 작성 지침', en: '## Writing guidance' },
} as const;

export function storedPair(key: string): { ko: string; en: string } {
    return (STORED_FORMATS as Record<string, { ko: string; en: string }>)[key]
        ?? Object.values(STORED_FORMATS).find(pair => pair.en === key)
        ?? { ko: key, en: key };
}
export function storedFormat(key: string, locale = getLocale()): string { return storedPair(key)[locale]; }
export function storedCandidates(key: string): string[] { return [...new Set(Object.values(storedPair(key)))]; }

/** Existing spelling wins in either app language. Never rename or create a parallel copy. */
export function storedPath(folder: string, key: string, paths: readonly string[], locale = getLocale()): string {
    const join = (name: string) => [folder, name].filter(Boolean).join('/');
    return storedCandidates(key).map(join).find(p => paths.includes(p)) ?? join(storedFormat(key, locale));
}

/** Structural headings only: user text cannot decide the stored format. */
export function storedNoteLocale(header: string, fallback = getLocale()): Locale {
    for (const line of header.split(/\r?\n/).reverse())
        for (const locale of ['ko', 'en'] as const)
            if (line === storedFormat('styleSummary', locale)) return locale;
    return fallback;
}
