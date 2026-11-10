import { ConversionReportCollector, type ConversionReport } from '../src/conversionReport';
import { stripObsidianComments } from '../src/obsidianComments';
import { scanRenderableBlocks } from '../src/renderableBlocks';

/** Report omitted rendered blocks to the same consumer as conversion warnings. */
export function captureReport(
    markdown: string,
    options: { captureRenderedBlocks: boolean; captureMermaid: boolean; captureThirdPartyRenderers: boolean; thirdPartyLanguages: string[] },
    result: { failures: { hint: string; message: string }[]; contractViolation: boolean }
): ConversionReport {
    const report = new ConversionReportCollector();
    const thirdParty = options.thirdPartyLanguages.map((language) => language.trim().toLowerCase()).filter(Boolean);
    const disabled = new Set<string>();
    if (!options.captureRenderedBlocks || !options.captureMermaid) disabled.add('mermaid');
    if (!options.captureRenderedBlocks || !options.captureThirdPartyRenderers) {
        for (const language of thirdParty) {
            if (language !== 'mermaid' || !options.captureRenderedBlocks || !options.captureMermaid) disabled.add(language);
        }
    }
    for (const block of scanRenderableBlocks(stripObsidianComments(markdown), { languages: disabled, includeSvgFiles: false })) {
        report.add('render_capture_disabled', '렌더 캡처가 꺼져 그림이 포함되지 않았을 수 있습니다', block.hint);
    }
    for (const failure of result.failures) {
        report.add('render_capture_failed', '렌더 캡처에 실패하거나 제한에 걸려 그림이 포함되지 않았습니다', failure.hint);
    }
    if (result.contractViolation) report.add('render_capture_mapping_failed', '렌더 캡처 연결에 실패하여 원문을 유지했습니다');
    return report.toJSON();
}
