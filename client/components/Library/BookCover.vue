<template>
    <span ref="element" class="book-cover" :style="{'--cover-color': color}">
        <img v-if="src && visible && !failed" :key="src" :src="src" :alt="`Обложка: ${book.title || 'Без названия'}`"
            loading="lazy" decoding="async" @error="failed = true" />
        <span v-else class="book-cover__placeholder" aria-hidden="true">
            <span>{{ letter }}</span><small>{{ (book.ext || 'КНИГА').toUpperCase() }}</small>
        </span>
    </span>
</template>

<script setup>
import {computed, ref, watch, onMounted, onBeforeUnmount} from 'vue';
import {useStore} from 'vuex';
import {coverUrl, bookUid} from './libraryModel';

const props = defineProps({book: {type: Object, required: true}});
const store = useStore();
const element = ref(null), visible = ref(false), failed = ref(false);
const src = computed(() => coverUrl(props.book, store.state.config.rootPathStatic));
const letter = computed(() => Array.from(props.book.title || 'К')[0].toUpperCase());
const color = computed(() => {
    const colors = ['#286b64', '#405d77', '#73594f', '#5e5578', '#556c47'];
    const seed = bookUid(props.book) || props.book.title || '';
    return colors[Array.from(seed).reduce((sum, c) => sum + c.codePointAt(0), 0) % colors.length];
});
let observer;
watch(src, () => {failed.value = false;});
onMounted(() => {
    if (!window.IntersectionObserver) {visible.value = true; return;}
    observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {visible.value = true; observer.disconnect();}
    }, {rootMargin: '160px'});
    observer.observe(element.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.book-cover {display: block; position: relative; aspect-ratio: 2 / 3; width: 100%; overflow: hidden; border-radius: 9px; background: var(--cover-color); box-shadow: 0 3px 9px #00000012;}
img {width: 100%; height: 100%; object-fit: cover; display: block;}
.book-cover__placeholder {display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; color: #e7f4ec; border-left: 5px solid #ffffff12;}
.book-cover__placeholder > span {font-size: clamp(28px, 3vw, 46px); font-weight: 450; margin: auto;}
small {font-size: 11px; letter-spacing: .08em; padding-bottom: 18%; opacity: .75;}
</style>
