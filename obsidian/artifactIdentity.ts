// The production build injects an identifier derived from the unstamped bundle.
// Direct TypeScript runs and unstamped development builds must not claim one.
declare const __HWPX_EXPORTER_ARTIFACT__: string | undefined;

export function artifactId(): string | null {
    try {
        const value = __HWPX_EXPORTER_ARTIFACT__;
        return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
    } catch {
        return null;
    }
}
