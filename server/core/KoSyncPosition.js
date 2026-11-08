const fs = require('fs-extra');
const sax = require('sax');
const {key} = require('../../shared/SpeechAnchor');

const blockTags = new Set(['p', 'v', 'subtitle', 'text-author', 'td', 'th']);
const normalizePath = value => String(value || '').toLowerCase()
    .replace(/\/(?:autoboxing|floatboxing|inlinebox|pseudoelem)(?:\[\d+\])?/g, '')
    .replace(/\/text\(\)(?:\.\d+)?(?:.*)?$/, '')
    .replace(/\/([a-z-]+)(?![a-z-]|\[)/g, '/$1[1]')
    .replace(/^\/fictionbook\[1\]/, '/fictionbook');

// Parse incrementally: large FB2 image binaries must never become one in-memory XML string.
async function indexFile(file) {
    const stat = await fs.stat(file);
    if (stat.size > 64 * 1024 * 1024) throw new Error('FB2 превышает лимит KOSync (64 МБ)');
    const parser = sax.parser(true, {lowercase: false});
    const stack = [], blocks = [];
    let total = 0;
    parser.onopentag = node => {
        const name = node.name.split(':').pop().toLowerCase();
        const parent = stack[stack.length - 1];
        const ordinal = parent ? (parent.counts[name] = (parent.counts[name] || 0) + 1) : 1;
        const inBody = parent?.inBody || name === 'body';
        const skip = parent?.skip || name === 'binary' || (name === 'body' && /^(notes|comments)$/i.test(node.attributes.name || ''))
            || (name === 'a' && node.attributes.type === 'note');
        const path = parent ? `${parent.path}/${name}[${ordinal}]` : '/FictionBook';
        stack.push({name, path, counts: {}, inBody, skip, text: '', length: 0, nested: false});
        if (inBody && !skip && blockTags.has(name)) {
            for (const frame of stack.slice(0, -1)) if (blockTags.has(frame.name)) frame.nested = true;
        }
    };
    const append = text => {
        if (!stack[stack.length - 1]?.inBody || stack[stack.length - 1]?.skip) return;
        for (let i = stack.length - 1; i >= 0; i--) {
            const frame = stack[i];
            if (!blockTags.has(frame.name)) continue;
            frame.length += text.length;
            if (frame.text.length < 4096) frame.text += text.slice(0, 4096 - frame.text.length);
            break;
        }
    };
    parser.ontext = append; parser.oncdata = append;
    parser.onclosetag = () => {
        const frame = stack.pop();
        if (!frame.inBody || frame.skip || frame.nested || !blockTags.has(frame.name)) return;
        const text = frame.text.replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (blocks.length >= 50000 || total + text.length > 2 * 1024 * 1024) throw new Error('Слишком большой текстовый индекс KOSync');
        blocks.push({path: frame.path, text, offset: total}); total += frame.length;
    };
    const stream = fs.createReadStream(file, {encoding: 'utf8', highWaterMark: 16384});
    try {
        for await (const chunk of stream) parser.write(chunk);
        parser.close();
    } finally { stream.destroy(); }
    return {blocks, total};
}

function fromKo(index, pointer) {
    const path = normalizePath(pointer);
    const block = index.blocks.find(row => path === normalizePath(row.path) || path.startsWith(normalizePath(row.path) + '/'));
    return block ? {textSnippet: block.text.slice(0, 240), textOffset: -1, sectionId: '', pageIndex: 0} : null;
}

function toKo(index, progress) {
    if (!index.blocks.length) return null;
    const snippet = key(progress.textSnippet).slice(0, 80);
    const target = Math.max(0, Math.min(1, Number(progress.percent) || 0)) * index.total;
    const matches = snippet.length >= 8 ? index.blocks.filter(row => key(row.text).includes(snippet)) : [];
    // A fraction is not an exact text anchor; use it only to choose between repeated quotes.
    if (!matches.length && Number(progress.percent) > 0) return null;
    const block = matches.length ? matches.reduce((best, row) => Math.abs(row.offset - target) < Math.abs(best.offset - target) ? row : best) : index.blocks[0];
    return `${block.path}/text().0`;
}

module.exports = {indexFile, fromKo, toKo, normalizePath};
