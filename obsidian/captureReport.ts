import { L } from "../src/locale";
import { ConversionReportCollector, type ConversionReport } from '../src/conversionReport';
import { stripObsidianComments } from '../src/obsidianComments';
import { scanRenderableBlocks } from '../src/renderableBlocks';

type CaptureOptions = { captureRenderedBlocks: boolean; captureMermaid: boolean; captureThirdPartyRenderers: boolean; thirdPartyLanguages: string[] };

export function disabledCaptureLanguages(markdown: string, options: CaptureOptions): string[] {
    const thirdParty = options.thirdPartyLanguages.map((language) => language.trim().toLowerCase()).filter(Boolean);
    const disabled = new Set<string>();
    if (!options.captureRenderedBlocks || !options.captureMermaid) disabled.add('mermaid');
    if (!options.captureRenderedBlocks || !options.captureThirdPartyRenderers) {
        for (const language of thirdParty) {
            if (language !== 'mermaid' || !options.captureRenderedBlocks || !options.captureMermaid) disabled.add(language);
        }
    }
    return scanRenderableBlocks(stripObsidianComments(markdown), { languages: disabled, includeSvgFiles: false }).map(block => block.hint);
}

export function summarizeDisabledCaptureLanguages(languages: string[]): string {
    const counts = new Map<string, number>();
    for (const language of languages) counts.set(language, (counts.get(language) ?? 0) + 1);
    return [...counts].map(([language, count]) => L({ ko: `${language} ${count}건`, en: `${language} ${count} item(s)` })).join(', ');
}

/** Report omitted rendered blocks to the same consumer as conversion warnings. */
export function captureReport(
    markdown: string,
    options: CaptureOptions,
    result: { failures: { hint: string; message: string }[]; contractViolation: boolean }
): ConversionReport {
    const report = new ConversionReportCollector();
    for (const language of disabledCaptureLanguages(markdown, options)) {
        report.add('render_capture_disabled', L({ ko: '렌더 캡처가 꺼져 그림이 포함되지 않았을 수 있습니다', en: "Rendered-block capture is disabled; images may be missing" }), language);
    }
    for (const failure of result.failures) {
        report.add('render_capture_failed', L({ ko: '렌더 캡처에 실패하거나 제한에 걸려 그림이 포함되지 않았습니다', en: "Images were not included because rendered-block capture failed or reached a limit" }), failure.hint);
    }
    if (result.contractViolation) report.add('render_capture_mapping_failed', L({ ko: '렌더 캡처 연결에 실패하여 원문을 유지했습니다', en: "The source was kept because rendered-block capture could not be linked" }));
    return report.toJSON();
}
