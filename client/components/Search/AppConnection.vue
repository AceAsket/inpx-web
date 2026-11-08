<template>
    <span class="app-connection" :class="{'app-connection--sidebar': variant === 'sidebar'}">
        <span v-if="variant === 'sidebar'" class="app-connect-promo-wrap">
            <button type="button" class="app-connect-promo" aria-label="Скачать или подключить INPX Reader" @click="open('download')">
                <img :src="downloadImage" width="64" height="64" alt="QR-код скачивания INPX Reader для Android" loading="lazy" decoding="async" />
                <span class="app-connect-promo__copy"><strong>INPX Reader</strong><span>Android</span><small>Открыть <q-icon name="la la-angle-right" aria-hidden="true" /></small></span>
            </button>
            <button type="button" class="app-connect-promo-hide" aria-label="Скрыть QR-код приложения" title="Скрыть. Вернуть можно в настройках оформления." @click="$emit('hide-promo')"><q-icon name="la la-times" size="14px" aria-hidden="true" /></button>
        </span>
        <q-btn v-else flat :round="!buttonLabel" dense class="app-connect-button" :class="{'app-connect-button--text':buttonLabel}" icon="la la-qrcode" :label="buttonLabel || undefined" :aria-label="buttonLabel || 'Подключить приложение'" @click="open('connect')">
            <q-tooltip :delay="500">Скачать или подключить INPX Reader</q-tooltip>
        </q-btn>
        <q-dialog v-model="visible" @hide="generation++">
            <q-card class="app-connect-card">
                <q-card-section class="row items-center no-wrap">
                    <q-icon name="la la-mobile-alt" size="26px" color="primary" class="q-mr-sm" />
                    <strong class="col">INPX Reader</strong>
                    <q-btn flat round dense icon="la la-times" aria-label="Закрыть подключение" @click="visible = false" />
                </q-card-section>
                <q-card-section class="app-connect-body">
                    <div class="app-connect-choices" role="group" aria-label="Действие с приложением">
                        <q-btn no-caps :unelevated="mode === 'download'" :outline="mode !== 'download'" :color="mode === 'download' ? 'primary' : undefined" :aria-pressed="mode === 'download'" label="Скачать приложение" @click="selectMode('download')" />
                        <q-btn no-caps :unelevated="mode === 'connect'" :outline="mode !== 'connect'" :color="mode === 'connect' ? 'primary' : undefined" :aria-pressed="mode === 'connect'" label="Подключить к серверу" @click="selectMode('connect')" />
                    </div>
                    <p v-if="mode === 'download'">Отсканируйте код камерой телефона, чтобы открыть загрузку приложения для Android.</p>
                    <p v-else>В приложении откройте подключение к серверу и нажмите «Сканировать QR».</p>
                    <div class="app-connect-code">
                        <img v-if="mode === 'download'" :src="downloadImage" width="240" height="240" alt="QR-код скачивания INPX Reader для Android" />
                        <img v-else-if="image" :src="image" width="240" height="240" alt="QR-код адреса сервера INPX" />
                        <q-spinner v-else-if="!error" size="36px" color="primary" aria-label="Подготовка QR-кода" />
                    </div>
                    <p v-if="error" role="alert" class="text-negative">{{ error }}</p>
                    <template v-if="mode === 'download'">
                        <q-btn no-caps unelevated color="primary" :href="downloadUrl" target="_blank" rel="noopener noreferrer" label="Открыть загрузки Android" />
                        <p class="app-connect-hint">После установки выберите «Подключить к серверу».</p>
                    </template>
                    <template v-else>
                        <div class="app-connect-address">{{ address }}</div>
                        <p v-if="address.startsWith('http:')" class="app-connect-warning">HTTP: соединение не зашифровано. Подключайтесь в доверенной сети.</p>
                        <p class="app-connect-hint">Код заполнит адрес сервера. Затем войдите в свой профиль.</p>
                    </template>
                </q-card-section>
            </q-card>
        </q-dialog>
    </span>
</template>

<script>
const {serverUrl,qrPayload,downloadUrl}=require('../../../shared/AppConnection');
export default {
    name:'AppConnection',
    emits:['hide-promo'],
    props:{rootPath:{type:String,default:''},variant:{type:String,default:'button'},buttonLabel:{type:String,default:''}},
    data(){return {visible:false,mode:'connect',image:'',error:'',address:'',generation:0,downloadUrl};},
    computed:{downloadImage(){return String(this.rootPath || '').replace(/\/$/,'')+'/inpx-reader-download-qr.svg';}},
    beforeUnmount(){this.generation++;},
    methods:{
    open(mode='connect'){this.visible=true;this.selectMode(mode);},
    async selectMode(mode){
        this.mode=mode==='download'?'download':'connect';this.image='';this.error='';const generation=++this.generation;
        if(this.mode==='download')return;
        try {
            this.address=serverUrl(window.location.origin,this.rootPath);
            const payload=qrPayload(this.address),module=await import('qrcode');
            const image=await (module.default||module).toDataURL(payload,{width:288,margin:4,errorCorrectionLevel:'M'});
            if(generation===this.generation&&this.visible)this.image=image;
        } catch(error){if(generation===this.generation)this.error='Не удалось подготовить QR-код. Используйте адрес сервера ниже.';}
    }},
};
</script>

<style scoped>
.app-connection{display:inline-flex;align-items:center;flex-shrink:0;}
.app-connect-button{width:34px;height:34px;color:var(--app-primary,#176c72);border:1px solid var(--app-border,#176c7233);border-radius:10px;}
.app-connect-button--text{width:auto;height:auto;min-height:34px;padding:5px 9px;font-size:12px;}
:global(.body--dark) .app-connect-button{color:var(--app-primary,#6bdac9);border-color:var(--app-border,#334a53);}
.app-connect-card{width:min(400px,94vw);border-radius:16px;}
.app-connect-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px;}
.app-connect-choices .q-btn{border-radius:10px;font-size:12px;line-height:1.4;min-height:46px;}
.app-connect-body{text-align:center;padding-top:0;}
.app-connect-body p{line-height:1.5;}
.app-connect-code{min-height:240px;display:flex;align-items:center;justify-content:center;margin:12px auto;background:white;border-radius:12px;}
.app-connect-code img{max-width:100%;height:auto;display:block;}
.app-connect-address{overflow-wrap:anywhere;font-size:13px;padding:10px;border-radius:8px;background:#78909c14;user-select:all;}
.app-connect-hint{font-size:13px;opacity:.75;margin-top:12px;margin-bottom:0;}
.app-connect-warning{font-size:13px;color:#8a5700;background:#fff5dc;border-radius:8px;padding:10px;margin:12px 0 0;}
.app-connection--sidebar{display:block;width:100%;}
.app-connect-promo-wrap{position:relative;display:block;width:100%;}
.app-connect-promo{display:flex;align-items:center;gap:10px;width:100%;border:1px solid var(--app-border);border-radius:12px;padding:8px;background:var(--app-surface);color:var(--app-text);font:inherit;cursor:pointer;text-align:left;}
.app-connect-promo > img{display:block;width:64px;height:64px;flex-shrink:0;background:#fff;border-radius:6px;}
.app-connect-promo__copy{display:block;min-width:0;flex:1;}
.app-connect-promo strong{display:block;padding-right:13px;font-size:12px;font-weight:600;line-height:1.35;}
.app-connect-promo__copy > span{display:block;font-size:10px;color:var(--app-muted);margin-top:3px;line-height:1.4;}
.app-connect-promo small{display:flex;align-items:center;gap:2px;font-size:10px;color:var(--app-primary);margin-top:6px;line-height:1.4;}
.app-connect-promo:hover{border-color:var(--app-primary);}
.app-connect-promo-hide{position:absolute;top:-5px;right:-5px;display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--app-border);border-radius:8px;background:var(--app-surface);color:var(--app-muted);cursor:pointer;}
.app-connect-promo-hide:hover{color:var(--app-text);border-color:var(--app-primary);}
.app-connect-promo:focus-visible,.app-connect-promo-hide:focus-visible{outline:3px solid var(--app-primary);outline-offset:3px;}
</style>
