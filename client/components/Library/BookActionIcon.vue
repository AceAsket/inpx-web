<template>
    <!-- The same 24 × 24 paths as Android ic_send, ic_shelf and ic_share. -->
    <svg class="book-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" :data-book-action-icon="name">
        <path v-if="name === 'send'" fill="currentColor" d="M3,4L21,12L3,20L3,14L14,12L3,10Z" />
        <path v-else-if="name === 'shelf'" fill="currentColor" d="M3,4h3v14H3zM8,3h3v15H8zM13,5l3,-1l5,13l-3,1zM2,20h20v2H2z" />
        <template v-else-if="name === 'share'">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6,12L18,5M6,12L18,19" />
            <path fill="currentColor" d="M6,9a3,3 0,1 0,0,6a3,3 0,1 0,0,-6M18,2a3,3 0,1 0,0,6a3,3 0,1 0,0,-6M18,16a3,3 0,1 0,0,6a3,3 0,1 0,0,-6" />
        </template>
    </svg>
</template>

<script setup>
defineProps({name: {type: String, required: true}});
</script>

<style scoped>
.book-action-icon {display: block; width: 24px; height: 24px; flex-shrink: 0;}
</style>
