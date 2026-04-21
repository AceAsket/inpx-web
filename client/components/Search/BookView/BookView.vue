<template>
    <div class="book-view q-my-sm">
        <div
            class="book-card"
            :class="{'is-poster-mode': isPosterMode}"
            role="button"
            tabindex="0"
            @click="emit('bookInfo')"
            @keydown.enter.prevent="emit('bookInfo')"
            @keydown.space.prevent="emit('bookInfo')"
        >
            <div class="cover-box">
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
                <div v-if="(mode == 'series' || mode == 'title' || mode == 'extended') && bookAuthor" class="book-author clickable2" @click.stop.prevent="emit('authorClick')">
                    {{ bookAuthor }}
                </div>

                <div class="book-meta-pills">
                    <div class="meta-pill">
                        {{ posterExt }}
                    </div>
                    <div v-if="showRates && !book.del && book.librate" class="meta-pill rating-pill" :class="rateBadgeColor">
                        {{ book.librate }}/5
                    </div>
                    <div v-else-if="showRates && !book.del" class="meta-pill rating-pill rating-pill-placeholder" aria-hidden="true">
                        0/5
                    </div>
                    <div class="meta-pill">
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
                    <div class="book-title clickable2" :class="titleColor" @click.stop.prevent="emit('bookInfo')">
                        {{ posterTitle }}
                    </div>
                </div>

                <div v-if="(mode == 'title' || mode == 'extended') && bookSeries" class="book-series clickable2" @click.stop.prevent="emit('seriesClick')">
                    {{ bookSeries }}
                </div>

                <div v-if="showGenres && bookGenreItems.length" class="book-genres">
                    <span
                        v-for="genre in bookGenreItems"
                        :key="genre.value"
                        class="genre-chip clickable2"
                        @click.stop.prevent="emit('genreClick', genre.value)"
                    >
                        {{ genre.label }}
                    </span>
                    <span v-if="genreOverflowCount" class="genre-chip genre-chip-muted">
                        +{{ genreOverflowCount }}
                    </span>
                </div>

                <div class="book-actions">
                    <q-btn
                        class="primary-action"
                        color="primary"
                        unelevated
                        no-caps
                        :icon="downloadIcon"
                        @click.stop.prevent="emit('download')"
                    >
                        {{ downloadLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showReadLink"
                        color="secondary"
                        flat
                        no-caps
                        icon="la la-book-open"
                        @click.stop.prevent="emit('readBook')"
                    >
                        {{ readLabel }}
                    </q-btn>

                    <q-btn
                        v-if="showInfo"
                        flat
                        no-caps
                        icon="la la-info-circle"
                        @click.stop.prevent="emit('bookInfo')"
                    >
                        {{ infoLabel }}
                    </q-btn>

                    <q-btn
                        v-if="bookAuthor"
                        flat
                        no-caps
                        icon="la la-user-circle"
                        @click.stop.prevent="emit('authorInfo')"
                    >
                        {{ authorInfoLabel }}
                    </q-btn>

                    <q-btn
                        flat
                        no-caps
                        icon="la la-bookmark"
                        @click.stop.prevent="emit('readingList')"
                    >
                        {{ readingListLabel }}
                    </q-btn>

                    <div v-if="telegramShareEnabled" class="action-split" @click.stop>
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

                    <div v-if="emailShareEnabled" class="action-split" @click.stop>
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
                        flat
                        round
                        icon="la la-copy"
                        @click.stop.prevent="emit('copyLink')"
                    />
                </div>

                <div class="format-actions">
                    <q-btn
                        v-for="format in extraFormats"
                        :key="format"
                        class="format-chip"
                        outline
                        dense
                        no-caps
                        color="primary"
                        @click.stop.prevent="emit('download', format)"
                    >
                        {{ format.toUpperCase() }}
                    </q-btn>
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
        titleColor: { type: String, default: 'text-blue-10'},
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
        return (this.book.ext || 'book').toUpperCase();
    }

    get bookSize() {
        let size = this.book.size/1024;
        let unit = 'KB';
        if (size > 1024) {
            size = size/1024;
            unit = 'MB';
        }
        return `${size.toFixed(0)}${unit}`;
    }

    get coverSrc() {
        if (this.coverError || !this.book.libid)
            return '';

        const root = this.config.rootPathStatic || '';
        return `${root}/cover/${this.book.libid}`;
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
        const genre = this.book.genre.split(',');

        for (const g of genre) {
            const name = this.genreMap.get(g);
            if (name)
                result.push({value: g, label: name});
        }

        return result.slice(0, 3);
    }

    get genreOverflowCount() {
        const genre = this.book.genre.split(',');
        let count = 0;

        for (const g of genre) {
            if (this.genreMap.get(g))
                count++;
        }

        return (count > 3 ? count - 3 : 0);
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

    get deletedLabel() {
        return '\u0423\u0434\u0430\u043b\u0435\u043d\u043e';
    }

    get readLabel() {
        return '\u0427\u0438\u0442\u0430\u0442\u044c';
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

    get isPosterMode() {
        return this.mode == 'title' || this.mode == 'extended';
    }

    get extraFormats() {
        const currentExt = (this.book.ext || '').toLowerCase();
        if (!this.conversionEnabled)
            return [];

        return ['epub', 'mobi', 'pdf'].filter(format => format !== currentExt);
    }

    get telegramFormats() {
        const currentExt = (this.book.ext || '').toLowerCase();
        const result = [];

        if (currentExt)
            result.push(currentExt);

        if (this.conversionEnabled) {
            for (const format of ['epub', 'mobi', 'pdf']) {
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
    }

    toggleShareMenu(type) {
        if (type == 'telegram') {
            this.telegramMenuOpen = !this.telegramMenuOpen;
            if (this.telegramMenuOpen)
                this.emailMenuOpen = false;
        } else if (type == 'email') {
            this.emailMenuOpen = !this.emailMenuOpen;
            if (this.emailMenuOpen)
                this.telegramMenuOpen = false;
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

    emit(action, format = '') {
        this.$emit('bookEvent', {action, format, book: this.book});
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
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.03em;
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
        minmax(calc(1.35em * 2), auto)
        30px
        minmax(calc(1.1em * 3), auto)
        minmax(calc(1.35em * 2), auto)
        minmax(32px, auto)
        minmax(42px, auto)
        minmax(32px, auto);
    gap: 10px;
    height: 100%;
}

.book-author {
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
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: start;
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
    min-height: calc(1.1em * 3);
}

.book-series {
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
    padding-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: calc(1.35em * 2);
}

.book-genres {
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
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 2px;
    min-height: 42px;
}

.book-actions :deep(.q-btn) {
    min-height: 36px;
}

.book-actions :deep(.q-btn__content) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    line-height: 1;
}

.book-actions :deep(.q-icon),
.book-actions :deep([class*='la-']) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.action-split {
    position: relative;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: rgba(23, 32, 38, 0.04);
}

.action-split :deep(.q-btn) {
    min-height: 36px;
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
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 32px;
    align-content: flex-start;
}

.format-chip {
    border-radius: 999px;
}

.primary-action {
    border-radius: 12px;
}

.book-json pre {
    margin: 0;
    padding: 12px;
    border-radius: 12px;
    background: rgba(23, 32, 38, 0.05);
    font-size: 12px;
    white-space: pre-wrap;
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
            minmax(calc(1.35em * 2), auto)
            26px
            minmax(calc(1.1em * 2), auto)
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
        min-height: calc(1.1em * 2);
        -webkit-line-clamp: 2;
    }

    .book-series {
        min-height: auto;
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
