import grammar from '../contracts/report-style/md-dialect-v2/key-grammar.json';

/**
 * Context spacer rules: `{{SPACE:<rule>:<previous>}}` in a 1x1 rule table.
 *
 * A block rule ({{BODY}}, {{H1}}, a prefix rule {{□}}) repeats the blank
 * paragraphs drawn above its marker before every paragraph it renders. Korean
 * reports sometimes vary that spacing with the block before it (a □ item
 * right after a heading, a body line right after a table). A SPACE rule
 * holds the blank paragraphs to use instead when the top-level block before a
 * `<rule>` paragraph was `<previous>`; a SPACE rule with no blank paragraphs
 * removes the spacing in that context.
 *
 * `<rule>` is a block marker name (BODY, H1–H9) or a prefix marker token
 * (□, ㅇ, -). `<previous>` is one of those or a block role below.
 */
export const BLOCK_ROLES = ['START', 'TABLE', 'LIST', 'CODE', 'QUOTE', 'HR', 'DIV'] as const;

/** The union grammar applies to every template, independently of record dialect. */
export function spaceMarkerParts(name: string): { rule: string; previous: string } | null {
    const parts = name.split(':');
    if (parts.length !== 3 || parts[0] !== 'SPACE') return null;
    const key = new RegExp(grammar.space.keyPattern, 'u');
    const currentSpecial: readonly string[] = grammar.space.currentSpecial;
    const previousSpecial: readonly string[] = grammar.space.previousSpecial;
    const rule = parts[1], previous = parts[2];
    return (key.test(rule) || currentSpecial.includes(rule)) && (key.test(previous) || previousSpecial.includes(previous))
        ? { rule: rule.replace('/', ':'), previous: previous.replace('/', ':') } : null;
}

export function spaceKey(rule: string, previous: string): string {
    return `${rule}\n${previous}`;
}

/** The role a top-level block leaves for the next one when no rule rendered it. */
export function blockRole(block: { t: string; c?: unknown }): string {
    switch (block.t) {
        case 'Header': return `H${(block.c as [number])[0]}`;
        case 'Para': case 'Plain': return 'BODY';
        case 'Table': return 'TABLE';
        case 'BulletList': case 'OrderedList': return 'LIST';
        case 'CodeBlock': return 'CODE';
        case 'BlockQuote': return 'QUOTE';
        case 'HorizontalRule': return 'HR';
        default: return 'DIV';
    }
}
