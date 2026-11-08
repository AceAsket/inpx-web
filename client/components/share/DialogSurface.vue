<template>
    <section v-if="embedded" class="dialog-surface">
        <slot />
    </section>
    <Dialog v-else :model-value="modelValue" :variant="variant" @update:model-value="$emit('update:modelValue', $event)">
        <template #header>
            <slot name="header" />
        </template>
        <slot />
        <template v-if="$slots.footer" #footer>
            <slot name="footer" />
        </template>
    </Dialog>
</template>
<script setup>
import Dialog from './Dialog.vue';
defineProps({embedded: Boolean, modelValue: Boolean, variant: {type: String, default: ''}});
defineEmits(['update:modelValue']);
</script>
