// Templates and the template-writing guide embedded in main.js. A community-plugin install
// downloads only main.js, manifest.json and styles.css, so the plugin carries these inside
// main.js and writes them into the Vault ("Install bundled templates", and once on first run).
// Shared by scripts/build-plugin.mjs and the release repository's esbuild.config.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';

// Marker-free or generator-input templates that a user would not export with.
const NOT_BUNDLED = new Set(['blank.hwpx', 'placeholder-template.hwpx', 'placeholder-template-source.hwpx']);

export function selectBundledTemplates(templatesDir) {
    return fs.readdirSync(templatesDir)
        .filter((name) => name.endsWith('.hwpx') && !NOT_BUNDLED.has(name))
        // Code-point order: localeCompare differs between Windows and Linux ICU, which made
        // local and CI main.js differ.
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((name) => path.join(templatesDir, name));
}

/** The original guide; locale variants are loaded alongside it. */
export function selectGuide(guideDir) {
    const guides = fs.readdirSync(guideDir).filter((name) => name.endsWith('.md') && !name.endsWith('.en.md'));
    if (guides.length !== 1) throw new Error(`Expected exactly one guide in ${guideDir}, found ${guides.length}`);
    return path.join(guideDir, guides[0]);
}

export function bundledTemplatesPlugin(files, guideFile) {
    return {
        name: 'bundled-templates',
        setup(build) {
            build.onResolve({ filter: /^virtual:bundled-templates$/ }, (args) => ({
                path: args.path,
                namespace: 'bundled-templates',
            }));
            build.onLoad({ filter: /.*/, namespace: 'bundled-templates' }, () => {
                const templates = files.map((file) => ({
                    name: path.basename(file),
                    base64: fs.readFileSync(file).toString('base64'),
                }));
                const enFile = path.join(path.dirname(guideFile), 'guide.en.md');
                const guide = { name: path.basename(guideFile), text: fs.readFileSync(guideFile, 'utf8'), enText: fs.readFileSync(enFile, 'utf8') };
                return {
                    contents: `export default ${JSON.stringify(templates)};\nexport const guide = ${JSON.stringify(guide)};`,
                    loader: 'js',
                    watchFiles: [...files, guideFile, enFile],
                };
            });
        },
    };
}
