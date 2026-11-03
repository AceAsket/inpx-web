function decorate(content, config) {
    if (config?.opds?.compatibility !== 'tolino') return content;
    return {...content, entry:(content.entry || []).map(entry => {
        const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
        const navigation = links.find(link => link['*ATTRS']?.rel === 'subsection');
        if (!navigation || links.some(link => link['*ATTRS'] && !link['*ATTRS'].rel)) return entry;
        const attrs = {...navigation['*ATTRS']}; delete attrs.rel;
        return {...entry, link:[...links, {'*ATTRS':attrs}]};
    })};
}

function mount(app, paths, handler, config) {
    app.get(paths, handler);
    app.post(paths, (req, res, next) => config.opds.compatibility === 'tolino' ? handler(req, res, next) : res.sendStatus(405));
}

module.exports = {decorate, mount};
