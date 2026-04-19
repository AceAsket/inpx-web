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
        this.setAppTitle();
    }

    get config() {
        return this.$store.state.config;
    }

    get rootRoute() {
        return this.$root.getRootRoute();
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
    --app-bg: #f4f7fb;
    --app-surface: #ffffff;
    --app-surface-2: #fff7e8;
    --app-surface-3: #f7fafc;
    --app-text: #17202a;
    --app-muted: #64748b;
    --app-border: #d6e0ea;
    --app-link: #1f6fbf;
    --app-primary: #2477c7;
    --app-secondary: #8b5d13;
    --app-accent: #c98500;
    --app-danger: #cc3c3c;
    --app-shadow: 0 12px 34px rgba(23, 32, 42, 0.10);
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
    box-shadow: 0 0 0 3px rgba(36, 119, 199, 0.14);
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
    box-shadow: 0 0 0 1px rgba(31, 111, 191, 0.16);
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
    background: #fff4d6 !important;
    color: #614700 !important;
}

.bg-green-4 {
    background: #a26616 !important;
    color: #ffffff !important;
}

.text-green,
.text-green-10 {
    color: #8b5d13 !important;
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
    border-left: 2px solid rgba(36, 119, 199, 0.14);
    padding-left: 10px;
}

body.body--dark .book-row {
    border-left-color: rgba(255, 207, 122, 0.20);
}

.q-tooltip {
    border-radius: 8px;
}

body.body--dark {
    --q-primary: #7db7ff;
    --q-secondary: #d89b35;
    --q-accent: #ffcf7a;
    --app-bg: #14110f;
    --app-surface: #211d1a;
    --app-surface-2: #2a221b;
    --app-surface-3: #1b1816;
    --app-text: #f2ece4;
    --app-muted: #b8aa99;
    --app-border: #524437;
    --app-link: #9dccff;
    --app-primary: #7db7ff;
    --app-secondary: #d89b35;
    --app-accent: #ffcf7a;
    --app-danger: #ff8a8a;
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
    background: #7d4f16 !important;
    color: #fff3d7 !important;
}

body.body--dark .bg-primary {
    background: var(--app-primary) !important;
}

body.body--dark .bg-secondary {
    background: var(--app-secondary) !important;
    color: #211407 !important;
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
    color: #ffcf7a !important;
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
        linear-gradient(180deg, rgba(216, 155, 53, 0.13) 0%, rgba(125, 183, 255, 0.08) 100%),
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
    box-shadow: 0 0 0 1px rgba(255, 207, 122, 0.22);
}

body.body--dark .q-btn-toggle .q-btn {
    background: #241d17;
    color: var(--app-text);
}

body.body--dark .q-btn-toggle .q-btn.bg-primary {
    background: var(--app-primary) !important;
    color: #0e1824 !important;
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
    color: #8cc8ff;
}

body.body--dark .q-field__control,
body.body--dark .q-field__native,
body.body--dark .q-field__label {
    color: var(--app-text);
}

body.body--dark .q-field--outlined .q-field__control {
    background: #181411;
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

@font-face {
    font-family: 'Web Default';
    src: url('fonts/web-default.ttf') format('truetype');
}

@font-face {
    font-family: 'Verdana';
    font-weight: bold;
    src: url('fonts/web-default-bold.ttf') format('truetype');
}
</style>
