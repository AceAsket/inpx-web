export const readerProgressStorageKey = 'inpx.reader.progress.v1';

export function clearStoredReaderProgress(owner, bookUid = '', options = {}) {
    if (typeof localStorage === 'undefined')
        return;

    try {
        const raw = localStorage.getItem(readerProgressStorageKey);
        if (!raw)
            return;

        const parsed = JSON.parse(raw);
        const byUser = (parsed && parsed.byUser && typeof parsed.byUser === 'object') ? parsed.byUser : {};
        const globalProgress = (parsed && parsed.progress && typeof parsed.progress === 'object') ? parsed.progress : {};
        const userId = String(owner || '').trim();
        const clearAll = options && options.all === true;
        const normalizedBookUid = String(bookUid || '').trim();
        const knownBookUids = Array.isArray(options && options.bookUids)
            ? options.bookUids.map((uid) => String(uid || '').trim()).filter(Boolean)
            : [];

        if (clearAll) {
            if (!userId) Object.keys(globalProgress).forEach((uid) => delete globalProgress[uid]);
            if (userId)
                byUser[userId] = {};
            if (!userId) knownBookUids.forEach((uid) => delete globalProgress[uid]);
        } else if (normalizedBookUid) {
            if (!userId) delete globalProgress[normalizedBookUid];
            if (userId && byUser[userId] && typeof byUser[userId] === 'object')
                delete byUser[userId][normalizedBookUid];
        }

        localStorage.setItem(readerProgressStorageKey, JSON.stringify({
            progress: globalProgress,
            byUser,
        }));
    } catch (e) {
        // ignore storage failures
    }
}
