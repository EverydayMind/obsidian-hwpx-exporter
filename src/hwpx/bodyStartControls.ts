import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { descendants, NS } from '../template-derive/xml';
import { BODY_START_MARKER } from '../template-derive/decompositionRecord';

/** The holding paragraph is in the discarded rule area; only its controls move. */
export function applyBodyStartControls(section: string, body: string): { body: string; unused: number } {
  if (!section.includes(BODY_START_MARKER)) return { body, unused: 0 };
  const parser = new DOMParser({ onError: (_level, message) => { throw new Error(message); } });
  const template = parser.parseFromString(section, 'application/xml');
  const holder = descendants(template, 'p', NS.para).find(p => descendants(p, 't', NS.para).map(t => t.textContent ?? '').join('') === BODY_START_MARKER);
  const controls = holder ? descendants(holder, 'ctrl', NS.para).filter(c => descendants(c, 'newNum', NS.para).length || descendants(c, 'pageHiding', NS.para).length) : [];
  if (!controls.length) return { body, unused: 0 };
  const paragraph = /<hp:p\b[^>]*>/.exec(body);
  if (!paragraph) return { body, unused: controls.length };
  // Serialize only the controls, with the template root supplying their inherited
  // namespaces. Serializing detached paragraphs would add xmlns on every one.
  const wrapper = template.documentElement!.cloneNode(false);
  for (const control of controls) wrapper.appendChild(control.cloneNode(true));
  const wrapped = new XMLSerializer().serializeToString(wrapper);
  const controlXml = wrapped.slice(wrapped.indexOf('>') + 1, wrapped.lastIndexOf('</'));
  const start = paragraph.index, end = start + paragraph[0].length;
  if (paragraph[0].endsWith('/>')) return { body: body.slice(0, end - 2) + `><hp:run>${controlXml}</hp:run></hp:p>` + body.slice(end), unused: 0 };
  const run = /^\s*<hp:run\b[^>]*>/.exec(body.slice(end));
  if (run) {
    const runEnd = end + run[0].length;
    const insertion = run[0].endsWith('/>') ? runEnd - 2 : runEnd;
    return { body: body.slice(0, insertion) + (run[0].endsWith('/>') ? `>${controlXml}</hp:run>` : controlXml) + body.slice(runEnd), unused: 0 };
  }
  // A new control-only run belongs directly to the first paragraph, never to a
  // nested cell/footnote paragraph. The rest of the rendered string is untouched.
  return { body: body.slice(0, end) + `<hp:run>${controlXml}</hp:run>` + body.slice(end), unused: 0 };
}
