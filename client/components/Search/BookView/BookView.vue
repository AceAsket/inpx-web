<template>
    <div class="book-view q-my-sm">
        <div
            class="book-card"
            :class="{'is-poster-mode': isPosterMode, 'is-compact-discovery': compactDiscovery, 'has-inline-actions': hasInlineActionsLayout}"
            role="button"
            tabindex="0"
            @click="handleCardActivate"
            @keydown.enter.prevent="handleCardActivate"
            @keydown.space.prevent="handleCardActivate"
        >
            <div class="cover-box">
                <q-checkbox
                    v-if="selectable && !isExternalOnlyDiscoveryBook"
                    :model-value="selected"
                    class="book-select-checkbox"
                    dense
                    color="primary"
                    @click.stop
                    @update:model-value="emitSelection"
                />
                <img
                    v-if="coverSrc"
                    :src="coverSrc"
                    :alt="posterTitle"
                    class="cover-image"
                    loading="lazy"
                    @error="coverError = true"
                />
                <div v-else class="cover-placeholder" :style="placeholderStyle">
                    <div class="cover-letter">
                        {{ posterLetter }}
                    </div>
                    <div class="cover-placeholder-title">
                        {{ posterTitle }}
                    </div>
                    <div class="cover-placeholder-ext">
                        {{ posterExt }}
                    </div>
                </div>

                <div v-if="book.del && showDeleted" class="cover-badge deleted-badge">
                    {{ deletedLabel }}
                </div>
            </div>

            <div class="book-content">
                <div
                    v-if="(mode == 'series' || mode == 'title' || mode == 'extended') && bookAuthor"
                    class="book-author clickable2"
                    @click.stop.prevent="handleAuthorActivate"
                >
                    {{ bookAuthor }}
                </div>

                <div class="book-meta-pills">
                    <div class="meta-pill">
                        {{ posterExt }}
                    </div>
                    <div v-if="showRates && !book.del && book.librate" class="meta-pill rating-pill" :class="rateBadgeColor">
                        {{ book.librate }}/5
                    </div>
                    <div v-else-if="showRates && !book.del && !isExternalOnlyDiscoveryBook" class="meta-pill rating-pill rating-pill-placeholder" aria-hidden="true">
                        0/5
                    </div>
                    <div v-if="bookSize" class="meta-pill">
                        {{ bookSize }}
                    </div>
                    <div v-if="showDates && book.date" class="meta-pill">
                        {{ bookDate }}
                    </div>
                </div>

                <div class="book-title-row">
                    <div class="serno-slot">
                        <div v-if="book.serno" class="serno-pill">
                            {{ book.serno }}
                        </div>
                        <div v-else class="serno-pill serno-pill-placeholder" aria-hidden="true">
                            00
                        </div>
                    </div>
                    <div class="book-title clickable2" :class="titleColor" @click.stop.prevent="handleCardActivate">
                        {{ posterTitle }}
                    </div>
                </div>

                <div v-if="(mode == 'title' || mode == 'extended') && bookSeries" class="book-series clickable2" @click.stop.prevent="emit('seriesClick')">
                    {{ bookSeries }}
                </div>

                <div v-if="book.discoveryReason" class="book-discovery-note">
                    {{ book.discoveryReason }}
                </div>

                <div v-if="showGenres && bookGenreItems.length" class="book-genres">
                    <span
                        v-for="genre in displayGenreItems"
                        :key="genre.value"
                        class="genre-chip clickable2"
                        @click.stop.prevent="emit('genreClick', genre.value)"
                    >
                        {{ genre.label }}
                    </span>
                    <span v-if="displayGenreOverflowCount" class="genre-chip genre-chip-muted">
                        +{{ displayGenreOverflowCount }}
                    </span>
                </div>

                <div class="book-actions" :class="{'book-actions--external-only': isExternalOnlyDiscoveryBook && !isCompactDiscoveryMode}">
                    <q-btn
                        class="primary-action"
                        :class="{'primary-action--external-only': isExternalOnlyDiscoveryBook && !isCompactDiscoveryMode}"
                        color="primary"
                        unelevated
                        no-caps
                        :icon="primaryActionIcon"
                        @click.stop.prevent="handlePrimaryAction"
                    >
                        {{ primaryActionLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showReadLink && !isExternalOnlyDiscoveryBook"
                        color="secondary"
                        flat
                        no-caps
                        icon="la la-book-open"
                        @click.stop.prevent="emit('readBook')"
                    >
                        {{ effectiveReadLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showInfo && !isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook"
                        flat
                        no-caps
                        icon="la la-info-circle"
                        @click.stop.prevent="emit('bookInfo')"
                    >
                        {{ infoLabel }}
                    </q-btn>

                    <q-btn
                        v-if="bookAuthor && !isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook"
                        flat
                        no-caps
                        icon="la la-user-circle"
                        @click.stop.prevent="emit('authorInfo')"
                    >
                        {{ authorInfoLabel }}
                    </q-btn>

                    <q-btn
                        v-if="!isExternalOnlyDiscoveryBook"
                        flat
                        no-caps
                        icon="la la-bookmark"
                        @click.stop.prevent="emit('readingList')"
                    >
                        {{ effectiveReadingListLabel }}
                    </q-btn>

                    <q-btn
                        v-if="!isExternalOnlyDiscoveryBook"
                        flat
                        no-caps
                        icon="la la-check-circle"
                        @click.stop.prevent="emit('markRead')"
                    >
                        {{ markReadLabel }}
                    </q-btn>

                    <q-btn
                        v-if="!isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook"
                        flat
                        no-caps
                        icon="la la-undo"
                        @click.stop.prevent="emit('markUnread')"
                    >
                        {{ markUnreadLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showDiscoveryDismiss"
                        flat
                        no-caps
                        icon="la la-eye-slash"
                        @click.stop.prevent="emit('discoveryDismiss')"
                    >
                        {{ effectiveDiscoveryDismissLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showDiscoveryRestore"
                        flat
                        no-caps
                        icon="la la-undo"
                        @click.stop.prevent="emit('discoveryRestore')"
                    >
                        {{ effectiveDiscoveryRestoreLabel }}
                    </q-btn>

                    <div v-if="telegramShareEnabled && !isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook" class="action-split" @click.stop>
                        <q-btn
                            flat
                            no-caps
                            icon="lab la-telegram-plane"
                            @click.stop.prevent="emit('sendTelegram')"
                        >
                            Telegram
                        </q-btn>

                        <button
                            type="button"
                            class="action-split-toggle"
                            :aria-expanded="telegramMenuOpen ? 'true' : 'false'"
                            aria-label="Выбрать формат для Telegram"
                            @click.stop.prevent="toggleShareMenu('telegram')"
                        >
                            <i :class="telegramMenuOpen ? 'la la-angle-up' : 'la la-angle-up'"></i>
                        </button>

                        <div v-if="telegramMenuOpen" class="action-split-menu">
                            <button
                                v-for="format in telegramFormats"
                                :key="format"
                                type="button"
                                class="action-split-item"
                                @click.stop.prevent="selectShareFormat('telegram', format)"
                            >
                                {{ format.toUpperCase() }}
                            </button>
                        </div>
                    </div>

                    <div v-if="emailShareEnabled && !isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook" class="action-split" @click.stop>
                        <q-btn
                            flat
                            no-caps
                            icon="la la-envelope"
                            @click.stop.prevent="emit('sendEmail')"
                        >
                            Email
                        </q-btn>

                        <button
                            type="button"
                            class="action-split-toggle"
                            :aria-expanded="emailMenuOpen ? 'true' : 'false'"
                            aria-label="Выбрать формат для email"
                            @click.stop.prevent="toggleShareMenu('email')"
                        >
                            <i :class="emailMenuOpen ? 'la la-angle-up' : 'la la-angle-up'"></i>
                        </button>

                        <div v-if="emailMenuOpen" class="action-split-menu">
                            <button
                                v-for="format in emailFormats"
                                :key="format"
                                type="button"
                                class="action-split-item"
                                @click.stop.prevent="selectShareFormat('email', format)"
                            >
                                {{ format.toUpperCase() }}
                            </button>
                        </div>
                    </div>

                    <q-btn
                        v-if="!isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook"
                        class="copy-action"
                        flat
                        icon="la la-copy"
                        @click.stop.prevent="emit('copyLink')"
                    >
                        URL
                    </q-btn>
                </div>

                <div v-if="!isCompactDiscoveryMode && !isExternalOnlyDiscoveryBook && extraFormats.length" class="format-actions">
                    <div class="action-split format-split" @click.stop>
                        <q-btn
                            flat
                            no-caps
                            icon="la la-file-export"
                            @click.stop.prevent="toggleShareMenu('format')"
                        >
                            {{ formatDropdownLabel }}
                        </q-btn>

                        <button
                            type="button"
                            class="action-split-toggle"
                            :aria-expanded="formatMenuOpen ? 'true' : 'false'"
                            aria-label="Выбрать формат"
                            @click.stop.prevent="toggleShareMenu('format')"
                        >
                            <i :class="formatMenuOpen ? 'la la-angle-up' : 'la la-angle-up'"></i>
                        </button>

                        <div v-if="formatMenuOpen" class="action-split-menu">
                            <button
                                v-for="format in extraFormats"
                                :key="format"
                                type="button"
                                class="action-split-item"
                                @click.stop.prevent="selectDownloadFormat(format)"
                            >
                                {{ format.toUpperCase() }}
                            </button>
                        </div>
                    </div>
                </div>

                <div v-show="showJson && mode == 'extended'" class="book-json">
                    <pre>{{ book }}</pre>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import * as utils from '../../../share/utils';

const componentOptions = {
    components: {
    },
    watch: {
        settings() {
            this.loadSettings();
        },
        book() {
            this.coverError = false;
        },
    }
};
class BookView {
    _options = componentOptions;
    _props = {
        book: Object,
        mode: String,
        genreMap: Object,
        showReadLink: Boolean,
        showDiscoveryDismiss: { type: Boolean, default: false},
        discoveryDismissLabel: { type: String, default: 'Неинтересно'},
        showDiscoveryRestore: { type: Boolean, default: false},
        discoveryRestoreLabel: { type: String, default: 'Вернуть'},
        compactDiscovery: { type: Boolean, default: false},
        titleColor: { type: String, default: 'text-blue-10'},
        selectable: { type: Boolean, default: false},
        selected: { type: Boolean, default: false},
    };

    showRates = true;
    showInfo = true;
    showGenres = true;
    showDeleted = false;
    showDates = false;
    showJson = false;
    coverError = false;
    telegramMenuOpen = false;
    emailMenuOpen = false;
    formatMenuOpen = false;

    created() {
        this.loadSettings();
    }

    mounted() {
        document.addEventListener('click', this.handleOutsideClick);
    }

    beforeUnmount() {
        document.removeEventListener('click', this.handleOutsideClick);
    }

    loadSettings() {
        const settings = this.settings;

        this.showRates = settings.showRates;
        this.showInfo = settings.showInfo;
        this.showGenres = settings.showGenres;
        this.showDates = settings.showDates;
        this.showDeleted = settings.showDeleted;
        this.showJson = settings.showJson;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get config() {
        return this.$store.state.config;
    }

    get conversionEnabled() {
        return this.config.conversionEnabled !== false;
    }

    get conversionFormats() {
        const formats = Array.isArray(this.config.conversionFormats) ? this.config.conversionFormats : ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf'];
        return formats.map(format => String(format || '').toLowerCase()).filter(Boolean);
    }

    get availableConversionFormats() {
        const currentExt = (this.book.ext || '').toLowerCase();
        const formats = this.conversionFormats;

        if (currentExt === 'fb2')
            return formats;
        if (currentExt === 'epub')
            return formats.filter(format => format === 'pdf');

        return [];
    }

    get telegramShareEnabled() {
        return this.config.telegramShareEnabled === true;
    }

    get emailShareEnabled() {
        return this.config.emailShareEnabled === true;
    }

    get bookAuthor() {
        if (this.book.author) {
            let a = this.book.author.split(',');
            return a.slice(0, 3).join(', ') + (a.length > 3 ? '\u0020\u0438\u0020\u0434\u0440\u002e' : '');
        }

        return '';
    }

    get bookSeries() {
        if (this.book.series) {
            return `${this.seriesLabel}: ${this.book.series}`;
        }

        return '';
    }

    get posterTitle() {
        return this.book.title || this.bookAuthor || this.noTitleLabel;
    }

    get posterLetter() {
        return this.posterTitle.substring(0, 1).toUpperCase();
    }

    get posterExt() {
        if (this.isExternalOnlyDiscoveryBook)
            return 'WEB';
        return (this.book.ext || 'book').toUpperCase();
    }

    get bookSize() {
        let size = Number(this.book.size || 0) / 1024;
        if (!(size > 0))
            return '';
        let unit = 'KB';
        if (size > 1024) {
            size = size/1024;
            unit = 'MB';
        }
        return `${size.toFixed(0)}${unit}`;
    }

    get coverSrc() {
        if (this.coverError)
            return '';

        if (this.book.discoveryCoverUrl)
            return this.book.discoveryCoverUrl;

        if (!this.book.libid)
            return '';

        const root = this.config.rootPathStatic || '';
        const sourceId = String(this.book.sourceId || '').trim();
        return sourceId
            ? `${root}/cover/${encodeURIComponent(sourceId)}/${this.book.libid}`
            : `${root}/cover/${this.book.libid}`;
    }

    get rateBadgeColor() {
        const rate = (this.book.librate > 5 ? 5 : this.book.librate);
        if (rate >= 4)
            return 'badge-good';
        if (rate >= 2)
            return 'badge-mid';
        return 'badge-bad';
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

    get genreOverflowCount() {
        const genre = String(this.book.genre || '').split(',');
        let count = 0;

        for (const g of genre) {
            if (this.genreMap.get(g))
                count++;
        }

        return (count > 3 ? count - 3 : 0);
    }

    get isCompactDiscoveryMode() {
        return this.compactDiscovery === true;
    }

    get isExternalOnlyDiscoveryBook() {
        return this.book && this.book.discoveryMissingLocal === true;
    }

    get displayGenreItems() {
        return (this.isCompactDiscoveryMode ? this.bookGenreItems.slice(0, 2) : this.bookGenreItems);
    }

    get displayGenreOverflowCount() {
        if (!this.isCompactDiscoveryMode)
            return this.genreOverflowCount;

        const genre = (this.book.genre || '').split(',');
        let count = 0;

        for (const g of genre) {
            if (this.genreMap.get(g))
                count++;
        }

        return (count > 2 ? count - 2 : 0);
    }

    get bookDate() {
        if (!this.book.date)
            return '';

        return utils.sqlDateFormat(this.book.date);
    }

    get downloadLabel() {
        if (this.book.ext)
            return `${this.downloadBase} ${this.book.ext.toUpperCase()}`;

        return this.downloadBase;
    }

    get effectiveDownloadLabel() {
        return (this.isCompactDiscoveryMode ? this.downloadBase : this.downloadLabel);
    }

    get primaryActionLabel() {
        if (this.isExternalOnlyDiscoveryBook)
            return 'Открыть источник';

        return this.effectiveDownloadLabel;
    }

    get deletedLabel() {
        return '\u0423\u0434\u0430\u043b\u0435\u043d\u043e';
    }

    get readLabel() {
        return '\u0427\u0438\u0442\u0430\u0442\u044c';
    }

    get effectiveReadLabel() {
        return this.readLabel;
    }

    get infoLabel() {
        return '\u0418\u043d\u0444\u043e';
    }

    get authorInfoLabel() {
        return '\u041e\u0431\u0020\u0430\u0432\u0442\u043e\u0440\u0435';
    }

    get readingListLabel() {
        return '\u0412\u0020\u0441\u043f\u0438\u0441\u043e\u043a';
    }

    get markReadLabel() {
        return '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e';
    }

    get markUnreadLabel() {
        return '\u0421\u043d\u044f\u0442\u044c';
    }

    get effectiveReadingListLabel() {
        return (this.isCompactDiscoveryMode ? '\u0421\u043f\u0438\u0441\u043e\u043a' : this.readingListLabel);
    }

    get effectiveDiscoveryDismissLabel() {
        return (this.isCompactDiscoveryMode ? '\u0421\u043a\u0440\u044b\u0442\u044c' : this.discoveryDismissLabel);
    }

    get effectiveDiscoveryRestoreLabel() {
        return (this.isCompactDiscoveryMode ? '\u0412\u0435\u0440\u043d\u0443\u0442\u044c' : this.discoveryRestoreLabel);
    }

    get seriesLabel() {
        return '\u0421\u0435\u0440\u0438\u044f';
    }

    get noTitleLabel() {
        return '\u0411\u0435\u0437\u0020\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f';
    }

    get downloadBase() {
        return '\u0421\u043a\u0430\u0447\u0430\u0442\u044c';
    }

    get downloadIcon() {
        return (this.book.ext && this.book.ext.toLowerCase() == 'fb2' ? 'la la-file-download' : 'la la-download');
    }

    get primaryActionIcon() {
        return (this.isExternalOnlyDiscoveryBook ? 'la la-external-link-alt' : this.downloadIcon);
    }

    get isPosterMode() {
        return this.mode == 'title' || this.mode == 'extended';
    }

    get hasInlineActionsLayout() {
        return this.mode == 'author' || this.mode == 'series';
    }

    get extraFormats() {
        const currentExt = (this.book.ext || '').toLowerCase();
        if (!this.conversionEnabled)
            return [];

        return this.availableConversionFormats.filter(format => format !== currentExt);
    }

    get formatDropdownLabel() {
        return `Форматы (${this.extraFormats.length})`;
    }

    get telegramFormats() {
        const currentExt = (this.book.ext || '').toLowerCase();
        const result = [];

        if (currentExt)
            result.push(currentExt);

        if (this.conversionEnabled) {
            for (const format of this.availableConversionFormats) {
                if (!result.includes(format))
                    result.push(format);
            }
        }

        return result;
    }

    get emailFormats() {
        return this.telegramFormats;
    }

    handleOutsideClick() {
        this.telegramMenuOpen = false;
        this.emailMenuOpen = false;
        this.formatMenuOpen = false;
    }

    toggleShareMenu(type) {
        if (type == 'telegram') {
            this.telegramMenuOpen = !this.telegramMenuOpen;
            if (this.telegramMenuOpen) {
                this.emailMenuOpen = false;
                this.formatMenuOpen = false;
            }
        } else if (type == 'email') {
            this.emailMenuOpen = !this.emailMenuOpen;
            if (this.emailMenuOpen) {
                this.telegramMenuOpen = false;
                this.formatMenuOpen = false;
            }
        } else if (type == 'format') {
            this.formatMenuOpen = !this.formatMenuOpen;
            if (this.formatMenuOpen) {
                this.telegramMenuOpen = false;
                this.emailMenuOpen = false;
            }
        }
    }

    selectShareFormat(type, format) {
        this.telegramMenuOpen = false;
        this.emailMenuOpen = false;

        if (type == 'telegram')
            this.emit('sendTelegram', format);
        else if (type == 'email')
            this.emit('sendEmail', format);
    }

    selectDownloadFormat(format) {
        this.formatMenuOpen = false;
        this.emit('download', format);
    }

    get placeholderStyle() {
        const seed = (this.book.libid || this.posterTitle || '').toString();
        let sum = 0;
        for (const char of seed)
            sum += char.charCodeAt(0);

        const palettes = [
            ['#f8f1d8', '#f0b45b', '#d76752'],
            ['#dff5ef', '#67c9c0', '#1f7a8c'],
            ['#f6e4ec', '#d97ca4', '#7a4069'],
            ['#e4eefb', '#7a9ef8', '#314d8a'],
            ['#eef4da', '#9fc56b', '#516a2d'],
        ];
        const palette = palettes[sum % palettes.length];

        return {
            background: `linear-gradient(160deg, ${palette[0]} 0%, ${palette[1]} 58%, ${palette[2]} 100%)`,
        };
    }

    handlePrimaryAction() {
        if (this.isExternalOnlyDiscoveryBook) {
            this.openExternalSource();
            return;
        }

        this.emit('download');
    }

    handleCardActivate() {
        if (this.isExternalOnlyDiscoveryBook) {
            this.openExternalSource();
            return;
        }

        this.emit('bookInfo');
    }

    handleAuthorActivate() {
        if (this.isExternalOnlyDiscoveryBook) {
            this.openExternalSource();
            return;
        }

        this.emit('authorClick');
    }

    openExternalSource() {
        if (this.book && this.book.discoveryUrl)
            window.open(this.book.discoveryUrl, '_blank');
    }

    emit(action, format = '') {
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
.clickable2 {
    cursor: pointer;
}

.book-view {
    line-height: 1.35;
    height: 100%;
    display: flex;
}

.book-card {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 18px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid var(--app-border);
    background:
        radial-gradient(circle at top right, rgba(15, 159, 143, 0.08), transparent 26%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.02)),
        var(--app-surface);
    box-shadow: 0 14px 30px rgba(23, 32, 38, 0.06);
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    height: 100%;
    width: 100%;
    cursor: pointer;
}

.book-card.is-poster-mode {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    overflow: hidden;
    padding: 0;
}

.book-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 18px 34px rgba(23, 32, 38, 0.10);
    border-color: color-mix(in srgb, var(--app-border) 70%, var(--app-primary));
}

.book-card:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--app-primary) 72%, white);
    outline-offset: 2px;
}

.book-card.is-poster-mode .cover-box {
    height: 292px;
    border-radius: 0;
    box-shadow: none;
}

.book-card.is-poster-mode .cover-placeholder,
.book-card.is-poster-mode .cover-image {
    border-radius: 0;
}

.book-card.is-poster-mode .book-content {
    padding: 12px;
}

.book-card.is-poster-mode .book-title {
    font-size: 18px;
}

.book-card.is-poster-mode .book-actions {
    padding-top: 6px;
}

.book-card.is-compact-discovery {
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
}

.book-card.is-compact-discovery .cover-box {
    height: 132px;
    padding: 8px;
}

.book-card.is-compact-discovery .book-content {
    grid-template-rows:
        auto
        auto
        auto
        auto
        auto
        minmax(0, 1fr)
        auto;
    row-gap: 6px;
    align-content: start;
}

.book-card.is-compact-discovery .book-author {
    min-height: 0;
    font-size: 13px;
    -webkit-line-clamp: 1;
}

.book-card.is-compact-discovery .book-meta-pills {
    height: auto;
    gap: 5px;
}

.book-card.is-compact-discovery .book-title {
    font-size: 17px;
    block-size: calc(1.1em * 2);
    -webkit-line-clamp: 2;
}

.book-card.is-compact-discovery .book-title-row {
    grid-template-columns: 44px minmax(0, 1fr);
    min-height: 0;
    gap: 8px;
    margin-bottom: 0;
}

.book-card.is-compact-discovery .serno-slot {
    min-width: 44px;
}

.book-card.is-compact-discovery .book-meta-pills {
    gap: 6px;
}

.book-card.is-compact-discovery .meta-pill,
.book-card.is-compact-discovery .serno-pill {
    font-size: 11px;
    min-height: 22px;
    padding: 3px 8px;
}

.book-card.is-compact-discovery .book-series {
    block-size: auto;
    min-height: 0;
    font-size: 13px;
    -webkit-line-clamp: 1;
}

.book-card.is-compact-discovery .book-discovery-note {
    font-size: 12px;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.book-card.is-compact-discovery .book-genres {
    gap: 5px;
    min-height: 0;
}

.book-card.is-compact-discovery .genre-chip {
    padding: 3px 7px;
    font-size: 11px;
}

.book-card.is-compact-discovery .book-actions {
    gap: 6px;
    min-height: 0;
    padding-top: 0;
}

.book-card.is-compact-discovery .primary-action {
    grid-column: 1 / -1;
    border-radius: 10px;
}

.book-card.is-compact-discovery .book-actions :deep(.q-btn) {
    min-height: 32px;
    font-size: 12px;
    border-radius: 10px;
}

.book-card.is-compact-discovery .format-actions {
    gap: 6px;
}

.cover-box {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 164px;
    padding: 10px;
    border-radius: 16px;
    overflow: hidden;
    background: var(--app-surface-2);
    box-shadow: inset 0 0 0 1px rgba(23, 32, 38, 0.08);
}

.cover-image,
.cover-placeholder {
    width: 100%;
    height: 100%;
}

.cover-image {
    display: block;
    object-fit: contain;
}

.cover-placeholder {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 14px;
    color: var(--app-text);
}

.cover-letter {
    width: 42px;
    height: 42px;
    margin-bottom: auto;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.8);
    color: rgba(18, 24, 28, 0.92);
    font-size: 24px;
    font-weight: 800;
    box-shadow: 0 8px 20px rgba(23, 32, 38, 0.12);
}

.cover-placeholder-title {
    font-size: 15px;
    font-weight: 800;
    line-height: 1.2;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.cover-placeholder-ext {
    margin-top: 10px;
    align-self: flex-start;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.7);
    color: rgba(18, 24, 28, 0.86);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.03em;
}

:global(body.body--dark) .cover-letter {
    background: rgba(255, 255, 255, 0.9);
    color: rgba(12, 18, 24, 0.94);
    box-shadow:
        0 10px 24px rgba(0, 0, 0, 0.32),
        inset 0 0 0 1px rgba(255, 255, 255, 0.24);
}

:global(body.body--dark) .cover-placeholder-title {
    color: rgba(248, 250, 252, 0.96);
    text-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
}

:global(body.body--dark) .cover-placeholder-ext {
    background: rgba(255, 255, 255, 0.86);
    color: rgba(12, 18, 24, 0.9);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}

.cover-badge {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    padding: 5px 8px;
    border-radius: 10px;
    color: white;
    font-size: 11px;
    font-weight: 800;
    text-align: center;
    backdrop-filter: blur(8px);
}

.rating-pill.badge-good {
    background: rgba(21, 128, 61, 0.85);
    color: white;
}

.rating-pill.badge-mid {
    background: rgba(180, 83, 9, 0.82);
    color: white;
}

.rating-pill.badge-bad {
    background: rgba(185, 28, 28, 0.82);
    color: white;
}

.deleted-badge {
    background: rgba(127, 29, 29, 0.82);
}

.book-content {
    min-width: 0;
    display: grid;
    grid-template-rows:
        calc(1.35em * 2)
        30px
        calc(1.1em * 3)
        calc(1.35em * 2)
        minmax(32px, auto)
        minmax(42px, auto)
        minmax(32px, auto);
    gap: 10px;
    height: 100%;
}

.book-author {
    grid-row: 1;
    color: #14705e;
    font-size: 14px;
    font-weight: 700;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: calc(1.35em * 2);
}

.book-meta-pills {
    grid-row: 2;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    height: 30px;
    align-items: center;
    align-content: center;
}

.meta-pill,
.serno-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(23, 32, 38, 0.06);
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 700;
}

.rating-pill {
    min-width: 56px;
}

.rating-pill-placeholder {
    visibility: hidden;
}

.book-title-row {
    grid-row: 3;
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: start;
    min-height: calc(1.1em * 3);
    gap: 10px;
    margin-bottom: 4px;
}

.serno-slot {
    min-width: 56px;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
}

.serno-pill-placeholder {
    visibility: hidden;
}

.book-title {
    min-width: 0;
    font-size: 23px;
    font-weight: 800;
    line-height: 1.04;
    letter-spacing: -0.02em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    block-size: calc(1.1em * 3);
}

.book-series {
    grid-row: 4;
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
    padding-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    block-size: calc(1.35em * 2);
}

.book-discovery-note {
    grid-row: 5;
    color: var(--app-muted);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
    padding-top: 2px;
}

.book-genres {
    grid-row: 6;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 13px;
    min-height: 32px;
    align-content: flex-start;
}

.genre-chip {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.10);
    color: var(--app-link);
    font-weight: 600;
}

.genre-chip-muted {
    background: rgba(23, 32, 38, 0.06);
    color: var(--app-muted);
}

.book-actions {
    grid-row: 7;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding-top: 2px;
    min-height: 84px;
}

.book-actions--external-only {
    grid-template-columns: minmax(0, max-content);
    min-height: auto;
}

.book-actions > * {
    min-width: 0;
    align-self: stretch;
}

.book-actions :deep(.q-btn) {
    min-height: 36px;
    width: 100%;
}

.book-actions :deep(.q-btn__content) {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    line-height: 1;
    width: 100%;
}

.book-actions :deep(.q-icon),
.book-actions :deep([class*='la-']) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.book-actions :deep(.q-btn--round) {
    width: 100%;
    min-width: 0;
    min-height: 36px;
    padding: 0;
}

.action-split {
    position: relative;
    display: inline-flex;
    align-items: center;
    align-self: stretch;
    width: 100%;
    border-radius: 999px;
    background: rgba(23, 32, 38, 0.04);
}

.action-split :deep(.q-btn) {
    min-height: 36px;
    flex: 1 1 auto;
}

.action-split-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 36px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    line-height: 1;
}

.action-split-toggle:hover {
    background: rgba(23, 32, 38, 0.06);
}

.action-split-toggle i {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
}

.action-split-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    z-index: 20;
    min-width: 120px;
    padding: 6px;
    border-radius: 14px;
    border: 1px solid var(--app-border);
    background: var(--app-surface);
    box-shadow: 0 14px 28px rgba(23, 32, 38, 0.16);
}

.action-split-item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 8px 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.action-split-item:hover {
    background: rgba(15, 159, 143, 0.08);
}

.format-actions {
    grid-row: 8;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 32px;
    align-content: flex-start;
}

.format-split {
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-primary) 7%, transparent);
    color: var(--app-primary);
}

.book-select-checkbox {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 3;
    padding: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface) 84%, transparent);
    box-shadow: 0 6px 14px rgba(23, 32, 38, 0.16);
}

.format-split :deep(.q-btn__content) {
    color: var(--app-primary);
    font-weight: 800;
}

.primary-action {
    border-radius: 12px;
}

.primary-action--external-only {
    justify-self: start;
}

.primary-action--external-only:deep(.q-btn) {
    width: auto;
    min-width: 0;
    padding-left: 12px;
    padding-right: 12px;
}

.primary-action--external-only:deep(.q-btn__content) {
    justify-content: center;
    width: auto;
}

@media (min-width: 721px) {
    .book-card.has-inline-actions {
        grid-template-columns: 136px minmax(0, 1fr);
        gap: 22px;
    }

    .book-card.has-inline-actions .cover-box {
        height: 196px;
        padding: 12px;
    }

    .book-card.has-inline-actions .book-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 8px;
        min-height: auto;
    }

    .book-card.has-inline-actions .book-actions > * {
        flex: 0 0 auto;
        align-self: auto;
    }

    .book-card.has-inline-actions .book-actions :deep(.q-btn) {
        width: auto;
        min-width: 0;
    }

    .book-card.has-inline-actions .book-actions :deep(.q-btn__content) {
        width: auto;
        justify-content: center;
    }

    .book-card.has-inline-actions .action-split {
        width: auto;
        align-self: auto;
        flex: 0 0 auto;
    }

    .book-card.has-inline-actions .action-split :deep(.q-btn) {
        flex: 0 0 auto;
        width: auto;
        min-width: 0;
    }

    .book-card.has-inline-actions .action-split :deep(.q-btn__content) {
        width: auto;
        justify-content: center;
    }

    .book-card.has-inline-actions .action-split-toggle {
        flex: 0 0 auto;
    }

    .book-card.has-inline-actions .primary-action {
        justify-self: start;
    }

    .book-card.has-inline-actions .primary-action:deep(.q-btn) {
        padding-left: 14px;
        padding-right: 14px;
    }
}

.copy-action {
    min-width: 0;
    border-radius: 12px;
}

.copy-action :deep(.q-btn__content) {
    justify-content: flex-start;
}

.book-json pre {
    margin: 0;
    padding: 12px;
    border-radius: 12px;
    background: rgba(23, 32, 38, 0.05);
    font-size: 12px;
    white-space: pre-wrap;
}

.book-json {
    grid-row: 9;
}

@media (max-width: 720px) {
    .book-card {
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 12px;
        padding: 12px;
        border-radius: 16px;
    }

    .cover-box {
        height: 132px;
    }

    .book-card.is-poster-mode .cover-box {
        height: 236px;
    }

    .book-title {
        font-size: 18px;
    }
}

@media (max-width: 520px) {
    .book-view {
        margin-top: 8px;
        margin-bottom: 8px;
    }

    .book-card {
        grid-template-columns: 72px minmax(0, 1fr);
        gap: 10px;
        padding: 10px;
        border-radius: 14px;
    }

    .cover-box {
        height: 116px;
        padding: 8px;
        border-radius: 12px;
    }

    .book-card.is-poster-mode .cover-box {
        height: 208px;
    }

    .book-content {
        grid-template-rows:
            calc(1.35em * 2)
            26px
            calc(1.1em * 2)
            auto
            auto
            minmax(42px, auto)
            minmax(32px, auto);
        gap: 8px;
    }

    .book-author {
        font-size: 13px;
    }

    .meta-pill,
    .serno-pill {
        padding: 3px 8px;
        font-size: 11px;
    }

    .book-title {
        font-size: 16px;
        block-size: calc(1.1em * 2);
        -webkit-line-clamp: 2;
    }

    .book-series {
        block-size: 1.35em;
        font-size: 13px;
        padding-top: 3px;
        -webkit-line-clamp: 1;
    }

    .book-genres {
        gap: 6px;
        min-height: auto;
    }

    .genre-chip {
        padding: 3px 8px;
        font-size: 12px;
    }

    .book-actions {
        gap: 6px;
        min-height: auto;
    }

    .book-actions :deep(.q-btn),
    .format-actions :deep(.q-btn) {
        min-height: 34px;
        padding-left: 8px;
        padding-right: 8px;
        font-size: 12px;
    }

    .action-split-toggle {
        height: 34px;
    }

    .format-actions {
        gap: 6px;
        min-height: auto;
    }
}

</style>
