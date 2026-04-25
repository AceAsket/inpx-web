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

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        const base = document.querySelector('base');
        const basePath = base ? new URL(base.getAttribute('href') || '/', window.location.href).pathname : '/';
        const scopePath = basePath.replace(/\/?$/, '/');
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
