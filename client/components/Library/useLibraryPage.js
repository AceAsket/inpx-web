import {inject, ref, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount} from 'vue';
import {libraryContextKey} from './libraryContext';

export function useLibraryPage(title, load) {
    const library = inject(libraryContextKey);
    const active = ref(false);
    const activate = () => {if (!active.value) {active.value = true; document.title = `${title} · INPX Web`; load(library);}};
    onMounted(activate); onActivated(activate);
    onDeactivated(() => {active.value = false;});
    onBeforeUnmount(() => {active.value = false;});
    watch(() => library.state.revision, () => {if (active.value) load(library);});
    return {library, active};
}
