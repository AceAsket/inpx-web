import {bookUid} from './libraryModel';

export async function deliverBook(api, book, channel, format) {
    const telegram = channel === 'telegram';
    if (telegram) await api.sendBookTelegram(bookUid(book), format);
    else await api.sendBookEmail(bookUid(book), format);
    const suffix = format && format !== 'raw' ? ` (${format.toUpperCase()})` : '';
    return `Книга отправлена ${telegram ? 'в Telegram' : 'на email'}${suffix}`;
}

export function openExternalReader(template, href) {
    const url = new URL(href);
    const target = template.includes('${DOWNLOAD_LINK}') ? template.replace('${DOWNLOAD_LINK}', href)
        : template.replace('${DOWNLOAD_URI}', url.pathname + url.search + url.hash);
    window.open(target, '_blank');
}
