// HTML from library files (author bios, FB2 annotations) is shown with v-html. Everything is escaped
// first, then a few formatting tags come back without any attributes and the rest are dropped: no
// handler, link or style survives, whatever the input.
const allowedTags = 'p|br|b|i|u|em|strong|h[1-6]|sub|sup|ul|ol|li|blockquote|div|span';
// Attributes are dropped: only a bare <tag> or </tag> is ever produced.
const tagPattern = new RegExp(`&lt;(\\/?)(${allowedTags})(?:\\s(?:(?!&lt;|&gt;)[\\s\\S])*)?\\/?&gt;`, 'gi');

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeHtml(html = '') {
    return escapeHtml(html)
        .replace(tagPattern, (match, slash, tag) => `<${slash}${tag.toLowerCase()}>`)
        // Other tags (FB2's <subtitle>, <script>, <img>) are dropped; their text stays.
        .replace(/&lt;\/?[a-z][\w:.-]*(?:\s(?:(?!&lt;|&gt;)[\s\S])*)?\/?&gt;/gi, '')
        // Character references are text, never markup: keep &nbsp;, &#171; and the like.
        .replace(/&amp;(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, '&$1;');
}

module.exports = {escapeHtml, safeHtml};
