import markerTable from '../../contracts/report-style/md-dialect-v2/marker-table.json';

export const BOX_SERIES = markerTable.series.filter((series) => series.name === 'white-box' || series.name === 'black-box');
export function boxSeries(text: string) {
    const code = text.codePointAt(0) ?? -1;
    return BOX_SERIES.find((series) => code >= series.start! && code <= series.end!);
}

/** A whole cell must contain one ordinal, optionally prefixed by 제 and suffixed
 * by a chapter/section unit. Spaces around the token and at the edges are allowed.
 * Recognition is deliberately narrower than formatCounterText's substitution.
 */
export function isNumberToken(text: string): boolean {
    const value = text.trim();
    if (value === '') return false;
    // Require a token before an optional unit: 차 itself is an ordinal too.
    const match = /^(?:제\s*)?(.+?)(?:\s*[장절편부관조항권회차과])?$/.exec(value);
    if (!match) return false;
    const token = match[1].trim();
    if (token === '') return false;
    return ([...token].length === 1 && !!boxSeries(token)) || /^(?:[Ⅰ-Ⅻ]|\d{1,3}[.)]?|[가나다라마바사아자차카타파하][.)]?|[①-⑳])$/.test(token)
        || /^(?:XX|X(?:IX|IV|V?I{0,3})|IX|IV|VI{0,3}|I{1,3})$/i.test(token);
}
