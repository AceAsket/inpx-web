const {key,locate} = require('./SpeechAnchor');
const selector = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,.reader-epigraph-author,.reader-opening-title';

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

module.exports = {capture,find};
