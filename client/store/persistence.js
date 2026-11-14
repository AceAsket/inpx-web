export function persistSettings(store, storage) {
    const key = 'vuex';
    function save() {
        try {storage?.setItem(key, JSON.stringify({settings:store.state.settings}));}
        catch { /* Settings still work for this session. */ }
    }

    try {
        storage ??= globalThis.localStorage;
        const previous = JSON.parse(storage?.getItem(key) || '{}');
        const saved = previous?.settings;
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            // Browser storage is untrusted. Keep only settings the store knows.
            const settings = {...store.state.settings};
            for (const name of Object.keys(settings)) {
                if (Object.hasOwn(saved, name)) settings[name] = saved[name];
            }
            store.replaceState({...store.state, settings});
        }
        if (Object.hasOwn(previous || {}, 'config')) save();
    } catch { /* Start with the defaults when storage is unavailable. */ }

    store.subscribe(mutation => {
        if (mutation.type === 'setSettings') save();
    });
}
