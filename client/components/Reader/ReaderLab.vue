<template>
    <div class="reader-lab-page">
        <div v-if="!standaloneSource" class="reader-lab-empty">
            <div class="reader-lab-card">
                <div class="reader-lab-eyebrow">Standalone Reader</div>
                <h1 class="reader-lab-title">Локальная FB2-читалка</h1>
                <p class="reader-lab-text">
                    Откройте локальный `.fb2` с компьютера или загрузите sample-файл из подключённой библиотеки.
                    Этот режим обходит API книги и нужен именно для отладки рендера и пагинации.
                </p>

                <div class="reader-lab-actions">
                    <q-btn
                        unelevated
                        no-caps
                        color="primary"
                        icon="la la-file-upload"
                        label="Открыть FB2"
                        @click="openFilePicker"
                    />
                    <q-btn
                        flat
                        no-caps
                        icon="la la-flask"
                        label="Открыть sample"
                        @click="loadSample()"
                    />
                </div>

                <input
                    ref="fileInput"
                    class="reader-lab-file-input"
                    type="file"
                    accept=".fb2,application/xml,text/xml"
                    @change="handleFileSelected"
                >

                <div v-if="loadingSource" class="reader-lab-status">
                    {{ loadingMessage }}
                </div>
                <div v-else-if="sourceError" class="reader-lab-error">
                    {{ sourceError }}
                </div>
            </div>
        </div>

        <Reader v-else :standalone-source="standaloneSource" />

        <div v-if="standaloneSource" class="reader-lab-floating-actions">
            <q-btn flat dense no-caps icon="la la-file-upload" label="Другой FB2" @click="openFilePicker" />
            <q-btn flat dense no-caps icon="la la-times" label="Сбросить" @click="resetStandaloneSource" />
            <input
                ref="floatingFileInput"
                class="reader-lab-file-input"
                type="file"
                accept=".fb2,application/xml,text/xml"
                @change="handleFileSelected"
            >
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import Reader from './Reader.vue';

const componentOptions = {
    components: {
        Reader,
    },
    watch: {
        '$route.query.sample': {
            immediate: true,
            handler() {
                this.maybeLoadSampleFromRoute();// no await
            },
        },
    },
};

class ReaderLab {
    _options = componentOptions;

    standaloneSource = null;
    loadingSource = false;
    loadingMessage = '';
    sourceError = '';

    get sampleFileName() {
        return String(this.$route.query.sample || 'night-watch.fb2').trim() || 'night-watch.fb2';
    }

    openFilePicker() {
        const input = (this.$refs && (this.$refs.floatingFileInput || this.$refs.fileInput));
        if (input && typeof input.click === 'function')
            input.click();
    }

    resetStandaloneSource() {
        this.standaloneSource = null;
        this.sourceError = '';
        this.loadingMessage = '';
    }

    normalizeEncodingLabel(value = '') {
        const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
        const aliases = {
            utf8: 'utf-8',
            utf16: 'utf-16',
            'utf-16le': 'utf-16le',
            'utf-16be': 'utf-16be',
            cp1251: 'windows-1251',
            win1251: 'windows-1251',
            windows1251: 'windows-1251',
            'windows-1251': 'windows-1251',
            koi8r: 'koi8-r',
        };
        return (aliases[normalized] || normalized || 'utf-8');
    }

    extractXmlEncoding(bytes) {
        try {
            const head = new TextDecoder('iso-8859-1').decode(bytes.slice(0, 1024));
            const match = head.match(/<\?xml[^>]*encoding=['"]([^'"]+)['"]/i);
            return this.normalizeEncodingLabel(match ? match[1] : '');
        } catch (e) {
            return '';
        }
    }

    tryDecodeFb2Bytes(bytes, encoding = '') {
        const normalized = this.normalizeEncodingLabel(encoding);
        if (!normalized)
            return '';

        try {
            return new TextDecoder(normalized).decode(bytes);
        } catch (e) {
            return '';
        }
    }

    decodeFb2Bytes(source) {
        const bytes = (source instanceof Uint8Array ? source : new Uint8Array(source || 0));
        if (!bytes.length)
            return '';

        let bomEncoding = '';
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
            bomEncoding = 'utf-8';
        else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
            bomEncoding = 'utf-16le';
        else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
            bomEncoding = 'utf-16be';

        const candidates = Array.from(new Set([
            bomEncoding,
            this.extractXmlEncoding(bytes),
            'utf-8',
            'windows-1251',
            'koi8-r',
        ].filter(Boolean)));

        let fallbackText = '';
        for (const encoding of candidates) {
            const text = this.tryDecodeFb2Bytes(bytes, encoding);
            if (!text)
                continue;

            if (!fallbackText)
                fallbackText = text;

            if (/<fictionbook[\s>]/i.test(text) || /<body[\s>]/i.test(text))
                return text;
        }

        return fallbackText;
    }

    async maybeLoadSampleFromRoute() {
        if (!this.$route || !Object.prototype.hasOwnProperty.call(this.$route.query || {}, 'sample'))
            return;

        await this.loadSample(this.sampleFileName);
    }

    async handleFileSelected(event) {
        const input = (event && event.target ? event.target : null);
        const file = (input && input.files && input.files[0] ? input.files[0] : null);
        if (!file)
            return;

        this.loadingSource = true;
        this.loadingMessage = 'Чтение локального FB2...';
        this.sourceError = '';
        try {
            const buffer = await file.arrayBuffer();
            const fb2 = this.decodeFb2Bytes(buffer);
            if (!fb2)
                throw new Error('Не удалось декодировать локальный FB2.');
            const safeName = String(file.name || 'local-book.fb2').trim() || 'local-book.fb2';
            this.standaloneSource = {
                sourceKey: `file:${safeName}:${file.size}:${file.lastModified}`,
                fileName: safeName,
                book: {
                    title: safeName.replace(/\.fb2$/i, ''),
                },
                fb2,
            };
        } catch (e) {
            this.sourceError = e.message || 'Не удалось прочитать локальный FB2.';
        } finally {
            this.loadingSource = false;
            this.loadingMessage = '';
            if (input)
                input.value = '';
        }
    }

    async loadSample(fileName = 'night-watch.fb2') {
        this.loadingSource = true;
        this.loadingMessage = 'Загрузка sample-книги...';
        this.sourceError = '';
        try {
            const response = await fetch(`/reader-lab-source/${encodeURIComponent(fileName)}`);
            if (!response.ok)
                throw new Error(`Не удалось загрузить sample: ${response.status}`);

            const buffer = await response.arrayBuffer();
            const fb2 = this.decodeFb2Bytes(buffer);
            if (!fb2)
                throw new Error('Не удалось декодировать sample-книгу.');
            this.standaloneSource = {
                sourceKey: `sample:${fileName}:${fb2.length}`,
                fileName,
                book: {
                    title: fileName.replace(/\.fb2$/i, ''),
                },
                fb2,
            };
        } catch (e) {
            this.sourceError = e.message || 'Не удалось загрузить sample-книгу.';
        } finally {
            this.loadingSource = false;
            this.loadingMessage = '';
        }
    }
}

export default vueComponent(ReaderLab);
</script>

<style scoped>
.reader-lab-page {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100%;
    background:
        radial-gradient(circle at top left, rgba(210, 180, 140, 0.22), transparent 34%),
        linear-gradient(180deg, #f7f2e7 0%, #efe5d3 100%);
}

.reader-lab-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 24px;
}

.reader-lab-card {
    width: min(100%, 720px);
    padding: 28px;
    border: 1px solid rgba(76, 53, 36, 0.12);
    border-radius: 28px;
    background: rgba(255, 251, 244, 0.94);
    box-shadow: 0 26px 60px rgba(90, 66, 42, 0.16);
}

.reader-lab-eyebrow {
    color: #9b6b43;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}

.reader-lab-title {
    margin: 10px 0 12px;
    color: #3f2f20;
    font-size: clamp(28px, 4vw, 42px);
    line-height: 1.04;
}

.reader-lab-text {
    margin: 0;
    color: #6f5a48;
    font-size: 15px;
    line-height: 1.6;
}

.reader-lab-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 20px;
}

.reader-lab-status {
    margin-top: 16px;
    color: #6f5a48;
    font-size: 14px;
    font-weight: 700;
}

.reader-lab-error {
    margin-top: 16px;
    color: #a64132;
    font-size: 14px;
    font-weight: 700;
}

.reader-lab-file-input {
    display: none;
}

.reader-lab-floating-actions {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 30;
    display: flex;
    gap: 8px;
    padding: 8px;
    border: 1px solid rgba(76, 53, 36, 0.14);
    border-radius: 999px;
    background: rgba(255, 251, 244, 0.9);
    backdrop-filter: blur(10px);
}

@media (max-width: 720px) {
    .reader-lab-empty {
        padding: 14px;
    }

    .reader-lab-card {
        padding: 20px;
        border-radius: 22px;
    }

    .reader-lab-floating-actions {
        top: auto;
        right: 10px;
        bottom: 10px;
        left: 10px;
        justify-content: center;
        border-radius: 18px;
    }
}
</style>
