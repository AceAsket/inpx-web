<template>
    <LibraryResultCard :book="book" :download-href="getDirectBookDownloadHref()" :selectable="selectable" :selected="selected"
        :show-rates="showRates" :show-info="showInfo" :date-label="showDates ? bookDate : ''" :genres="showGenres ? bookGenreItems : []"
        :feedback="showDiscoveryDismiss" :restore="showDiscoveryRestore" :reason="book.discoveryReason || ''" :compact="compactDiscovery"
        @action="emit($event)" @selection="emitSelection" @genre="emit('genreClick', $event)" @feedback="emit('discoveryFeedback', $event)" @restore="emit('discoveryRestore')">
        <pre v-if="showMetadata" class="book-metadata">{{ book }}</pre>
    </LibraryResultCard>
</template>

<script>
const bookFormats = require('../../../../shared/BookFormats');
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';
import LibraryResultCard from '../../Library/LibraryResultCard.vue';

import * as utils from '../../../share/utils';

const componentOptions = {
    components: {
        LibraryResultCard,
    },
    watch: {
        settings() {
            this.loadSettings();
        },
    }
};
class BookView {
    _options = componentOptions;
    _props = {
        book: Object,
        genreMap: Object,
        showMetadata: Boolean,
        showDiscoveryDismiss: { type: Boolean, default: false},
        showDiscoveryRestore: { type: Boolean, default: false},
        compactDiscovery: { type: Boolean, default: false},
        selectable: { type: Boolean, default: false},
        selected: { type: Boolean, default: false},
    };

    showRates = true;
    showInfo = true;
    showGenres = true;
    showDates = false;
    downloadAsZip = false;

    created() {
        this.loadSettings();
    }

    loadSettings() {
        const settings = this.settings;

        this.showRates = settings.showRates;
        this.showInfo = settings.showInfo;
        this.showGenres = settings.showGenres;
        this.showDates = settings.showDates;
        this.downloadAsZip = settings.downloadAsZip;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get config() {
        return this.$store.state.config;
    }

    get bookGenreItems() {
        let result = [];
        const genre = String(this.book.genre || '').split(',');

        for (const g of genre) {
            const name = this.genreMap.get(g);
            if (name)
                result.push({value: g, label: name});
        }

        return result.slice(0, 3);
    }

    get bookDate() {
        if (!this.book.date)
            return '';

        return utils.sqlDateFormat(this.book.date);
    }

    get preferredDownloadFormat() {
        return bookFormats.resolve(this.book.ext, this.config, bookFormats.profilePreference(this.config));
    }

    getBookUid(book = this.book) {
        return String(book._uid || book.bookUid || '').trim();
    }

    getDirectBookDownloadHref(format = '') {
        format = format ? bookFormats.resolve(this.book.ext, this.config, bookFormats.profilePreference(this.config), format) : this.preferredDownloadFormat;
        const bookUid = this.getBookUid();
        const root = String(this.config.rootPathStatic || '').replace(/\/$/, '');
        const params = new URLSearchParams();
        params.set('uid', bookUid);

        if (format)
            params.set('format', format);
        else if (this.downloadAsZip)
            params.set('zip', '1');

        return `${window.location.origin}${root}/book/by-uid?${params.toString()}`;
    }

    emit(action, format = '') {
        if (['download', 'copyLink', 'sendTelegram', 'sendEmail'].includes(action)) {
            const channel = action === 'sendTelegram' ? 'telegram' : action === 'sendEmail' ? 'email' : 'download';
            format = bookFormats.resolve(this.book.ext, this.config, bookFormats.profilePreference(this.config, channel), format);
        }
        this.$emit('bookEvent', {action, format, book: this.book});
    }

    emitSelection(selected) {
        this.$emit('bookEvent', {action: 'selectionChange', selected: !!selected, book: this.book});
    }
}

export default vueComponent(BookView);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.book-metadata {
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}
</style>
