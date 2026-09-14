import 'quasar/dist/quasar.css';
import {
    Quasar, QLinearProgress, QInput, QBtn, QBtnToggle, QIcon, QTabs, QTab,
    QItem, QItemSection, QItemLabel, QTooltip, QCheckbox, QSelect, QPopupProxy,
    QDate, QDialog, QTree, QOptionGroup, QKnob, Ripple, ClosePopup, Dark, Notify,
} from 'quasar';
import lang from 'quasar/lang/ru';
import '@quasar/extras/line-awesome/line-awesome.css';
import lineAwesome from 'quasar/icon-set/line-awesome.js';

const components = {
    QLinearProgress, QInput, QBtn, QBtnToggle, QIcon, QTabs, QTab,
    QItem, QItemSection, QItemLabel, QTooltip, QCheckbox, QSelect,
    QPopupProxy, QDate, QDialog, QTree, QOptionGroup, QKnob,
};

export default {
    quasar: Quasar,
    options: {
        config: {},
        components,
        directives: {Ripple, ClosePopup},
        plugins: {Dark, Notify},
        lang,
    },
    init: () => {
        Quasar.iconSet.set(lineAwesome);
    },
};
