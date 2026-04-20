<template>
    <div class="book-view q-my-sm">
        <div class="book-card">
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

                <div v-if="showRates && !book.del && book.librate" class="cover-badge rating-badge" :class="rateBadgeColor">
                    {{ book.librate }}/5
                </div>
                <div v-if="book.del && showDeleted" class="cover-badge deleted-badge">
                    {{ deletedLabel }}
                </div>
            </div>

            <div class="book-content">
                <div class="book-topline">
                    <div v-if="(mode == 'series' || mode == 'title' || mode == 'extended') && bookAuthor" class="book-author clickable2" @click.stop.prevent="emit('authorClick')">
                        {{ bookAuthor }}
                    </div>
                    <div class="book-meta-pills">
                        <div class="meta-pill">
                            {{ posterExt }}
                        </div>
                        <div class="meta-pill">
                            {{ bookSize }}
                        </div>
                        <div v-if="showDates && book.date" class="meta-pill">
                            {{ bookDate }}
                        </div>
                    </div>
                </div>

                <div class="book-title-row">
                    <div v-if="book.serno" class="serno-pill">
                        {{ book.serno }}
                    </div>
                    <div class="book-title clickable2" :class="titleColor" @click.stop.prevent="emit('titleClick')">
                        {{ posterTitle }}
                    </div>
                </div>

                <div v-if="(mode == 'title' || mode == 'extended') && bookSeries" class="book-series clickable2" @click.stop.prevent="emit('seriesClick')">
                    {{ bookSeries }}
                </div>

                <div v-if="showGenres && book.genre" class="book-genres">
                    {{ bookGenre }}
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
                        flat
                        round
                        icon="la la-copy"
                        @click.stop.prevent="emit('copyLink')"
                    />
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

    created() {
        this.loadSettings();
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

    get bookGenre() {
        let result = [];
        const genre = this.book.genre.split(',');

        for (const g of genre) {
            const name = this.genreMap.get(g);
            if (name)
                result.push(name);
        }

        return result.join(' / ');
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

    emit(action) {
        this.$emit('bookEvent', {action, book: this.book});
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
}

.book-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 18px 34px rgba(23, 32, 38, 0.10);
    border-color: color-mix(in srgb, var(--app-border) 70%, var(--app-primary));
}

.cover-box {
    position: relative;
    height: 164px;
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
    object-fit: cover;
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

.rating-badge.badge-good {
    background: rgba(21, 128, 61, 0.85);
}

.rating-badge.badge-mid {
    background: rgba(180, 83, 9, 0.82);
}

.rating-badge.badge-bad {
    background: rgba(185, 28, 28, 0.82);
}

.deleted-badge {
    background: rgba(127, 29, 29, 0.82);
}

.book-content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    justify-content: center;
}

.book-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.book-author {
    color: #14705e;
    font-size: 14px;
    font-weight: 700;
}

.book-meta-pills {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
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

.book-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}

.book-title {
    min-width: 0;
    font-size: 23px;
    font-weight: 800;
    line-height: 1.1;
}

.book-series {
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
}

.book-genres {
    color: var(--app-muted);
    font-size: 13px;
}

.book-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 2px;
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

    .book-title {
        font-size: 18px;
    }
}

</style>
