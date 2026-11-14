import { createStore } from 'vuex';
import root from './root.js';
import {persistSettings} from './persistence';

const debug = process.env.NODE_ENV !== 'production';

export default createStore(Object.assign({}, root, {
    modules: {
    },
    strict: debug,
    plugins: [store => persistSettings(store)]
}));
