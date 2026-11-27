const EPHEMERAL_SETTINGS = new Set(['accessToken', 'profileAccessToken']);

export function persistSettings(store, storage) {
    const key = 'vuex';
    function save() {
        const persisted = {};
        for (const [name, value] of Object.entries(store.state.settings)) {
            if (!EPHEMERAL_SETTINGS.has(name)) persisted[name] = value;
        }
        try {storage?.setItem(key, JSON.stringify({settings: persisted}));}
        catch { /* Settings still work for this session. */ }
    }

    try {
        storage ??= globalThis.localStorage;
        const previous = JSON.parse(storage?.getItem(key) || '{}');
        const saved = previous?.settings;
        let scrubbed = false;
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            // Browser storage is untrusted. Keep only non-secret settings the store knows.
            const settings = {...store.state.settings};
            for (const name of Object.keys(settings)) {
                if (EPHEMERAL_SETTINGS.has(name)) {
                    if (Object.hasOwn(saved, name)) scrubbed = true;
                    continue;
                }
                if (Object.hasOwn(saved, name)) settings[name] = saved[name];
            }
            store.replaceState({...store.state, settings});
        }
        if (scrubbed || Object.hasOwn(previous || {}, 'config')) save();
    } catch { /* Start with the defaults when storage is unavailable. */ }

    store.subscribe(mutation => {
        if (mutation.type === 'setSettings') save();
    });
}
