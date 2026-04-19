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
    background: #12171c;
    color: #e6edf3;
}

body.body--dark .root {
    background: #12171c;
    color: #e6edf3;
}

body.body--dark .bg-white,
body.body--dark .bg-cyan-2,
body.body--dark .bg-yellow-1 {
    background: #1d242b !important;
    color: #e6edf3 !important;
}

body.body--dark .bg-green-4 {
    background: #2f6b45 !important;
    color: #f2fff7 !important;
}

body.body--dark .text-black,
body.body--dark .text-grey-8,
body.body--dark .text-grey-6,
body.body--dark .text-grey-5 {
    color: #d8dee4 !important;
}

body.body--dark .clickable,
body.body--dark a {
    color: #7ab7ff;
}

body.body--dark .tool-panel {
    border-bottom-color: #3a4652;
}

body.body--dark .separator {
    border-bottom-color: #3a4652;
}

body.body--dark .odd-item {
    background-color: #1a2027 !important;
}

body.body--dark [style*="color: #555"],
body.body--dark [style*="color: blue"] {
    color: #9ecbff !important;
}

body.body--dark .q-field--outlined .q-field__control::before {
    border-color: #52616f;
}

body.body--dark .q-field--outlined .q-field__control:hover::before {
    border-color: #8aa4bd;
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
