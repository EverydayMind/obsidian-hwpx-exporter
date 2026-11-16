// Provided at build time by scripts/bundled-templates.mjs.
declare module 'virtual:bundled-templates' {
    const templates: ReadonlyArray<{ name: string; base64: string }>;
    export default templates;
    /** The template-writing guide, a Markdown note installed next to the templates. */
    export const guide: { name: string; text: string; enText: string };
}
