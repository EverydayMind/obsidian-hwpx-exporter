export type CaptureSwitch = 'captureRenderedBlocks' | 'captureMermaid' | 'captureThirdPartyRenderers';
export type CaptureOptions = Record<CaptureSwitch, boolean> & { thirdPartyLanguages: string[] };

export function captureLanguages(options: CaptureOptions): Set<string> {
    const languages = new Set<string>();
    if (options.captureMermaid) languages.add('mermaid');
    if (options.captureThirdPartyRenderers) for (const language of options.thirdPartyLanguages) {
        if (language.trim()) languages.add(language.trim().toLowerCase());
    }
    return languages;
}

export function missingCaptureSwitches(hint: string, options: CaptureOptions): CaptureSwitch[] {
    const missing: CaptureSwitch[] = [];
    if (!options.captureRenderedBlocks) missing.push('captureRenderedBlocks');
    if (hint === 'mermaid') {
        if (!options.captureMermaid) missing.push('captureMermaid');
    } else if (!options.captureThirdPartyRenderers) missing.push('captureThirdPartyRenderers');
    return missing;
}
