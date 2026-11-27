<template>
    <span ref="element" class="book-cover" :style="{'--cover-color': color}">
        <img v-if="src && visible && !failed" :key="src" :src="src" :alt="`Обложка: ${book.title || 'Без названия'}`"
            loading="lazy" decoding="async" @load="loaded" @error="failed = true; emit('error')" />
        <span v-else class="book-cover__placeholder" aria-hidden="true">
            <span>{{ letter }}</span><small>{{ (book.ext || 'КНИГА').toUpperCase() }}</small>
        </span>
        <BookRatingBadge v-if="showRating && store.state.settings.showRates !== false" :book="book" />
    </span>
</template>

<script>
let sharedObserver = null;
const observedCallbacks = new WeakMap();

function getSharedObserver() {
    if (sharedObserver || typeof window === 'undefined' || !window.IntersectionObserver)
        return sharedObserver;
    sharedObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const callback = observedCallbacks.get(entry.target);
            sharedObserver.unobserve(entry.target);
            observedCallbacks.delete(entry.target);
            if (callback) callback();
        }
    }, {rootMargin: '160px'});
    return sharedObserver;
}
</script>

<script setup>
import {computed, ref, watch, onMounted, onBeforeUnmount} from 'vue';
import {useStore} from 'vuex';
import {coverUrl, bookUid} from './libraryModel';
import BookRatingBadge from './BookRatingBadge.vue';

const props = defineProps({book: {type: Object, required: true}, showRating:{type:Boolean,default:true}});
const emit = defineEmits(['load', 'error']);
const store = useStore();
const element = ref(null), visible = ref(false), failed = ref(false);
const src = computed(() => {
    const {rootPathStatic, dbConfig} = store.state.config;
    return coverUrl(props.book, rootPathStatic, dbConfig?.indexUpdate?.updatedAt || dbConfig?.inpxHash);
});
const letter = computed(() => Array.from(props.book.title || 'К')[0].toUpperCase());
const color = computed(() => {
    const colors = ['#286b64', '#405d77', '#73594f', '#5e5578', '#556c47'];
    const seed = bookUid(props.book) || props.book.title || '';
    return colors[Array.from(seed).reduce((sum, c) => sum + c.codePointAt(0), 0) % colors.length];
});
let retried = false;
function loaded() {
    retried = false;
    emit('load', src.value);
}
watch(src, () => {
    retried = false;
    failed.value = false;
});
watch(failed, (needsRetry, _, onCleanup) => {
    if (!needsRetry) return;
    function retry() {
        if (document.hidden || navigator.onLine === false) return;
        retried = true;
        failed.value = false;
    }
    // One retry for a brief failure. After that, wait for the reader to return or reconnect.
    const timer = retried ? undefined : setTimeout(retry, 1500);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    onCleanup(() => {
        clearTimeout(timer);
        window.removeEventListener('online', retry);
        document.removeEventListener('visibilitychange', retry);
    });
});
onMounted(() => {
    const obs = getSharedObserver();
    if (!obs || !element.value) {visible.value = true; return;}
    observedCallbacks.set(element.value, () => {visible.value = true;});
    obs.observe(element.value);
});
onBeforeUnmount(() => {
    if (sharedObserver && element.value) {
        sharedObserver.unobserve(element.value);
        observedCallbacks.delete(element.value);
    }
});
</script>

<style scoped>
.book-cover {display: block; position: relative; aspect-ratio: 2 / 3; width: 100%; overflow: hidden; border-radius: 9px; background: var(--cover-color); box-shadow: 0 3px 9px #00000012;}
img {width: 100%; height: 100%; object-fit: cover; display: block;}
.book-cover__placeholder {display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; color: #e7f4ec; border-left: 5px solid #ffffff12;}
.book-cover__placeholder > span {font-size: clamp(28px, 3vw, 46px); font-weight: 450; margin: auto;}
small {font-size: 11px; letter-spacing: .08em; padding-bottom: 18%; opacity: .75;}
</style>
