# HWPX Exporter

HWPX Exporter exports Markdown notes to Hangul (Hancom Office) HWPX documents. The look of the output comes from an HWPX template that you edit in Hangul. The plugin also gives AI agent plugins an MCP-like API to check and run exports.

[한국어 설명](README.ko.md)

## Features

- **Markdown → HWPX**: headings, paragraphs, bold/italic/strikethrough/highlight, links, lists (nested, numbered, tasks), tables (alignment, column widths), code blocks, quotes and Obsidian callouts, footnotes as real Hangul footnotes, images and `![[embeds]]`, inline `$math$`, horizontal rules and front matter.
- **Template-based formatting**: an `.hwpx` template holds markers such as `{{H1}}`, `{{BODY}}` and `{{QUOTE}}`. The character and paragraph formatting at each marker is applied to the matching part of the note. Design lives in the template, not in the plugin.
- **Bundled templates**: a sample template with every marker, a Hangul report template, a KORDOC-style report form and six templates that reproduce popular themes (Obsidian default, Minimal, Things, AnuPpuccin, Blue Topaz, Primary).
- **Template guide**: a Markdown note, *HWPX template authoring guide*, is installed next to the templates.
- **App language**: the interface, the agent tool wording and the names of the installed templates and guide follow the app language (Korean when Obsidian is set to Korean, English otherwise). Files installed earlier keep their names.
- **Template inspector**: lists the markers a template defines, flags likely typos and shows what falls back to default formatting.
- **Rendered blocks**: Mermaid diagrams and SVG files can be captured as images. Other code-block renderers are opt-in.
- **API for AI agent plugins**: an agentinterop v1 provider (see below).

## Getting started

1. Enable the plugin. On first run it creates the folder `HWPX templates` in your vault with the bundled templates and the template guide, and selects that folder in the settings. Existing files are never replaced.
2. Open a note and run **Export current note to HWPX** from the command palette, or right-click a note or folder and choose **Export to HWPX**.
3. The `.hwpx` file is written next to the note (or to a fixed folder) and opened with the default app.

To restore the bundled templates or install them into another folder, run **Install bundled templates** or use the button in the settings.

## Commands

- **Export current note to HWPX**
- **Export current note to HWPX (choose template)**
- **Export folder to HWPX**
- **Inspect HWPX template**
- **Install bundled templates**

Command names follow the app language.

## Writing your own template

Copy `Sample template.hwpx` (`견본 템플릿.hwpx` in Korean), open it in Hangul, change the formatting of each marker and save it under a new name in the template folder. The installed guide explains every marker and option. Run **Inspect HWPX template** after editing.

## Settings

- **Template folder**: the vault folder whose `.hwpx` files are offered on export.
- **Output**: same folder as the note or a fixed folder, the file name pattern, and numbering on name conflicts.
- **Conversion**: page break before H1.
- **Rendered block capture**: Mermaid, SVG files, third-party renderers, light theme, raster scale and capture width.
- **Security limits**: maximum input and template size, nesting depth and image count.

## API for AI agent plugins

HWPX Exporter exposes an agentinterop v1 capability provider on its plugin instance. A compatible agent host can read the tool definitions and call them after you approve them in the host:

- `get_export_options`: available templates, output location, naming and capture settings.
- `check_export`: a trial conversion of one note in the OS temp folder. It reports the output path, the note's structure, images that cannot be embedded and code blocks that would be captured. Nothing is written to the vault.
- `export_note`: exports a note to a new `.hwpx` file. This is a *commit* tool: the host shows the exact file to be created and asks you before anything is written. It never replaces an existing file and never writes into hidden folders.

### About the agentinterop v1 provider

agentinterop v1 is the author's own convention, not an official or widely recognized standard. It lets an Obsidian plugin that runs an AI agent discover tools offered by other plugins through an MCP-like API, without those plugins knowing about any particular agent host.

- The plugin instance holds the provider under `Symbol.for('dev.agentinterop.capability-provider')`. The provider has `protocol: 'agentinterop'`, `protocolVersion: 1`, `describe()` (provider info, instructions and tool definitions with JSON Schema inputs) and `callTool(name, args)` (returns `content` plus `structuredContent`, or an error with a code). `export_note` additionally goes through `resolveTarget` and `commit.prepare` / `commit.execute`.
- Tool definitions carry `_meta` hints under the `dev.agentinterop/` prefix: `effect` (`read` or `commit`), `group`, `keywords`, `resourceTypes` and `maxResultChars`. A host shows these tools to a model only when a request mentions a keyword such as "hwpx", "hwp", "한글" or "export".
- The plugin triggers the workspace event `agentinterop:providers-changed` on load and unload so a host can refresh its tool list.

The plugin works the same without an agent host.

## Disclosures

- **Desktop only, Node.js file system access.** The converter reads and writes files by path with Node's `fs` module, which is why the plugin is desktop only. It reads the note, the selected template and the images the note embeds, all inside the vault (an image link that does not resolve to a vault file is read only from inside the note's folder). It writes only the exported `.hwpx` file at the vault path shown in the settings, and a temporary folder in the OS temp directory while an agent checks or prepares an export; that folder is removed right after.
- **Files it writes through the vault API**: on first run, the bundled templates and the guide in `HWPX templates`; an agent's approved `export_note` result.
- **Opening files**: after an export from a command, the file is opened with the system's default app for `.hwpx` (usually Hangul).
- **No network access, no telemetry, no account.**
- **Third-party renderers** run other plugins' code-block processors during export. They are off by default. Turn them on only for notes you trust. When an export leaves such blocks out, the warning lists them and offers a button that turns the capture on.

## Installation

Once listed, install **HWPX Exporter** from *Settings → Community plugins*. To install manually, copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<Vault>/.obsidian/plugins/md-to-hwpx/`.

You need Hangul (Hancom Office) or another HWPX viewer to open the output. The plugin itself does not need it.

## Development

```
npm ci
npm run build       # bundles obsidian/main.ts, the converter in src/ and the templates into main.js
npm run typecheck
npm run lint
```

## Credits

The converter is derived from [pypandoc-hwpx](https://github.com/msjang/pypandoc-hwpx) (MIT); [LICENSE](LICENSE) lists the copyright holders. It bundles [marked](https://github.com/markedjs/marked), [JSZip](https://github.com/Stuk/jszip), [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) and [gray-matter](https://github.com/jonschlinkert/gray-matter) under their MIT licenses.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
