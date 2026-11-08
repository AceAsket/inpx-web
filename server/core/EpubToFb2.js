const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const StreamZip = require('node-stream-zip');
const sax = require('sax');
const he = require('he');
const iconv = require('iconv-lite');
const {crc32} = require('zlib');

const version = 'epub-fb2-v1';
const MB = 1024 * 1024;
const ignored = new Set(['head', 'script', 'style', 'nav', 'noscript', 'iframe', 'object']);
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'figure', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'hr']);
const styled = {b:'strong', strong:'strong', i:'emphasis', em:'emphasis', s:'strikethrough', del:'strikethrough',
    strike:'strikethrough', sup:'sup', sub:'sub', code:'code', kbd:'code'};
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[ch]));
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const attr = (node, name) => node.attrs?.[name] || '';
const elements = node => (node.children || []).filter(child => typeof child !== 'string');
function all(node, name) {
    const result = [], stack = elements(node).reverse();
    while (stack.length) {
        const child = stack.pop(); if (!name || child.name === name) result.push(child);
        const children = elements(child); for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return result;
}
function text(node) {
    const result = [], stack = [node];
    while (stack.length) {
        const child = stack.pop();
        if (typeof child === 'string') result.push(child);
        else if (child.name === 'br') result.push('\n');
        else if (!ignored.has(child.name)) for (let i = (child.children || []).length - 1; i >= 0; i--) stack.push(child.children[i]);
    }
    return result.join('');
}
const plain = node => text(node).replace(/\s+/g, ' ').trim();
const note = node => /\b(?:footnote|endnote)\b/.test(attr(node, 'epub:type')) || /\bdoc-(?:footnote|endnote)\b/.test(attr(node, 'role'));
function invalid(message) {return Object.assign(new Error(`Не удалось преобразовать EPUB в FB2: ${message}`), {code:'INPX_INVALID_EPUB'});}

function entryName(name) {
    if (!name || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => part === '..'))
        throw invalid('недопустимый путь внутри книги');
    return path.posix.normalize(name);
}

function reference(file, value) {
    value = String(value || '').trim();
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(value)) return {external: value};
    const raw = value.split(/[?#]/)[0];
    let name, fragment;
    try {name = decodeURIComponent(raw); fragment = decodeURIComponent(value.includes('#') ? value.slice(value.indexOf('#') + 1) : '');}
    catch {throw invalid('повреждённая ссылка на ресурс');}
    if (/^[\/\\]|[\\:\x00-\x1f\x7f]/.test(name)) throw invalid('абсолютный путь к ресурсу');
    return {file: raw ? entryName(path.posix.join(path.posix.dirname(file), name)) : file, fragment};
}

function xml(data, check) {
    let source;
    const declared = data.subarray(0, 200).toString('ascii').match(/encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (data[0] === 0xff && data[1] === 0xfe) source = iconv.decode(data, 'utf16le');
    else if (data[0] === 0xfe && data[1] === 0xff) source = iconv.decode(data, 'utf16be');
    else if (declared && !/^utf-?8$/i.test(declared) && iconv.encodingExists(declared)) source = iconv.decode(data, declared);
    else {
        try {source = new TextDecoder('utf-8', {fatal: true}).decode(data);}
        catch {throw invalid('неподдерживаемая кодировка документа');}
    }
    if (/<!ENTITY|\bxml:base\s*=/i.test(source)) throw invalid('XML entities и xml:base не поддерживаются');
    // XHTML's named HTML entities become numeric XML entities, without a DTD or network access.
    source = source.replace(/&([a-z][a-z\d]+);/gi, (entity, name) => {
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return entity;
        const decoded = he.decode(entity);
        return decoded === entity ? entity : Array.from(decoded, ch => `&#${ch.codePointAt(0)};`).join('');
    });
    const root = {name:'root', children:[]}, stack = [root];
    let count = 0;
    const parser = sax.parser(true, {trim:false});
    parser.onerror = error => {throw error;};
    const tick = () => {check(); if (++count > 250000) throw invalid('слишком много элементов документа');};
    parser.onopentag = tag => {
        tick(); if (stack.length > 128) throw invalid('слишком глубокая вложенность документа');
        const node = {name: tag.name.split(':').pop().toLowerCase(), attrs:Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key.toLowerCase(), value])), children:[], index:count};
        stack.at(-1).children.push(node); stack.push(node);
    };
    const append = value => {tick(); const children = stack.at(-1).children; if (typeof children.at(-1) === 'string') children[children.length - 1] += value; else children.push(value);};
    parser.ontext = append; parser.oncdata = append; parser.onclosetag = () => stack.pop();
    try {parser.write(source).close();}
    catch (error) {if (error.code) throw error; throw invalid('некорректный XML/XHTML');}
    return root;
}

async function convert(input, output, options = {}) {
    const deadline = Math.min(options.deadline || Infinity, Date.now() + (options.timeoutMs || 120000)), signal = options.signal;
    const maxOutput = Math.min(256 * MB, Number(options.maxOutputBytes) || 256 * MB);
    const check = () => {
        if (signal?.aborted) throw Object.assign(new Error('Конвертация отменена'), {code:'ABORT_ERR'});
        if (Date.now() > deadline) throw Object.assign(new Error('Превышено время конвертации EPUB'), {code:'INPX_CONVERSION_TIMEOUT'});
    };
    const zip = new StreamZip.async({file:input});
    let handle, written = 0, success = false, createdOutput = false;
    const images = new Map(), imageAliases = new Map(), ids = new Map(), notes = [], noteLabels = new Map();
    try {
        const entries = Object.values(await zip.entries()), files = new Map();
        if (entries.length > 10000 || entries.length !== await zip.entriesCount) throw invalid('слишком много файлов или повторяющиеся имена');
        let expanded = 0;
        const names = new Set();
        for (const entry of entries) {
            check(); const name = entryName(entry.name.replace(/\/$/, ''));
            if (names.has(name.toLowerCase())) throw invalid('повторяющийся путь');
            names.add(name.toLowerCase());
            if (((entry.attr >>> 16) & 0o170000) === 0o120000 || (entry.flags & 1)) throw invalid('символическая ссылка или зашифрованный архив');
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * MB || (expanded += entry.size) > 256 * MB)
                throw invalid('превышен распакованный размер книги');
            if (!entry.isDirectory) files.set(name, entry);
        }
        async function* chunks(name, limit = 64 * MB) {
            check(); const entry = files.get(name);
            if (!entry) throw invalid(`не найден ресурс ${name}`);
            if (entry.size > limit) throw invalid('ресурс превышает допустимый размер');
            const stream = await zip.stream(entry.name);
            let size = 0, crc = 0;
            try {for await (const chunk of stream) {check(); size += chunk.length; if (size > limit) throw invalid('ресурс превышает допустимый размер'); crc = crc32(chunk, crc); yield chunk;}}
            finally {stream.destroy();}
            if (size !== entry.size) throw invalid('неверный распакованный размер ресурса');
            if (crc !== entry.crc) throw invalid('неверная контрольная сумма ресурса');
        }
        async function read(name, limit = 16 * MB) {const data = []; for await (const chunk of chunks(name, limit)) data.push(chunk); return Buffer.concat(data);}
        const parsed = async(name, limit) => xml(await read(name, limit), check);
        if ((await read('mimetype', 128)).toString().trim() !== 'application/epub+zip') throw invalid('неверный mimetype');
        const container = await parsed('META-INF/container.xml', MB);
        const rootfile = all(container, 'rootfile').find(node => attr(node, 'media-type') === 'application/oebps-package+xml') || all(container, 'rootfile')[0];
        const packagePath = rootfile && reference('container.xml', attr(rootfile, 'full-path'));
        if (!packagePath?.file) throw invalid('не найден OPF');
        const opf = await parsed(packagePath.file, 4 * MB), metadata = all(opf, 'metadata')[0];
        if (!metadata) throw invalid('не найдены метаданные OPF');
        const values = name => elements(metadata).filter(node => node.name === name).map(plain).filter(Boolean);
        const manifest = new Map();
        for (const item of all(opf, 'manifest').flatMap(elements)) {
            if (!attr(item, 'id') || manifest.has(attr(item, 'id'))) throw invalid('неверный manifest OPF');
            const ref = reference(packagePath.file, attr(item, 'href'));
            manifest.set(attr(item, 'id'), {file:ref.file, external:ref.external, type:attr(item, 'media-type'), properties:attr(item, 'properties'), fallback:attr(item, 'fallback')});
        }
        const encrypted = new Set();
        if (files.has('META-INF/encryption.xml')) for (const node of all(await parsed('META-INF/encryption.xml', MB), 'cipherreference')) {
            const ref = reference('encryption.xml', attr(node, 'uri')); if (ref.file) encrypted.add(ref.file);
        }
        const usable = name => {if (encrypted.has(name)) throw invalid('содержимое защищено шифрованием');};
        const manifestFiles = new Map([...manifest.values()].filter(item => item.file).map(item => [item.file, item]));
        const chapterId = file => `c_${hash(file)}`;
        const nodeId = (file, node) => `n_${hash(file + '\0' + (attr(node, 'id') || attr(node, 'xml:id') || node.index))}`;
        function index(node, file, blockId = chapterId(file)) {
            if (typeof node === 'string') return;
            if (blocks.has(node.name) || note(node)) blockId = node._id = nodeId(file, node);
            for (const name of [attr(node, 'id'), attr(node, 'xml:id'), node.name === 'a' && attr(node, 'name')].filter(Boolean)) {
                const key = file + '#' + name;
                if (ids.has(key)) throw invalid('повторяющийся идентификатор в главе');
                ids.set(key, blockId);
            }
            for (const child of node.children || []) index(child, file, blockId);
        }
        let dataImageBytes = 0;
        const imageKey = (file, src) => src.startsWith('data:') ? `data:${hash(src)}` : reference(file, src).file;
        async function image(file, src, trail = new Set()) {
            const key = imageKey(file, src);
            if (!key) throw invalid('удалённые изображения недоступны для преобразования');
            if (imageAliases.has(key)) return imageAliases.get(key);
            if (trail.has(key)) throw invalid('циклическая ссылка SVG');
            trail.add(key);
            let data, type = '';
            if (src.startsWith('data:')) {
                const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\s]+)$/i.exec(src);
                if (!match || src.length > 12 * MB) throw invalid('неподдерживаемое встроенное изображение');
                data = Buffer.from(match[2], 'base64'); dataImageBytes += data.length;
                if (dataImageBytes > 32 * MB) throw invalid('слишком много встроенных изображений');
                type = match[1].toLowerCase();
            } else {
                usable(key);
                type = manifestFiles.get(key)?.type || ({'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml'}[path.posix.extname(key).toLowerCase()] || '');
                if (type === 'image/svg+xml') {
                    const svg = await parsed(key, 2 * MB), embedded = all(svg, 'image');
                    if (embedded.length !== 1 || all(svg).some(node => ['path','rect','circle','polygon','polyline','line','text','ellipse'].includes(node.name)))
                        throw invalid('векторную SVG-иллюстрацию нельзя перенести в FB2 без потери содержимого');
                    const result = await image(key, attr(embedded[0], 'href') || attr(embedded[0], 'xlink:href'), trail);
                    imageAliases.set(key, result); return result;
                }
            }
            if (!['image/png','image/jpeg','image/gif','image/webp'].includes(type)) throw invalid('неподдерживаемый формат иллюстрации');
            const result = {id:`img_${hash(key)}`, file:data ? '' : key, data, type};
            images.set(result.id, result); imageAliases.set(key, result); return result;
        }
        const queue = [], queued = new Set();
        function addChapter(item, linear) {
            const seen = new Set();
            while (item && !['application/xhtml+xml','text/html'].includes(item.type)) {
                if (seen.has(item) || !item.fallback) throw invalid('неподдерживаемый документ в порядке чтения');
                seen.add(item); item = manifest.get(item.fallback);
            }
            if (!item?.file || item.external) throw invalid('не найден локальный документ главы');
            usable(item.file);
            if (!queued.has(item.file) && !item.properties.split(/\s+/).includes('nav')) {
                queued.add(item.file); queue.push({file:item.file, linear});
                if (queue.length > 2000) throw invalid('слишком много глав');
            }
        }
        const spine = all(opf, 'spine')[0];
        if (!spine) throw invalid('не найден порядок чтения spine');
        for (const ref of elements(spine).filter(node => node.name === 'itemref')) addChapter(manifest.get(attr(ref, 'idref')), attr(ref, 'linear') !== 'no');
        if (!queue.some(item => item.linear)) throw invalid('в книге нет глав для чтения');
        // First pass resolves cross-chapter anchors and discovers linked notes. Trees are not retained.
        for (let i = 0; i < queue.length; i++) {
            const item = queue[i], doc = await parsed(item.file), body = all(doc, 'body')[0];
            if (!body) throw invalid('в главе нет body');
            ids.set(item.file + '#', chapterId(item.file)); index(body, item.file);
            const heading = all(body).find(node => /^h[1-6]$/.test(node.name) && plain(node));
            item.heading = heading?.index; item.title = heading ? plain(heading) : all(doc, 'title').map(plain).find(Boolean) || '';
            for (const node of all(body)) {
                if (node.name === 'svg' && all(node).some(child => ['path','rect','circle','polygon','polyline','line','text','ellipse'].includes(child.name)))
                    throw invalid('векторную SVG-иллюстрацию нельзя перенести в FB2 без потери содержимого');
                if (node.name === 'img' || node.name === 'image') await image(item.file, attr(node, 'src') || attr(node, 'href') || attr(node, 'xlink:href'));
                if (node.name === 'a' && attr(node, 'href')) {
                    const ref = reference(item.file, attr(node, 'href')), target = manifestFiles.get(ref.file);
                    if (target && ['application/xhtml+xml','text/html'].includes(target.type)) addChapter(target, false);
                    if (ref.file && (/\bnoteref\b/.test(attr(node, 'epub:type')) || attr(node, 'role') === 'doc-noteref')) noteLabels.set(ref.file + '#' + ref.fragment, plain(node));
                }
            }
        }
        const coverId = elements(metadata).find(node => node.name === 'meta' && attr(node, 'name') === 'cover');
        const cover = [...manifest.values()].find(item => item.properties.split(/\s+/).includes('cover-image')) || manifest.get(attr(coverId || {}, 'content'));
        const coverImage = cover?.file ? await image(packagePath.file, path.posix.relative(path.posix.dirname(packagePath.file), cover.file)) : null;
        async function write(value) {
            check(); const data = Buffer.from(value, 'utf8'); written += data.length;
            if (written > maxOutput) throw invalid('превышен размер результата');
            for (let offset = 0; offset < data.length;) {const result = await handle.write(data, offset, data.length - offset); offset += result.bytesWritten;}
        }
        function lines(children, file, inLink = false) {
            const output = [''];
            for (const node of children) {
                const parts = inline(node, file, inLink); output[output.length - 1] += parts[0]; output.push(...parts.slice(1));
            }
            return output;
        }
        function inline(node, file, inLink) {
            if (typeof node === 'string') return [esc(node.replace(/\s+/g, ' '))];
            if (ignored.has(node.name) || note(node)) return [''];
            if (node.name === 'br') return ['', ''];
            if (node.name === 'img' || node.name === 'image') {
                const src = attr(node, 'src') || attr(node, 'href') || attr(node, 'xlink:href');
                const img = imageAliases.get(imageKey(file, src));
                return [img ? `<image l:href="#${img.id}"/>` : esc(attr(node, 'alt'))];
            }
            const content = lines(node.children, file, inLink || node.name === 'a');
            if (styled[node.name]) return content.map(value => value ? `<${styled[node.name]}>${value}</${styled[node.name]}>` : '');
            if (node.name === 'a' && !inLink && attr(node, 'href')) {
                const ref = reference(file, attr(node, 'href'));
                const target = ids.get(ref.file + '#' + ref.fragment);
                const href = target ? '#' + target : /^https?:|^mailto:/i.test(ref.external || '') ? ref.external : '';
                if (href) return content.map(value => `<a l:href="${esc(href)}"${target && (/\bnoteref\b/.test(attr(node, 'epub:type')) || attr(node, 'role') === 'doc-noteref') ? ' type="note"' : ''}>${value}</a>`);
            }
            return content;
        }
        const id = node => node._id ? ` id="${node._id}"` : '';
        function paragraphs(parts, identifier = '', prefix = '', tag = 'p') {
            return parts.map((value, i) => `<${tag}${i === 0 ? identifier : ''}>${i === 0 ? esc(prefix) : ''}${value.trim()}</${tag}>`).join('');
        }
        function flow(children, file, skip, inQuote = false) {
            let output = '', pending = [];
            const flush = () => {if (pending.some(node => typeof node !== 'string' || node.trim())) output += paragraphs(lines(pending, file)); pending = [];};
            for (const node of children) {
                check();
                if (typeof node === 'string' || !blocks.has(node.name) && !note(node)) {pending.push(node); continue;}
                flush(); if (ignored.has(node.name) || node.index === skip) continue;
                if (note(node)) {notes.push({node, file}); continue;}
                if (/^h[1-6]$/.test(node.name)) output += paragraphs(lines(node.children, file), id(node), '', 'subtitle');
                else if (node.name === 'p' || node.name === 'dt' || node.name === 'dd') output += paragraphs(lines(node.children, file), id(node));
                else if (node.name === 'pre') output += text(node).split(/\r?\n/).map((line, i) => `<p${i ? '' : id(node)}><code>${esc(line)}</code></p>`).join('');
                else if (node.name === 'hr') output += `<p${id(node)}>⁂</p>`;
                else if (node.name === 'ul' || node.name === 'ol') {
                    output += `<p${id(node)}/>`;
                    const start = Math.max(1, Math.min(1000000, Number(attr(node, 'start')) || 1));
                    elements(node).filter(child => child.name === 'li').forEach((child, i) => {
                        output += `<p${id(child)}>${esc(node.name === 'ol' ? `${start + i}. ` : '• ')}${lines(child.children.filter(value => typeof value === 'string' || !blocks.has(value.name)), file).join(' ')}</p>`;
                        output += flow(child.children.filter(value => typeof value !== 'string' && blocks.has(value.name)), file, skip, inQuote);
                    });
                } else if (node.name === 'table') {
                    const rows = all(node, 'tr').map(row => elements(row).filter(cell => ['td','th'].includes(cell.name)).map(cell => {
                        const spans = ['colspan','rowspan'].map(key => /^\d{1,3}$/.test(attr(cell, key)) && Number(attr(cell, key)) > 0 ? ` ${key}="${Number(attr(cell, key))}"` : '').join('');
                        return `<${cell.name}${spans}>${lines(cell.children, file).join(' ')}</${cell.name}>`;
                    }).join('')).filter(Boolean);
                    if (rows.length) output += `<table${id(node)}>${rows.map(row => `<tr>${row}</tr>`).join('')}</table>`;
                } else if (node.name === 'blockquote') {
                    const inside = flow(node.children, file, skip, true) || '<p/>';
                    output += inQuote ? `<p${id(node)}/>${inside}` : `<cite${id(node)}>${inside}</cite>`;
                } else {
                    output += `<p${id(node)}/>` + flow(node.children, file, skip, inQuote);
                }
            }
            flush(); return output;
        }
        handle = await fs.open(output, 'wx');
        createdOutput = true;
        const title = values('title')[0] || 'Без названия', authors = values('creator');
        const description = he.decode(values('description').join('\n')).replace(/<br\s*\/?\s*>|<\/p\s*>/gi, '\n').replace(/<[^>]*>/g, '').trim();
        const date = values('date')[0]?.match(/\d{4}(?:-\d{2})?(?:-\d{2})?/)?.[0] || '2000-01-01';
        const language = values('language')[0] || 'und';
        const documentId = values('identifier')[0] || `urn:inpx:${hash(packagePath.file + '\0' + title + '\0' + authors.join(','))}`;
        const publisher = values('publisher')[0] || '', year = values('date')[0]?.match(/\d{4}/)?.[0] || '';
        const isbn = require('../../shared/Isbn').extract(values('identifier').join(' '))[0] || '';
        const publication = publisher || year || isbn ? `<publish-info><book-name>${esc(title)}</book-name>${publisher ? `<publisher>${esc(publisher)}</publisher>` : ''}${year ? `<year>${year}</year>` : ''}${isbn ? `<isbn>${isbn}</isbn>` : ''}</publish-info>` : '';
        const collection = elements(metadata).find(node => node.name === 'meta' && attr(node, 'property') === 'belongs-to-collection');
        const series = collection ? plain(collection) : attr(elements(metadata).find(node => node.name === 'meta' && attr(node, 'name') === 'calibre:series') || {}, 'content');
        const position = collection ? plain(elements(metadata).find(node => node.name === 'meta' && attr(node, 'property') === 'group-position' && attr(node, 'refines') === '#' + attr(collection, 'id')) || {})
            : attr(elements(metadata).find(node => node.name === 'meta' && attr(node, 'name') === 'calibre:series_index') || {}, 'content');
        const sequence = series ? `<sequence name="${esc(series)}"${/^\d{1,6}$/.test(position) ? ` number="${Number(position)}"` : ''}/>` : '';
        await write(`<?xml version="1.0" encoding="UTF-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><genre>other</genre>${(authors.length ? authors : ['Автор не указан']).map(author => `<author><nickname>${esc(author)}</nickname></author>`).join('')}<book-title>${esc(title)}</book-title>${description ? `<annotation>${description.split(/\n+/).map(line => `<p>${esc(line)}</p>`).join('')}</annotation>` : ''}${values('subject').length ? `<keywords>${esc(values('subject').join(', '))}</keywords>` : ''}${coverImage ? `<coverpage><image l:href="#${coverImage.id}"/></coverpage>` : ''}<lang>${esc(language)}</lang>${sequence}</title-info><document-info><author><nickname>INPX Web</nickname></author><program-used>INPX Web ${version}</program-used><date>${esc(date)}</date><id>${esc(documentId)}</id><version>1.0</version></document-info>${publication}</description><body>`);
        const auxiliary = [];
        for (const item of queue) {
            if (!item.linear) {auxiliary.push(item); continue;}
            const doc = await parsed(item.file), body = all(doc, 'body')[0]; indexForRender(body, item.file);
            const heading = item.heading && all(body).find(node => node.index === item.heading);
            const content = flow(body.children, item.file, item.heading);
            await write(`<section id="${chapterId(item.file)}">${item.title ? `<title>${paragraphs(heading ? lines(heading.children, item.file) : [esc(item.title)], heading ? id(heading) : '')}</title>` : ''}${content || '<empty-line/>'}</section>`);
        }
        await write('</body>');
        if (auxiliary.length || notes.length) {
            await write('<body name="notes">');
            for (const item of auxiliary) {
                const doc = await parsed(item.file), body = all(doc, 'body')[0]; indexForRender(body, item.file);
                await write(`<section id="${chapterId(item.file)}">${flow(body.children, item.file) || '<empty-line/>'}</section>`);
            }
            for (let i = 0; i < notes.length; i++) {
                const {node, file} = notes[i];
                const label = noteLabels.get(file + '#' + (attr(node, 'id') || attr(node, 'xml:id'))) || String(i + 1);
                await write(`<section${id(node)}><title><p>${esc(label)}</p></title>${flow(node.children, file) || '<empty-line/>'}</section>`);
            }
            await write('</body>');
        }
        for (const img of images.values()) {
            await write(`<binary id="${img.id}" content-type="${img.type}">`);
            let carry = Buffer.alloc(0), first = true;
            const source = img.data ? [img.data] : chunks(img.file);
            for await (const chunk of source) {
                if (first) {
                    const good = img.type === 'image/png' ? chunk.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex'))
                        : img.type === 'image/jpeg' ? chunk[0] === 0xff && chunk[1] === 0xd8
                            : img.type === 'image/gif' ? chunk.subarray(0,3).toString() === 'GIF'
                                : chunk.subarray(0,4).toString() === 'RIFF' && chunk.subarray(8,12).toString() === 'WEBP';
                    if (!good) throw invalid('формат иллюстрации не соответствует её содержимому');
                    first = false;
                }
                const data = Buffer.concat([carry, chunk]), length = data.length - data.length % 3;
                await write(data.subarray(0, length).toString('base64')); carry = data.subarray(length);
            }
            if (carry.length) await write(carry.toString('base64'));
            await write('</binary>');
        }
        await write('</FictionBook>');
        await handle.close(); handle = null; success = true;
        function indexForRender(node, file) {
            if (typeof node === 'string') return;
            if (blocks.has(node.name) || note(node)) node._id = nodeId(file, node);
            for (const child of node.children || []) indexForRender(child, file);
        }
    } finally {
        if (handle) await handle.close().catch(() => {});
        await zip.close().catch(() => {});
        if (!success && createdOutput) await fs.rm(output, {force:true}).catch(() => {});
    }
}

module.exports = {convert, version};
