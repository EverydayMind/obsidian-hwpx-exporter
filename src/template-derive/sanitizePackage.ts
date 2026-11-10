import JSZip from 'jszip';
import { DOMImplementation, type Document } from '@xmldom/xmldom';
import { allElements, OPF, serialize } from './dom';
import { descendants, first, is, NS } from './xml';
import { byteDigest } from './digest';
import { StyleError } from './limits';

export type Asset = { id: string; path: string; bytes: Uint8Array; mediaType: string; sha256: string };
export function sanitizeHeader(header: Document, section: Document): void {
  const paragraphs = new Map(descendants(header, 'paraPr', NS.head).map(node => [node.getAttribute('id'), node]));
  const styles = new Map(descendants(header, 'style', NS.head).map(node => [node.getAttribute('id'), node]));
  const usedNumberings = new Set<string>();
  for (const paragraph of descendants(section, 'p', NS.para)) {
    const id = paragraph.getAttribute('paraPrIDRef') ?? styles.get(paragraph.getAttribute('styleIDRef'))?.getAttribute('paraPrIDRef');
    const heading = first(id ? paragraphs.get(id) : undefined, 'heading', NS.head), type = heading?.getAttribute('type');
    if (type === 'NUMBER' || type === 'OUTLINE') {
      const numbering = type === 'OUTLINE' ? first(section, 'secPr', NS.para)?.getAttribute('outlineShapeIDRef') ?? heading?.getAttribute('idRef') : heading?.getAttribute('idRef');
      if (numbering) usedNumberings.add(numbering);
    }
  }
  for (const element of allElements(header)) {
    if (is(element, 'style', NS.head)) { element.setAttribute('name', `Style${element.getAttribute('id')}`); element.setAttribute('engName', `Style${element.getAttribute('id')}`); }
    for (const name of ['author', 'description', 'title', 'memo']) element.removeAttribute(name);
    if (element.getAttribute('binaryItemIDRef') || element.getAttribute('isEmbedded') === '1') throw new StyleError('unsupported', 'Header image fills/embedded fonts are not yet supported.');
    for (const child of Array.from(element.childNodes)) if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim()) {
      if (element.localName === 'paraHead') {
        // Only numbering syntax and punctuation. Never retain arbitrary words
        // hidden in unused numbering/style definitions.
        if (!/^[\s\d^#%().,\-[\]{}]+$/.test(child.nodeValue)) {
          let parent = element.parentNode;
          while (parent?.nodeType === 1 && (parent as import('@xmldom/xmldom').Element).localName !== 'numbering') parent = parent.parentNode;
          const numberingId = parent?.nodeType === 1 ? (parent as import('@xmldom/xmldom').Element).getAttribute('id') : null;
          if (numberingId && usedNumberings.has(numberingId)) throw new StyleError('unsupported', 'Textual numbering needs explicit supported preservation; it cannot be silently replaced.');
          child.nodeValue = '^1.';
        }
      } else child.nodeValue = '';
    }
    const itemCount = element.getAttribute('itemCnt');
    if (itemCount !== null) element.setAttribute('itemCnt', String(Array.from(element.childNodes).filter(node => node.nodeType === 1).length));
  }
}

export function collectAssets(section: Document, sourcePackage: Document, zip: Map<string, Uint8Array>): Asset[] {
  const items = new Map(descendants(sourcePackage, 'item', OPF).map(item => [item.getAttribute('id'), item]));
  const ids = new Set<string>();
  for (const element of allElements(section)) for (const attr of Array.from(element.attributes)) {
    if (attr.localName === 'binaryItemIDRef' && attr.value) ids.add(attr.value);
    if (/^(?:href|src)$/i.test(attr.localName ?? '') && /^(?:https?:|file:|\/\/)/i.test(attr.value)) throw new StyleError('unsupported', 'External resource reference.');
  }
  const assets: Asset[] = [];
  for (const id of ids) {
    const item = items.get(id), href = item?.getAttribute('href') ?? '';
    const path = href.startsWith('../BinData/') ? href.slice(3) : href.startsWith('BinData/') ? href : href.startsWith('/BinData/') ? href.slice(1) : '';
    if (!path || !/^BinData\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|bmp)$/i.test(path) || path.includes('..')) throw new StyleError('unsupported', 'Unsupported/missing embedded image reference.');
    const bytes = zip.get(path); if (!bytes) throw new StyleError('corrupted', 'Referenced image missing.');
    const mediaType = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' } as Record<string, string>)[path.split('.').pop()!.toLowerCase()];
    assets.push({ id, path, bytes, mediaType, sha256: byteDigest(bytes) });
  }
  return assets;
}

/** Rebuild package metadata and allow-list members. Original paths, previews,
 * thumbnails, comments, histories and unreferenced resources never pass through. */
export function newPackageManifest(assets: Asset[]): Document {
  const document = new DOMImplementation().createDocument(OPF, 'opf:package', null), root = document.documentElement!;
  root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:opf', OPF);
  root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:dc', 'http://purl.org/dc/elements/1.1/');
  root.setAttribute('version', '2.0'); root.setAttribute('unique-identifier', 'report-style');
  const metadata = document.createElementNS(OPF, 'opf:metadata'); root.appendChild(metadata);
  const title = document.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:title'); title.appendChild(document.createTextNode('Report style template')); metadata.appendChild(title);
  const manifest = document.createElementNS(OPF, 'opf:manifest'); root.appendChild(manifest);
  for (const entry of [{ id: 'header', href: 'Contents/header.xml', mediaType: 'application/xml' }, { id: 'section0', href: 'Contents/section0.xml', mediaType: 'application/xml' }, ...assets.map(asset => ({ id: asset.id, href: asset.path, mediaType: asset.mediaType }))]) {
    const item = document.createElementNS(OPF, 'opf:item'); item.setAttribute('id', entry.id); item.setAttribute('href', entry.href); item.setAttribute('media-type', entry.mediaType); manifest.appendChild(item);
  }
  const spine = document.createElementNS(OPF, 'opf:spine'); root.appendChild(spine);
  for (const id of ['header', 'section0']) { const item = document.createElementNS(OPF, 'opf:itemref'); item.setAttribute('idref', id); item.setAttribute('linear', 'yes'); spine.appendChild(item); }
  return document;
}
export async function packageBytes(header: Document, section: Document, manifest: Document, assets: Asset[]): Promise<Uint8Array> {
  const output = new JSZip();
  output.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  output.file('version.xml', '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="13.0"/>');
  output.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>');
  output.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
  output.file('Contents/header.xml', Buffer.from(serialize(header)));
  output.file('Contents/section0.xml', Buffer.from(serialize(section)));
  output.file('Contents/content.hpf', Buffer.from(serialize(manifest)));
  for (const asset of assets) output.file(asset.path, asset.bytes);
  return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
