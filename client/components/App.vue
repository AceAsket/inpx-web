<template>
    <div class="fit row">
        <Api ref="api" v-model="accessGranted" />
        <Notify ref="notify" />
        <StdDialog ref="stdDialog" />

        <router-view v-if="accessGranted" v-slot="{ Component }">
            <keep-alive>
                <component :is="Component" class="col" />
            </keep-alive>
        </router-view>        
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from './vueComponent.js';

//import * as utils from '../share/utils';
import Notify from './share/Notify.vue';
import StdDialog from './share/StdDialog.vue';

import Api from './Api/Api.vue';
import Search from './Search/Search.vue';

const componentOptions = {
    components: {
        Api,
        Notify,
        StdDialog,

        Search,
    },
    watch: {
        darkTheme(newValue) {
            this.applyTheme(newValue);
        },
        '$route.path'() {
            this.applyPwaManifest();
        },
    },

};
class App {
    _options = componentOptions;
    accessGranted = false;

    created() {
        this.commit = this.$store.commit;

        //root route
        let cachedRoute = '';
        let cachedPath = '';
        this.$root.getRootRoute = () => {
            if (this.$route.path != cachedPath) {
                cachedPath = this.$route.path;
                const m = cachedPath.match(/^(\/[^/]*).*$/i);
                cachedRoute = (m ? m[1] : this.$route.path);
            }
            return cachedRoute;
        }

        this.$root.isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent);
        this.$root.setAppTitle = this.setAppTitle;

        //global keyHooks
        this.keyHooks = [];
        this.keyHook = (event) => {
            for (const hook of this.keyHooks)
                hook(event);
        }

        this.$root.addKeyHook = (hook) => {
            if (this.keyHooks.indexOf(hook) < 0)
                this.keyHooks.push(hook);
        }

        this.$root.removeKeyHook = (hook) => {
            const i = this.keyHooks.indexOf(hook);
            if (i >= 0)
                this.keyHooks.splice(i, 1);
        }

        document.addEventListener('keyup', (event) => {
            this.keyHook(event);
        });
        document.addEventListener('keypress', (event) => {
            this.keyHook(event);
        });
        document.addEventListener('keydown', (event) => {
            this.keyHook(event);
        });        
    }

    mounted() {
        this.$root.api = this.$refs.api;
        this.$root.notify = this.$refs.notify;
        this.$root.stdDialog = this.$refs.stdDialog;

        this.applyTheme(this.darkTheme);
        this.applyPwaManifest();
        this.setAppTitle();
    }

    get config() {
        return this.$store.state.config;
    }

    get rootRoute() {
        return this.$root.getRootRoute();
    }

    get isReaderRoute() {
        return this.$route.path === '/reader';
    }

    get settings() {
        return this.$store.state.settings;
    }

    get darkTheme() {
        return !!this.settings.darkTheme;
    }

    applyTheme(value) {
        this.$q.dark.set(!!value);
    }

    applyPwaManifest() {
        const manifest = document.querySelector('link[rel="manifest"]');
        if (!manifest)
            return;

        manifest.setAttribute('href', this.isReaderRoute ? 'reader.webmanifest?v=reader-icon-2' : 'manifest.webmanifest?v=catalog-icon-2');
        const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        if (appleTitle)
            appleTitle.setAttribute('content', this.isReaderRoute ? 'INPX Reader' : 'INPX Web');

        const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
        if (appleIcon)
            appleIcon.setAttribute('href', this.isReaderRoute ? 'reader-icon-192.png?v=reader-icon-2' : 'pwa-icon-192.png?v=catalog-icon-2');

        let favicon = document.querySelector('link[rel="icon"]');
        if (!favicon) {
            favicon = document.createElement('link');
            favicon.setAttribute('rel', 'icon');
            document.head.appendChild(favicon);
        }
        favicon.setAttribute('type', 'image/x-icon');
        favicon.setAttribute('href', this.isReaderRoute ? 'reader-favicon.ico?v=reader-icon-2' : 'favicon.ico?v=catalog-icon-2');
    }

    setAppTitle(title) {
        if (title) {
            document.title = title;
        }
    }
}

export default vueComponent(App);
//-----------------------------------------------------------------------------
</script>

<style scoped>
</style>

<style>
body, html, #app {    
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font: normal 14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    letter-spacing: 0;
}

body {
    --app-bg: #f5f8fb;
    --app-surface: #ffffff;
    --app-surface-2: #eef9f6;
    --app-surface-3: #edf2f7;
    --app-text: #172026;
    --app-muted: #60707d;
    --app-border: #d6e2ea;
    --app-link: #087f8c;
    --app-primary: #0f9f8f;
    --app-secondary: #e85d75;
    --app-accent: #e85d75;
    --app-danger: #d64550;
    --app-shadow: 0 16px 42px rgba(23, 32, 38, 0.12);
    background: var(--app-bg);
    color: var(--app-text);
}

.root {
    background: var(--app-bg);
    color: var(--app-text);
}

.q-field--outlined .q-field__control {
    border-radius: 8px;
    background: var(--app-surface);
    min-height: 42px;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
}

.q-field--outlined .q-field__control::before {
    border-color: var(--app-border);
}

.q-field--outlined .q-field__control:hover::before {
    border-color: #9ab0c4;
}

.q-field--focused .q-field__control {
    box-shadow: 0 0 0 3px rgba(15, 159, 143, 0.16);
}

.q-field--focused .q-field__control::after {
    border-color: var(--app-primary);
}

.q-field__label,
.q-field__native {
    color: var(--app-text);
}

.q-btn {
    border-radius: 8px;
    font-weight: 650;
    letter-spacing: 0;
}

.q-btn.bg-primary {
    background: var(--app-primary) !important;
}

.q-btn.bg-secondary {
    background: var(--app-secondary) !important;
}

.q-btn-toggle {
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(15, 159, 143, 0.18);
}

.q-btn-toggle .q-btn {
    min-height: 34px;
}

.q-menu,
.q-dialog__inner > div {
    border-radius: 8px;
    box-shadow: var(--app-shadow);
}

.bg-white {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
}

.bg-cyan-2 {
    background: var(--app-surface-2) !important;
    color: var(--app-text) !important;
}

.bg-yellow-1 {
    background: #e9f8f4 !important;
    color: #0b6159 !important;
}

.bg-green-4 {
    background: #087f8c !important;
    color: #ffffff !important;
}

.text-green,
.text-green-10 {
    color: #087f8c !important;
}

.text-blue-10,
.text-primary {
    color: var(--app-link) !important;
}

.clickable,
a {
    color: var(--app-link);
}

.clickable,
.clickable2,
.button,
.q-btn {
    transition: background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease, filter 0.18s ease;
}

.odd-item {
    background-color: var(--app-surface-3) !important;
}

.odd-item,
.book-view {
    border-radius: 8px;
}

.separator {
    border-bottom-color: var(--app-border) !important;
}

.book-row {
    border-left: 2px solid rgba(15, 159, 143, 0.16);
    padding-left: 10px;
}

body.body--dark .book-row {
    border-left-color: rgba(20, 184, 166, 0.24);
}

.q-tooltip {
    border-radius: 8px;
}

body.body--dark {
    --q-primary: #14b8a6;
    --q-secondary: #f4728b;
    --q-accent: #f4728b;
    --app-bg: #151719;
    --app-surface: #202326;
    --app-surface-2: #182725;
    --app-surface-3: #1b1e21;
    --app-text: #eef3f4;
    --app-muted: #a8b3b8;
    --app-border: #354248;
    --app-link: #5eead4;
    --app-primary: #14b8a6;
    --app-secondary: #f4728b;
    --app-accent: #f4728b;
    --app-danger: #fb7185;
    --app-shadow: 0 14px 42px rgba(0, 0, 0, 0.55);
    background: var(--app-bg);
    color: var(--app-text);
}

body.body--dark .root {
    background: var(--app-bg);
    color: var(--app-text);
}

body.body--dark .bg-white,
body.body--dark .bg-yellow-1 {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
}

body.body--dark .bg-cyan-2 {
    background: var(--app-surface-2) !important;
    color: var(--app-text) !important;
}

body.body--dark .bg-green-4 {
    background: #0f766e !important;
    color: #ecfeff !important;
}

body.body--dark .bg-primary {
    background: var(--app-primary) !important;
}

body.body--dark .bg-secondary {
    background: var(--app-secondary) !important;
    color: #1f1116 !important;
}

body.body--dark .text-black,
body.body--dark .text-grey-8,
body.body--dark .text-grey-6,
body.body--dark .text-grey-5 {
    color: #d8e1ea !important;
}

body.body--dark .text-green,
body.body--dark .text-green-10,
body.body--dark .text-positive {
    color: #5eead4 !important;
}

body.body--dark .text-blue-10,
body.body--dark .text-primary {
    color: var(--app-link) !important;
}

body.body--dark .text-red,
body.body--dark .text-negative {
    color: #ff8a8a !important;
}

body.body--dark .text-warning {
    color: var(--app-accent) !important;
}

body.body--dark .clickable,
body.body--dark a {
    color: var(--app-link);
}

body.body--dark .tool-panel {
    background:
        linear-gradient(180deg, rgba(20, 184, 166, 0.14) 0%, rgba(244, 114, 139, 0.08) 100%),
        var(--app-surface) !important;
    border-bottom-color: var(--app-border);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
}

body.body--dark .separator {
    border-bottom-color: var(--app-border);
}

body.body--dark .odd-item {
    background-color: var(--app-surface-3) !important;
}

body.body--dark [style*="color: #555"],
body.body--dark [style*="color: blue"] {
    color: var(--app-link) !important;
}

body.body--dark .button {
    border: 1px solid rgba(148, 163, 184, 0.22);
}

body.body--dark .button:hover {
    opacity: 1;
    filter: brightness(1.12);
}

body.body--dark .q-btn-toggle {
    box-shadow: 0 0 0 1px rgba(20, 184, 166, 0.24);
}

body.body--dark .q-btn-toggle .q-btn {
    background: #1c2224;
    color: var(--app-text);
}

body.body--dark .q-btn-toggle .q-btn.bg-primary {
    background: var(--app-primary) !important;
    color: #071b1a !important;
}

body.body--dark .q-dialog__inner > div {
    background: var(--app-surface) !important;
    color: var(--app-text) !important;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}

body.body--dark .q-menu {
    background: var(--app-surface);
    color: var(--app-text);
}

body.body--dark .q-item.q-router-link--active,
body.body--dark .q-item--active {
    color: var(--app-link);
}

body.body--dark .q-field__control,
body.body--dark .q-field__native,
body.body--dark .q-field__label {
    color: var(--app-text);
}

body.body--dark .q-field--outlined .q-field__control {
    background: #171a1c;
}

body.body--dark .q-field--outlined .q-field__control::before {
    border-color: var(--app-border);
}

body.body--dark .q-field--outlined .q-field__control:hover::before {
    border-color: var(--app-accent);
}

body.body--dark .q-field--focused .q-field__control::after {
    border-color: var(--app-primary);
}

body.body--dark pre {
    color: var(--app-text);
}

.dborder {
    border: 2px solid yellow;
}

.icon-rotate {
    vertical-align: middle;
    animation: rotating 2s linear infinite;
}

.q-dialog__inner--minimized {
    padding: 10px !important;
}

.q-dialog__inner--minimized > div {
    max-height: 100% !important;
    max-width: 800px !important;
}

@keyframes rotating { 
    from { 
        transform: rotate(0deg); 
    } to { 
        transform: rotate(360deg); 
    }
}

</style>
