const {key,locate,createLocator} = require('./SpeechAnchor');
const selector = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,.reader-epigraph-author,.reader-opening-title';
const indexes = new WeakMap();

function blocks(scroller) {
    const root = scroller?.querySelector('.reader-html');
    if (!root) return [];
    return Array.from(root.querySelectorAll(selector)).filter(node => !node.closest('.reader-notes') && !node.querySelector(selector)).map(node => {
        const copy = node.cloneNode(true);
        for (const note of copy.querySelectorAll('.reader-note-link')) note.remove();
        return {node,text:String(copy.textContent || '').replace(/\s+/g,' ').trim()};
    });
}

function capture(scroller) {
    if (!scroller) return null;
    const bounds = scroller.getBoundingClientRect();
    const rows = blocks(scroller);
    let offset = 0;
    for (const row of rows) {
        const rect = row.node.getBoundingClientRect(), length = key(row.text).length;
        if (length >= 8 && rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top + 4 && rect.top < bounds.bottom
            && rect.right > bounds.left && rect.left < bounds.right) {
            return {mode:'scroll',textSnippet:row.text.slice(0,180),textOffset:-1,sourceOffset:offset};
        }
        offset += length;
    }
    return null;
}

function find(scroller, anchor) {
    const rows = blocks(scroller);
    if (!rows.length) return null;
    try {return rows[locate(rows,anchor)].node;} catch {return null;}
}

function rectAtTextOffset(block, offset) {
    const doc = block.ownerDocument;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement.closest('.reader-note-link') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.nodeValue;
        const length = key(text).length;
        if (offset >= length) {
            offset -= length;
            continue;
        }
        let start = 0, end = text.length;
        while (end - start > 1) {
            const middle = Math.floor((start + end) / 2);
            if (key(text.slice(0, middle)).length <= offset) start = middle;
            else end = middle;
        }
        const range = doc.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0) return rect;
        break;
    }
    return block.getBoundingClientRect();
}

function findTextRect(scroller, anchor) {
    const documentStart = scroller?.querySelector('.reader-html')?.firstChild;
    if (!documentStart) return null;
    let cached = indexes.get(documentStart);
    if (!cached) {
        const rows = blocks(scroller);
        if (!rows.length) return null;
        cached = {rows, locate:createLocator(rows)};
        indexes.set(documentStart, cached);
    }
    try {
        const {index, offset} = cached.locate(anchor);
        return rectAtTextOffset(cached.rows[index].node, offset);
    } catch {return null;}
}

module.exports = {capture,find,findTextRect};
