import { createStore } from 'vuex';
import VuexPersistence from 'vuex-persist';

import root from './root.js';
import {persistenceOptions} from './persistence';

const debug = process.env.NODE_ENV !== 'production';

const vuexLocal = new VuexPersistence(persistenceOptions);

export default createStore(Object.assign({}, root, {
    modules: {
    },
    strict: debug,
    plugins: [vuexLocal.plugin]
}));
