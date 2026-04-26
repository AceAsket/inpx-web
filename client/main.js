import { createApp } from 'vue';

import router from './router';
import store from './store';
import q from './quasar';

import App from './components/App.vue';

const app = createApp(App);

app.use(router);
app.use(store);
app.use(q.quasar, q.options);
q.init();

app.mount('#app');

async function clearBrowserAppCache() {
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.filter(key => key.startsWith('inpx-web-')).map(key => caches.delete(key)));
        }

        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(registration => registration.unregister()));
        }
    } catch (e) {
        //
    }
}

function appBasePath() {
    const base = document.querySelector('base');
    const basePath = base ? new URL(base.getAttribute('href') || '/', window.location.href).pathname : '/';
    return basePath.replace(/\/?$/, '/');
}

function consumeClearAppCacheFlag() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('clearAppCache'))
        return false;

    url.searchParams.delete('clearAppCache');
    clearBrowserAppCache().finally(() => {
        window.history.replaceState({}, '', url.toString());
        window.location.reload();
    });
    return true;
}

function startAppVersionMonitor() {
    const scopePath = appBasePath();
    const versionUrl = `${scopePath}version.txt`;
    const storageKey = `inpx-web-version:${scopePath}`;
    let reloading = false;

    async function checkVersion() {
        if (reloading)
            return;

        try {
            const response = await fetch(versionUrl, {cache: 'no-store'});
            if (!response.ok)
                return;

            const version = (await response.text()).trim();
            if (!version)
                return;

            const previous = localStorage.getItem(storageKey);
            if (!previous) {
                localStorage.setItem(storageKey, version);
                return;
            }

            if (previous !== version) {
                reloading = true;
                localStorage.setItem(storageKey, version);
                await clearBrowserAppCache();
                window.location.reload();
            }
        } catch (e) {
            //
        }
    }

    checkVersion();
    window.addEventListener('focus', checkVersion);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden)
            checkVersion();
    });
    window.setInterval(checkVersion, 60*1000);
}

if (!consumeClearAppCacheFlag())
    startAppVersionMonitor();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        const scopePath = appBasePath();
        navigator.serviceWorker.register(`${scopePath}sw.js`, {updateViaCache: 'none'})
            .then((registration) => registration.update())
            .catch(() => {});
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing)
            return;

        refreshing = true;
        window.location.reload();
    });
}
