<template>
    <div class="page-scroller row items-center q-ml-md q-my-xs">
        <div class="page-scroller-label q-mr-xs">
            Страница
        </div>
        <div class="page-scroller-control trans" :class="{'bg-green-4': highlight, 'bg-white': !highlight}">
            <NumInput
                v-model="page" :min="1" :max="pageCount" mask="#######"
                class="page-scroller-input" minus-icon="la la-chevron-circle-left" plus-icon="la la-chevron-circle-right" :disable="disable" mm-buttons
            />
        </div>
        <div class="page-scroller-count q-ml-xs">
            из {{ pageCount }}
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import NumInput from '../../share/NumInput.vue';
import * as utils from '../../../share/utils';

const componentOptions = {
    components: {
        NumInput
    },
    watch: {
        modelValue(newValue) {
            this.page = newValue;
        },
        page(newValue) {
            this.$emit('update:modelValue', newValue);
        },
    }
};
class PageScroller {
    _options = componentOptions;
    _props = {
        modelValue: Number,
        disable: Boolean,
        pageCount: Number,
    };

    page = 1;
    highlight = false;

    created() {
    }

    async highlightScroller() {
        if (this.inTrans)
            return;

        this.inTrans = true;
        await utils.sleep(300);
        this.highlight = true;
        await utils.sleep(300);
        this.highlight = false;
        await utils.sleep(300);
        this.inTrans = false;
    }
}

export default vueComponent(PageScroller);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.page-scroller {
    font-size: 120%;
    flex-wrap: wrap;
    row-gap: 6px;
    column-gap: 8px;
}

.page-scroller-label,
.page-scroller-count {
    white-space: nowrap;
}

.page-scroller-control {
    max-width: 100%;
}

.page-scroller-input {
    width: 220px;
}

.trans {
    border-radius: 5px;
    transition: background-color 0.3s linear;
}

@media (max-width: 640px) {
    .page-scroller {
        margin-left: 0 !important;
        font-size: 100%;
        align-items: flex-start;
        column-gap: 6px;
    }

    .page-scroller-label {
        order: 1;
        margin-right: auto;
        font-weight: 600;
    }

    .page-scroller-count {
        order: 2;
        margin-left: 0 !important;
        font-size: 12px;
        color: var(--app-muted);
        align-self: center;
    }

    .page-scroller-control {
        order: 3;
        width: 100%;
    }

    .page-scroller-input {
        width: 100%;
    }

    .page-scroller-control :deep(.q-field__control) {
        min-height: 42px;
    }

    .page-scroller-control :deep(.q-field__native) {
        font-size: 15px;
    }

    .page-scroller-control :deep(.button) {
        width: 28px;
        height: 28px;
        font-size: 120%;
    }
}
</style>
