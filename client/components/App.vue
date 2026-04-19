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
    font: normal 13px Web Default;
}

body.body--dark {
    --q-primary: #4f9fe8;
    --q-secondary: #2f7f87;
    --q-accent: #f0c768;
    background: #101418;
    color: #e9eef3;
}

body.body--dark .root {
    background: #101418;
    color: #e9eef3;
}

body.body--dark .bg-white,
body.body--dark .bg-yellow-1 {
    background: #1c242c !important;
    color: #e9eef3 !important;
}

body.body--dark .bg-cyan-2 {
    background: #182a32 !important;
    color: #e9eef3 !important;
}

body.body--dark .bg-green-4 {
    background: #2e7352 !important;
    color: #f2fff7 !important;
}

body.body--dark .bg-primary {
    background: #3d8fd8 !important;
}

body.body--dark .bg-secondary {
    background: #2f7f87 !important;
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
    color: #7ee2b8 !important;
}

body.body--dark .text-blue-10,
body.body--dark .text-primary {
    color: #8cc8ff !important;
}

body.body--dark .text-red,
body.body--dark .text-negative {
    color: #ff8a8a !important;
}

body.body--dark .text-warning {
    color: #f0c768 !important;
}

body.body--dark .clickable,
body.body--dark a {
    color: #8cc8ff;
}

body.body--dark .tool-panel {
    background: linear-gradient(180deg, #1b333b 0%, #17242c 100%) !important;
    border-bottom-color: #40606b;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

body.body--dark .separator {
    border-bottom-color: #40505e;
}

body.body--dark .odd-item {
    background-color: #182028 !important;
}

body.body--dark [style*="color: #555"],
body.body--dark [style*="color: blue"] {
    color: #9ecbff !important;
}

body.body--dark .button {
    border: 1px solid rgba(148, 163, 184, 0.22);
}

body.body--dark .button:hover {
    opacity: 1;
    filter: brightness(1.12);
}

body.body--dark .q-btn-toggle {
    box-shadow: 0 0 0 1px rgba(140, 200, 255, 0.22);
}

body.body--dark .q-btn-toggle .q-btn {
    background: #1d2933;
    color: #d7e4ef;
}

body.body--dark .q-btn-toggle .q-btn.bg-primary {
    background: #3d8fd8 !important;
    color: #ffffff !important;
}

body.body--dark .q-dialog__inner > div {
    background: #1c242c !important;
    color: #e9eef3 !important;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}

body.body--dark .q-menu {
    background: #1c242c;
    color: #e9eef3;
}

body.body--dark .q-item.q-router-link--active,
body.body--dark .q-item--active {
    color: #8cc8ff;
}

body.body--dark .q-field__control,
body.body--dark .q-field__native,
body.body--dark .q-field__label {
    color: #e9eef3;
}

body.body--dark .q-field--outlined .q-field__control::before {
    border-color: #526a7c;
}

body.body--dark .q-field--outlined .q-field__control:hover::before {
    border-color: #8cc8ff;
}

body.body--dark .q-field--focused .q-field__control::after {
    border-color: #8cc8ff;
}

body.body--dark pre {
    color: #d7e4ef;
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
