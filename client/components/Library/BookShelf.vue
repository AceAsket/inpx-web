<template>
    <section class="book-shelf" :aria-labelledby="headingId">
        <div class="book-shelf__heading">
            <h2 :id="headingId">{{ title }}</h2>
            <div class="book-shelf__actions">
                <slot name="action" />
                <button type="button" :aria-label="`Предыдущие книги: ${title}`" :disabled="!canBack" @click="scroll(-1)"><q-icon name="la la-angle-left" size="20px" /></button>
                <button type="button" :aria-label="`Следующие книги: ${title}`" :disabled="!canForward" @click="scroll(1)"><q-icon name="la la-angle-right" size="20px" /></button>
            </div>
        </div>
        <div ref="strip" class="book-shelf__strip" tabindex="0" :aria-label="title" @scroll.passive="measure" @keydown.left.prevent="scroll(-1)" @keydown.right.prevent="scroll(1)">
            <BookTile v-for="book in books" :key="bookUid(book) || book.discoveryUrl || book.title" :book="book" />
        </div>
    </section>
</template>

<script setup>
import {ref, onMounted, onBeforeUnmount, watch, nextTick} from 'vue';
import BookTile from './BookTile.vue';
import {bookUid} from './libraryModel';

const props = defineProps({title: {type: String, required: true}, books: {type: Array, required: true}, headingId: {type: String, required: true}});
const strip = ref(null), canBack = ref(false), canForward = ref(false);
let observer;
function measure() {
    const node = strip.value;
    if (!node) return;
    canBack.value = node.scrollLeft > 2;
    canForward.value = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
}
function scroll(direction) {
    strip.value?.scrollBy({left: direction * Math.max(150, strip.value.clientWidth * .8),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
}
watch(() => props.books, async() => {await nextTick(); measure();});
onMounted(() => {observer = new ResizeObserver(measure); observer.observe(strip.value); measure();});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.book-shelf {min-width: 0; margin: 34px 0 0;}
.book-shelf__heading {display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 17px;}
h2 {font-size: 19px; line-height: 1.4; letter-spacing: -.02em; font-weight: 550; margin: 0;}
.book-shelf__actions {display: flex; align-items: center; gap: 5px; flex-shrink: 0;}
button {background: transparent; color: var(--app-muted); border: 1px solid var(--app-border); width: 30px; height: 30px; border-radius: 50%; cursor: pointer;}
button:disabled {opacity: .3; cursor: default;}
button:focus-visible, .book-shelf__strip:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 3px;}
.book-shelf__strip {display: grid; grid-auto-columns: 130px; grid-auto-flow: column; gap: 24px; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: thin; scrollbar-color: var(--app-border) transparent; padding: 4px 4px 12px; margin: -4px; overscroll-behavior-x: contain;}
.book-shelf__strip > * {scroll-snap-align: start;}
@media (max-width: 599px) {.book-shelf__strip {grid-auto-columns: 112px; gap: 20px;} h2 {font-size: 18px;} .book-shelf__actions > button {display: none;}}
</style>
