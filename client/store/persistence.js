// Server config includes private profile data and potentially large reader
// backgrounds. Restore and persist only browser settings, including old stores.
export const persistenceOptions = {
    reducer: state => ({settings: state.settings}),
    filter: mutation => mutation.type === 'setSettings',
    restoreState(key, storage) {
        try {
            const previous = JSON.parse(storage.getItem(key) || '{}');
            const restored = {settings: previous.settings || {}};
            if (previous.config) {
                try {storage.setItem(key, JSON.stringify(restored));} catch { /* Restore usable settings anyway. */ }
            }
            return restored;
        }
        catch {return {};}
    },
    saveState(key, state, storage) {
        try {storage.setItem(key, JSON.stringify(state));} catch { /* Settings still work for this session. */ }
    },
};
