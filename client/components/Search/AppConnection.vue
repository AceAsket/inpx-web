<template>
    <span class="app-connection">
        <q-btn flat round dense class="app-connect-button" icon="la la-qrcode" aria-label="Подключить приложение" @click="open">
            <q-tooltip :delay="500">Подключить приложение INPX Reader</q-tooltip>
        </q-btn>
        <q-dialog v-model="visible" @hide="generation++">
            <q-card class="app-connect-card">
                <q-card-section class="row items-center no-wrap">
                    <q-icon name="la la-mobile-alt" size="26px" color="primary" class="q-mr-sm" />
                    <strong class="col">Подключить INPX Reader</strong>
                    <q-btn flat round dense icon="la la-times" aria-label="Закрыть подключение" @click="visible = false" />
                </q-card-section>
                <q-card-section class="app-connect-body">
                    <p>В приложении откройте подключение к серверу и нажмите «Сканировать QR».</p>
                    <div class="app-connect-code">
                        <img v-if="image" :src="image" width="240" height="240" alt="QR-код адреса сервера INPX" />
                        <q-spinner v-else-if="!error" size="36px" color="primary" aria-label="Подготовка QR-кода" />
                    </div>
                    <p v-if="error" role="alert" class="text-negative">{{ error }}</p>
                    <div class="app-connect-address">{{ address }}</div>
                    <p v-if="address.startsWith('http:')" class="app-connect-warning">HTTP: соединение не зашифровано. Подключайтесь в доверенной сети.</p>
                    <p class="app-connect-hint">Код заполнит адрес сервера. Затем войдите в свой профиль.</p>
                </q-card-section>
            </q-card>
        </q-dialog>
    </span>
</template>

<script>
const {serverUrl,qrPayload}=require('../../../shared/AppConnection');
export default {
    name:'AppConnection',
    props:{rootPath:{type:String,default:''}},
    data(){return {visible:false,image:'',error:'',address:'',generation:0};},
    methods:{async open(){
        this.visible=true;this.image='';this.error='';const generation=++this.generation;
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
.app-connect-button{width:34px;height:34px;color:#176c72;border:1px solid #176c7233;border-radius:10px;}
.app-connect-card{width:min(400px,94vw);border-radius:16px;}
.app-connect-body{text-align:center;padding-top:0;}
.app-connect-body p{line-height:1.5;}
.app-connect-code{min-height:240px;display:flex;align-items:center;justify-content:center;margin:12px auto;background:white;border-radius:12px;}
.app-connect-code img{max-width:100%;height:auto;display:block;}
.app-connect-address{overflow-wrap:anywhere;font-size:13px;padding:10px;border-radius:8px;background:#78909c14;user-select:all;}
.app-connect-hint{font-size:13px;opacity:.75;margin-top:12px;margin-bottom:0;}
.app-connect-warning{font-size:13px;color:#8a5700;background:#fff5dc;border-radius:8px;padding:10px;margin:12px 0 0;}
</style>
