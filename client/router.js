import { createRouter, createWebHashHistory } from 'vue-router';
import _ from 'lodash';
import store from './store';
import {appearanceRedirect} from './components/Library/libraryModel';

const Search = () => import('./components/Search/Search.vue');
const Reader = () => import('./components/Reader/Reader.vue');
const ReaderLab = () => import('./components/Reader/ReaderLab.vue');

const myRoutes = [
    ['/', Search],
    ['/author', Search],
    ['/series', Search],
    ['/title', Search],
    ['/books', Search],
    ['/for-you', Search],
    ['/newest', Search],
    ['/popular', Search],
    ['/bestsellers', Search],
    ['/extended', Search],
    ['/overview', () => import('./components/Library/LibraryOverview.vue')],
    ['/my-books', () => import('./components/Library/LibraryBooks.vue')],
    ['/profile', () => import('./components/Library/LibraryProfile.vue')],
    ['/authors', () => import('./components/Library/CatalogIndex.vue')],
    ['/series-index', () => import('./components/Library/CatalogIndex.vue')],
    ['/author-details', () => import('./components/Library/CatalogEntity.vue')],
    ['/series-details', () => import('./components/Library/CatalogEntity.vue')],
    ['/book', () => import('./components/Library/CatalogBook.vue')],
    ['/reader', Reader],
    ['/reader-lab', ReaderLab],
    ['/:pathMatch(.*)*', null, null, '/'],
];

let routes = {};

for (let route of myRoutes) {
    const [path, component, name, redirect] = route;
    let cleanRoute = _.pickBy({path, component, name, redirect}, _.identity);
    
    let parts = cleanRoute.path.split('~');
    let f = routes;
    for (let part of parts) {
        const curRoute = _.assign({}, cleanRoute, { path: part });

        if (!f.children)
            f.children = [];
        let r = f.children;

        f = _.find(r, {path: part});
        if (!f) {
            r.push(curRoute);
            f = curRoute;
        }
    }
}
routes = routes.children;

const router = createRouter({
    history: createWebHashHistory(),
    routes
});

router.beforeEach(to => {
    const redirect = appearanceRedirect(to, store.state.settings.catalogAppearance);
    if (redirect) return {path: redirect, replace: true};
});

export default router;
