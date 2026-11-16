# HWPX template authoring guide

HWPX Exporter uses a template to format your notes as Hangul documents (.hwpx). A template is an ordinary .hwpx file you can open and edit in Hangul. Its document text, font names and style names may be Korean.

> [!tip] Start with a working example
> Copy `Sample template.hwpx` from this folder and open the copy in Hangul. It contains the available markers with explanations. Change each marker's character and paragraph formatting, then save under a new name. The explanations do not appear in exports. If the templates were installed in Korean, the sample is named `견본 템플릿.hwpx`.

## 1. How templates work

- Markers such as `{{H1}}`, `{{BODY}}` and `{{QUOTE}}` identify note elements.
- The exporter reads character formatting (font, size, color), paragraph formatting (alignment, spacing, indentation, borders, shading), and styles at each marker.
- For example, making `{{H1}}` 20 pt navy makes level-one headings in exported notes 20 pt navy.
- All markers are optional. Missing rules use default formatting.

## 2. Create rule tables

Put each marker in a **one-cell table**, except for `{{CELL_…}}` markers. This is a rule table.

The export removes the outer rule table and replaces the marker with note content. Text around the marker and blank paragraphs above or below it remain: `□ {{H2}}` adds `□ ` before every level-two heading. A table nested inside the rule table remains real content, which is useful for decorative heading bands. Explanations above rule tables are omitted.

## 3. Marker reference

| Element | Markers | Markdown source |
|---|---|---|
| Headings | `{{H1}}` … `{{H9}}` | `#` … `#########` |
| Body | `{{BODY}}` | Ordinary paragraphs |
| Links | `{{LINK}}` | `[text](url)`, `[[note]]` |
| Code | `{{CODE}}`, `{{CODE_INLINE}}`, `{{CODE_LANG}}` | Code blocks, inline code, language label |
| Quotes and callouts | `{{QUOTE}}`, `{{QUOTE_INFO}}`, `{{QUOTE_WARN}}`, `{{QUOTE_SUCCESS}}`, `{{QUOTE_DANGER}}`, `{{CALLOUT_<type>}}`, `{{CALLOUT_TITLE}}`, `{{CALLOUT_TITLE_<type>}}` | `> quote`, `> [!note] Title` |
| Horizontal rule | `{{HR}}` | `---` |
| Character formatting | `{{STRONG}}`, `{{EMPH}}`, `{{STRIKE}}`, `{{UNDERLINE}}`, `{{HIGHLIGHT}}` | Bold, italic, strikethrough, underline, highlight |
| Math | `{{MATH}}`, `{{MATH_INLINE}}` | `$$ … $$`, `$…$` |
| Footnotes | `{{FOOTNOTE}}` | `[^1]` |
| Images and captions | `{{FIGURE}}`, `{{CAPTION}}`, `{{TABLE_CAPTION}}` | Image-only paragraph, image caption, table caption |
| Tasks | `{{TASK_OPEN}}`, `{{TASK_DONE}}` | `- [ ]`, `- [x]` |
| Lists | `{{LIST_BULLET_1}}` … `{{LIST_BULLET_7}}`, `{{LIST_ORDERED_1}}` … `{{LIST_ORDERED_7}}` | Bulleted and numbered lists; suffix is nesting depth |
| Tables | `{{TABLE}}`, `{{CELL_…}}` | Markdown tables |
| Fixed regions and metadata | `{{CONTENT}}`, `{{META:key}}` | Body insertion point, YAML values |

`{{title}}` is a note-body placeholder, not a template marker. It becomes the note filename. Use `{{META:title}}` for a document title in a template.

## 4. Rules for each element

### Quotes and callouts

Quotes use `{{QUOTE}}`. Set the paragraph border and shading to create a box or a colored left edge. Quotes starting with these emoji select a more specific rule:

- INFO: 💡 ℹ️ 📌 ✍️ 🔎 📝
- WARN: ⚠️ ❗ 🚨
- SUCCESS: ✅ ✔️
- DANGER: ❌ 🚫 ⛔

Callouts look for `{{CALLOUT_<type>}}`, then the matching `{{QUOTE_*}}`, then `{{QUOTE}}`. Types such as note and tip map to INFO; success to SUCCESS; warning and question to WARN; danger and bug to DANGER. Custom Korean names also work, for example `{{CALLOUT_회의}}`.

Callout titles use `{{CALLOUT_TITLE_<type>}}`, then `{{CALLOUT_TITLE}}`. Give the title the same paragraph border and shading as its body to place both in one box. A prefix before the quote marker, such as `※` followed by a tab, is repeated for each quote.

### Horizontal rules and code

The bottom paragraph border on `{{HR}}` supplies the horizontal line; the output is one empty paragraph. For code blocks, set borders and shading on `{{CODE}}`. Enable connected paragraph borders in Hangul to join multiple lines into one box. Border spacing controls the padding.

### Character formatting

`{{STRONG}}`, `{{EMPH}}`, `{{STRIKE}}` and `{{UNDERLINE}}` apply differences from `{{BODY}}`, including text color and underline/strikethrough appearance. `{{LINK}}`, `{{CODE_INLINE}}`, `{{HIGHLIGHT}}` and `{{MATH_INLINE}}` can also change shading, font, bold and italic. Inline rules keep the surrounding font size, so a link inside a heading keeps the heading's size.

### Lists and footnotes

Write the first number, such as `1.`, in an ordered-list rule to increment it automatically. Forms such as `가.`, `①`, `I.` and `(a)` are supported. Paragraph spacing after controls the gap between items. If paragraph numbering is configured in Hangul, Hangul supplies the numbers.

Markdown footnotes become Hangul footnotes. Their number format comes from the template's footnote settings. Paragraph formatting follows `{{FOOTNOTE}}`, then the template's `각주` style, then body formatting.

### Tables

Define cell markers in an actual table. The note determines the exported row and column counts. Row positions are HEADER, TOP, MIDDLE and BOTTOM. Column positions are LEFT, CENTER and RIGHT; these describe position, not alignment. Examples: `{{CELL_HEADER_LEFT}}`, `{{CELL_MIDDLE_CENTER}}`.

Additional rules are `{{CELL_NUMBER}}` for numeric cells, `{{CELL_STUB}}` for the first body column, `{{CELL_ODD}}`/`{{CELL_EVEN}}` for striped rows, and `{{CELL_BODY}}` for other body cells. Markdown alignment markers set alignment. Separator lengths set relative column widths.

## 5. Marker options

Append options after `|` inside a marker.

| Example | Effect |
|---|---|
| `{{H1\|pageBreak}}`, `{{H1\|pageBreak=no}}` | Start a new page before this heading level, or disable that break |
| `{{H3\|num=%1.%2.%3.}}` | Add hierarchical numbers such as `1.2.3.` |
| `{{H3\|list=2}}` | Start lists under this heading with level-two formatting |
| `{{TABLE\|width=100%}}` | Set table width; also accepts `template`, `avail`, `80%` |
| `{{TABLE\|columns=equal}}` | Use equal column widths |
| `{{QUOTE_custom\|callouts=warning,caution}}` | Match callout types |
| `{{QUOTE_custom\|emoji=⚠️,❗}}` | Match the first emoji |
| `{{QUOTE:summary\|lead}}` | Format the first quote immediately after the title as a summary |

Custom `{{QUOTE_<name>}}` rules outside the four built-in categories need `callouts=` or `emoji=`.

## 6. Formatting variants

Add `:name` to define an alternative: `{{BODY:summary}}`, `{{H2:appendix}}`, `{{QUOTE:caution}}`, `{{CODE:small}}`, `{{CELL_HEADER_LEFT:compact}}`.

Select a variant with `<!-- hwpx:style=summary -->` immediately before a block. Optional explanatory text may follow the name: `<!-- hwpx:style=summary Short overview -->`. Names cannot contain spaces. A callout such as `> [!summary] Title` can select `{{BODY:summary}}` when no matching CALLOUT rule exists. YAML `hwpx-table: compact` selects the compact cell variants for all tables. Missing variants fall back to the base rule.

## 7. Numbering and paragraph prefixes

Use `{{#}}` at the position of a number, for example `제{{#}}장`. Explicit formats include `{{#:가}}`, `{{#:①}}`, `{{#:㉠}}`, `{{#:I}}`, `{{#:i}}`, `{{#:A}}` and `{{#:a}}`. Caption rules support these too.

Numbered-heading variants such as `{{H2:1.}}`, `{{H3:1)}}` and `{{H2:1.1}}` match numbered headings and keep their numbers. Add `|strip` to remove the source number: `□ {{H2:1.\|strip}}` turns `## 17. Overview` into `□ Overview`. Unnumbered headings use the base rule.

Rules such as `{{□}}`, `{{ㅇ}}` and `{{1.}}` match paragraphs with those prefixes. Leading spaces must match exactly (`{{  □}}`); use `{{~□}}` to ignore indentation. The rule replaces the source symbol; numeric prefixes remain.

Markdown treats `- ` as a list. When `{{LIST_BULLET_1}}` is absent, `{{-}}` formats top-level bullet items. Escaping the hyphen is unnecessary. The output retains a hyphen only if the rule contains it, as in `[[[-{{-}}]]]` or a derived template. Nested items use normal list formatting.

## 8. Covers, approval fields and metadata

Place `{{CONTENT}}` alone in a paragraph where the body should appear. Ordinary paragraphs before and after it remain in the output, including covers and approval fields. `{{META:title}}` and `{{META:author}}` read YAML values, including in headers and footers. Dates accept formats such as `{{META:date|format=YYYY. M. D.}}` using YYYY, YY, MM, M, DD and D. Without a title, the note filename is used.

```yaml
---
title: Project report
author: Planning team
date: 2026-11-16
---
```

## 9. Inspect and troubleshoot

Run **Inspect HWPX template** from the command palette or the settings' **Inspect** button. It lists recognized markers, possible typos, and elements that will fall back to defaults. For example, `{{QUOTE_WARNING}}` may suggest `{{QUOTE_WARN}}`.

The template picker lists .hwpx files directly inside the selected template folder, without subfolders. Open exported documents in Hangul to check boxes, lines, colors and spacing. Save customized bundled templates under new names. **Install bundled templates** keeps existing files under either language's name and does not replace them.

## Link a template to a note and reuse a sample

Add `hwpx-template: "[[My template.hwpx]]"` to note frontmatter. **Export current note to HWPX** uses that template, even outside the configured template folder, provided it is a visible .hwpx file inside the Vault. An unresolved link produces an error. The **(choose template)** command puts the linked template first; folder exports resolve each note's link separately.

When Verbex decomposes a sample, it chooses the output filenames. English installations use names such as `<name>_text.md` and `<name>_template.hwpx`; older Korean pairs use `_텍스트.md` and `_템플릿.hwpx`. The Markdown links to its template. Export the text unchanged to reproduce the sample, or replace the content while keeping the structure to reuse the formatting.

In a decomposed template, the region from `{{DECOMPOSITION}}` through the last rule table is omitted from exports. Use the explanations above each rule to edit its formatting in Hangul. Fixed regions, including the table of contents, retain the sample's text and must be edited for each new document.
