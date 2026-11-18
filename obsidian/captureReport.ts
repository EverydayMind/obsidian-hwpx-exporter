import { L } from "../src/locale";
import { ConversionReportCollector, type ConversionReport } from '../src/conversionReport';
import { stripObsidianComments } from '../src/obsidianComments';
import { scanRenderableBlocks } from '../src/renderableBlocks';
import { missingCaptureSwitches, type CaptureOptions, type CaptureSwitch } from './captureSelection';

export type DisabledCapture = { hint: string; switches: CaptureSwitch[] };
export type CaptureFailure = { hint: string; message: string };

export function disabledCaptureLanguages(markdown: string, options: CaptureOptions): DisabledCapture[] {
    const languages = new Set(['mermaid', ...options.thirdPartyLanguages.map(language => language.trim().toLowerCase()).filter(Boolean)]);
    return scanRenderableBlocks(stripObsidianComments(markdown), { languages, includeSvgFiles: false })
        .map(block => ({ hint: block.hint, switches: missingCaptureSwitches(block.hint, options) }))
        .filter(block => block.switches.length > 0);
}

export function summarizeDisabledCaptureLanguages(languages: DisabledCapture[]): string {
    const counts = new Map<string, number>();
    for (const block of languages) for (const reason of block.switches) {
        const label = reason === 'captureRenderedBlocks' ? L({ ko: '렌더 블록 캡처가 꺼져 있습니다', en: 'Rendered-block capture is off' })
            : reason === 'captureMermaid' ? L({ ko: 'Mermaid 캡처가 꺼져 있습니다', en: 'Mermaid capture is off' })
            : L({ ko: `제3자 렌더러 캡처 (${block.hint})가 꺼져 있습니다`, en: `Third-party renderer capture (${block.hint}) is off` });
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => L({ ko: `${label} (${count}건)`, en: `${label} (${count} item(s))` })).join(', ');
}

/** Report omitted rendered blocks to the same consumer as conversion warnings. */
export function captureReport(
    markdown: string,
    options: CaptureOptions,
    result: { failures: { hint: string; message: string }[]; contractViolation: boolean }
): ConversionReport {
    const report = new ConversionReportCollector();
    for (const block of disabledCaptureLanguages(markdown, options)) {
        report.add('render_capture_disabled', L({ ko: '일부 렌더 블록 캡처가 꺼져 그림이 포함되지 않았을 수 있습니다', en: "Some rendered-block capture is off; images may be missing" }), block.hint);
    }
    for (const failure of result.failures) {
        report.add('render_capture_failed', L({ ko: '렌더 캡처에 실패하거나 제한에 걸려 그림이 포함되지 않았습니다', en: "Images were not included because rendered-block capture failed or reached a limit" }), failure.hint);
    }
    if (result.contractViolation) report.add('render_capture_mapping_failed', L({ ko: '렌더 캡처 연결에 실패하여 원문을 유지했습니다', en: "The source was kept because rendered-block capture could not be linked" }));
    return report.toJSON();
}
