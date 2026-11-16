/** One display/model language for a plugin lifetime. Kept independent of Obsidian
 * so converters and provider fixtures can run without loading the desktop API. */
export type Locale = 'ko' | 'en';
let initialized: Locale | undefined;
let testLocale: Locale | undefined;

function validLanguage(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.trim());
}

export function resolveLocale(appLanguage: () => unknown, browserLanguage: () => unknown = () =>
    typeof navigator === 'undefined' ? undefined : navigator.language): Locale {
    for (const read of [appLanguage, browserLanguage]) {
        try {
            const value = read();
            if (validLanguage(value)) return value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
        } catch { /* The API may be unavailable in a headless host. */ }
    }
    return 'en';
}

export function initLocale(appLanguage: () => unknown): Locale {
    initialized ??= resolveLocale(appLanguage);
    return initialized;
}

export function getLocale(): Locale {
    return testLocale ?? (process.env.HWPX_TEST_LOCALE === 'ko' ? 'ko' : initialized ?? 'en');
}

/** Passing undefined removes the test override without changing the pinned app language. */
export function setLocaleForTests(locale: Locale | undefined): void { testLocale = locale; }

export function localizer(locale: Locale): (pair: { ko: string; en: string }) => string {
    return pair => pair[locale];
}

export function L(pair: { ko: string; en: string }): string { return pair[getLocale()]; }
