<template>
    <q-dialog v-model="active" :aria-labelledby="shelvesAppearance ? titleId : undefined" no-route-dismiss @show="onShow" @hide="onHide">
        <div class="column bg-white no-wrap" :class="{'library-dialog-card': shelvesAppearance}" :data-dialog-kind="variant || undefined">
            <div class="header row">
                <div :id="shelvesAppearance ? titleId : undefined" class="caption col row items-center q-ml-md">
                    <slot name="header"></slot>
                </div>
                <div class="close-icon column justify-center items-center">
                    <q-btn v-close-popup flat round dense aria-label="Закрыть окно">
                        <q-icon name="la la-times" size="18px"></q-icon>
                    </q-btn>
                </div>
            </div>

            <div class="col column q-mx-md dialog-body">
                <slot></slot>
            </div>

            <div v-if="$slots.footer" class="row justify-end q-pa-md dialog-footer">
                <slot name="footer"></slot>
            </div>
        </div>
    </q-dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import * as utils from '../../share/utils';
let nextDialogId = 0;

class Dialog {
    _props = {
        modelValue: Boolean,
        variant: String,
    };

    shown = false;
    titleId = '';

    created() {this.titleId = `library-dialog-${++nextDialogId}`;}

    get shelvesAppearance() {
        return this.$store?.state.settings.catalogAppearance === 'shelves' && !String(this.$route?.path || '').startsWith('/reader');
    }

    get active() {
        return this.modelValue;
    }

    set active(value) {
        this.$emit('update:modelValue', value);
    }

    onShow() {
        this.shown = true;
    }

    onHide() {
        this.shown = false;
    }

    async waitShown() {
        let i = 100;
        while (!this.shown && i > 0) {
            await utils.sleep(10);
            i--;
        }
    }
}

export default vueComponent(Dialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.library-dialog-card {width: min(640px, calc(100vw - 40px)); max-width: calc(100vw - 40px) !important; max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); border-radius: 22px; overflow: hidden; color: var(--app-text);}
.library-dialog-card[data-dialog-kind="settings"], .library-dialog-card[data-dialog-kind="profiles"], .library-dialog-card[data-dialog-kind="reading-lists"] {width: min(920px, calc(100vw - 40px));}
.library-dialog-card[data-dialog-kind="book"] {width: min(640px, calc(100vw - 40px));}
.library-dialog-card[data-dialog-kind="book-info"] {width: min(1040px, calc(100vw - 40px));}
.library-dialog-card > .header {padding: 12px 12px 12px 20px; min-height: 64px; flex-shrink: 0; align-items: center;}
.library-dialog-card .caption {font-size: 18px; font-weight: 550; line-height: 1.4; margin: 0;}
.library-dialog-card .caption :deep([style]) {font-size: inherit !important;}
.library-dialog-card .close-icon {width: 40px; color: var(--app-muted); flex-shrink: 0;}
.library-dialog-card .dialog-body {display: block; min-height: 0; overflow: auto; margin: 0; padding: 8px 20px 22px; flex: 1 1 auto;}
.library-dialog-card .dialog-footer {padding: 14px 20px; gap: 8px; border-top: 1px solid var(--app-border); flex-shrink: 0;}
.library-dialog-card .dialog-footer :deep(.q-btn) {font-size: 13px; font-weight: 550; min-height: 38px; border-radius: 10px; margin: 0;}
@media (max-width: 599px) {.library-dialog-card {width: calc(100vw - 24px); max-width: calc(100vw - 24px) !important; max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); border-radius: 18px;} .library-dialog-card > .header {padding: 10px 10px 8px 16px; min-height: 56px;} .library-dialog-card .caption {font-size: 17px;} .library-dialog-card .dialog-body {padding: 8px 16px 18px;} .library-dialog-card .dialog-footer {padding: 12px 16px;}}
.header {
    min-height: 50px;
}

.caption {
    font-size: 110%;
    overflow: hidden;
}

.close-icon {
    width: 50px;
}
</style>
