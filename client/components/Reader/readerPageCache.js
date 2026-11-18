import {sha256} from '../../share/cryptoUtils';

// Keep a few recently built layouts, with a separate bound for illustrated books.
const maxLayouts = 8;
const maxLayoutCharacters = 8 * 1024 * 1024;
let connection;

export function available() {
    try { return !!globalThis.indexedDB; }
    catch { return false; }
}

function database() {
    if (!connection) {
        connection = new Promise((resolve) => {
            const request = indexedDB.open('inpx.reader.pages', 1);
            let blocked = false;
            request.onblocked = () => { blocked = true; resolve(null); };
            request.onupgradeneeded = () => {
                request.result.createObjectStore('layouts').createIndex('writtenAt', 'writtenAt');
            };
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const db = request.result;
                if (blocked) { db.close(); connection = null; return; }
                db.onversionchange = () => { db.close(); connection = null; };
                resolve(db);
            };
        });
    }
    return connection;
}

export async function documentDigest(parts) {
    try {
        // Include the cover and catalogue metadata that are inserted before the body.
        const source = parts.map(value => String(value ?? '')).map(value => value.length + ':' + value).join('');
        const bytes = globalThis.crypto?.subtle
            ? new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))
            : sha256(source); // LAN readers also work over plain HTTP.
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    } catch {
        return '';
    }
}

export function storageKey(digest, scope, layout, element) {
    if (!digest || !layout) return '';
    try {
        const style = getComputedStyle(element);
        const context = document.createElement('canvas').getContext('2d');
        if (!context) return '';
        context.font = style.fontSize + ' ' + style.fontFamily;
        return JSON.stringify([location.pathname, scope, digest, layout, navigator.userAgent,
            window.devicePixelRatio, context.font, context.measureText('ЖжWim 012').width,
            typeof __webpack_hash__ === 'string' ? __webpack_hash__ : 'layout-v1']);
    } catch {
        return '';
    }
}

async function lookup(key) {
    const db = await database();
    if (!db) return null;
    return new Promise((resolve) => {
        const request = db.transaction('layouts').objectStore('layouts').get(key);
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
            const pages = request.result?.pages;
            resolve(Array.isArray(pages) && pages.length && pages.every(page =>
                typeof page?.html === 'string' && typeof page.footnotesHtml === 'string' &&
                typeof page.sectionId === 'string' && Array.isArray(page.anchorIds)) ? pages : null);
        };
    });
}

async function withStorageTimeout(operation) {
    // Storage can be blocked by another tab or unavailable in private browsing.
    let timeout;
    try {
        return await Promise.race([operation, new Promise(resolve => {
            timeout = setTimeout(resolve, 1500, null);
        })]);
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export function readPages(key) {
    return key ? withStorageTimeout(lookup(key)) : null;
}

async function writePages(key, pages) {
    let characters = 0;
    for (const page of pages) {
        characters += page.html.length + (page.footnotesHtml || '').length + page.sectionId.length;
        for (const id of page.anchorIds) characters += id.length;
        if (characters > maxLayoutCharacters) return;
    }
    const db = await database();
    if (!db) return;
    const transaction = db.transaction('layouts', 'readwrite');
    const store = transaction.objectStore('layouts');
    // Checkpoints can contain Vue proxies, which IndexedDB cannot clone.
    const snapshot = pages.map(({html, footnotesHtml = '', sectionId, anchorIds}) =>
        ({html, footnotesHtml, sectionId, anchorIds: Array.from(anchorIds)}));
    store.put({pages: snapshot, writtenAt: Date.now()}, key);
    const count = store.count();
    count.onsuccess = () => {
        let excess = count.result - maxLayouts;
        if (excess <= 0) return;
        const oldest = store.index('writtenAt').openKeyCursor();
        oldest.onsuccess = () => {
            const cursor = oldest.result;
            if (!cursor) return;
            store.delete(cursor.primaryKey);
            if (--excess > 0) cursor.continue();
        };
    };
    return new Promise(resolve => {
        transaction.oncomplete = transaction.onabort = () => resolve();
    });
}

export function savePages(key, pages) {
    if (key && pages.length) return withStorageTimeout(writePages(key, pages));
}
