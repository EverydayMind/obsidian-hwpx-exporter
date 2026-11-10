/** True only for one or more whole HTML comments with whitespace between them. */
export function htmlCommentsOnly(html: string): boolean {
    let offset = 0, comments = 0;
    while (offset < html.length) {
        while (offset < html.length && /\s/.test(html[offset])) offset++;
        if (offset === html.length) break;
        if (!html.startsWith('<!--', offset)) return false;
        const end = html.indexOf('-->', offset + 4);
        if (end < 0) return false;
        comments++;
        offset = end + 3;
    }
    return comments > 0;
}
