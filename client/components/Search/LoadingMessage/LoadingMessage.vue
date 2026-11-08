<template>
    <div v-if="message" class="loading-message" :style="{zIndex}" aria-busy="true">
        <LoadingState :label="message" class="loading-message__card" />
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';
import LoadingState from '../../share/LoadingState.vue';

const componentOptions = {
    components: {
        LoadingState,
    },
};
class LoadingMessage {
    _options = componentOptions;
    _props = {
        message: String,
        zIndex: {type: [String, Number], default: 100},
    };
}

export default vueComponent(LoadingMessage);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.loading-message {position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(8, 18, 22, .2);}
.loading-message__card {width: max-content; min-width: min(220px, 100%); max-width: min(420px, 100%); padding: 18px 22px; border-radius: 16px; box-shadow: 0 12px 32px #00000020;}
.loading-message__card :deep(.loading-state__heading) {gap: 12px; font-size: 15px;}
.loading-message__card :deep(.loading-state__heading > span) {overflow-wrap: anywhere;}
</style>
