const path = require('path');
const StreamZip = require('node-stream-zip');
const he = require('he');

const maxExpanded = 512 * 1024 * 1024;
const maxEntry = 64 * 1024 * 1024;

function invalid(message) {
    return Object.assign(new Error(`Небезопасный EPUB для MOBI: ${message}`), {code:'INPX_UNSAFE_MOBI_EPUB'});
}

function hasControl(value) {
    for (const char of value) if (char.charCodeAt(0) < 32) return true;
    return false;
}

function safePath(name) {
    if (!name || name === '.' || name.startsWith('/') || /[\\:]/.test(name) || hasControl(name) ||
        name.split('/').some(part => part === '..' || (part !== '.' && /[. ]$/.test(part)) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
        throw invalid('некорректный путь внутри книги');
}

function checkReference(value, directory) {
    value = he.decode(String(value)).trim();
    // Decode before resolving, including entity-escaped and percent-encoded
    // separators. Both literal and decoded paths must stay within the EPUB.
    for (let i = 0; i < 3; i++) {
        if (/^(?:https?:|mailto:|tel:|data:)/i.test(value) || value.startsWith('#')) return;
        const reference = value.split(/[?#]/)[0];
        if (reference) {
            if (/^[\\/]|[\\:]/.test(reference) || hasControl(reference)) throw invalid('абсолютная ссылка на файл');
            const resolved = path.posix.normalize(path.posix.join(directory, reference));
            if (resolved === '..' || resolved.startsWith('../')) throw invalid('ссылка за пределы книги');
            safePath(resolved);
        }
        let decoded;
        try { decoded = decodeURIComponent(value); } catch (error) { break; }
        if (decoded === value) break;
        value = decoded;
    }
}

async function validateEpubForMobi(file) {
    const zip = new StreamZip.async({file});
    try {
        const entries = Object.values(await zip.entries());
        if (entries.length > 10000 || await zip.entriesCount !== entries.length) throw invalid('слишком много файлов или повторяющиеся имена');
        let expanded = 0;
        const seen = new Set();
        for (const entry of entries) {
            const name = entry.name.replace(/\/$/, '');
            safePath(name);
            const key = path.posix.normalize(name).toLowerCase();
            if (seen.has(key)) throw invalid('повторяющийся путь');
            seen.add(key);
            if (((entry.attr >>> 16) & 0o170000) === 0o120000) throw invalid('символическая ссылка');
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxEntry || (expanded += entry.size) > maxExpanded)
                throw invalid('превышен распакованный размер книги (512 МБ суммарно, 64 МБ на файл)');
        }
        const container = entries.find(entry => entry.name === 'META-INF/container.xml' && !entry.isDirectory);
        if (!container) throw invalid('нет META-INF/container.xml');
        const containerText = (await zip.entryData(container.name)).toString('utf8');
        for (const match of containerText.matchAll(/\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
            const root = he.decode(match[1] ?? match[2]);
            checkReference(root, '');
        }
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const data = await zip.entryData(entry.name);
            if (data.length > maxEntry) throw invalid('превышен размер файла');
            let content;
            try { content = new TextDecoder('utf-8', {fatal:true}).decode(data); }
            catch (error) { continue; } // Binary images/fonts are not parsed as XML/CSS by Kindling.
            if (/<!ENTITY|\bxml:base\s*=/i.test(content)) throw invalid('XML entities или xml:base');
            const directory = path.posix.dirname(entry.name);
            const check = value => checkReference(value, directory === '.' ? '' : directory);
            // Inspect every UTF-8 resource, regardless of its extension: OPF can
            // declare HTML or CSS under an arbitrary archive filename.
            for (const match of content.matchAll(/\b(?:[\w-]+:)?(?:href|src|full-path|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi))
                check(match[1] ?? match[2] ?? match[3]);
            const css = he.decode(content).replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
            for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi))
                check(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
        }
    } catch (error) {
        if (error.code === 'INPX_UNSAFE_MOBI_EPUB') throw error;
        throw invalid('архив повреждён или содержит недопустимые пути');
    } finally { await zip.close().catch(() => {}); }
}

module.exports = {validateEpubForMobi};
