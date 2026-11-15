const storageKey = 'inpx.readerSpeech.follow.v1';
let followSpeech = false;

function load() {
    try { followSpeech = localStorage.getItem(storageKey) === 'true'; }
    catch { /* Keep the in-memory preference when storage is unavailable. */ }
    return followSpeech;
}

function save(value) {
    followSpeech = value;
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* The current page can still use the in-memory preference. */ }
}

module.exports = {load, save};
