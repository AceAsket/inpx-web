const {createWriteStream} = require('node:fs');
const {pipeline} = require('node:stream/promises');
const {ZipFile} = require('yazl');

// Each of 64 groups contributes five live books, three after the simple
// reindex and one after the regex reindex. The exact-title search adds one.
const expected = [321, 193, 65];

async function writeFixture(file) {
    const zip = new ZipFile();
    const output = pipeline(zip.outputStream, createWriteStream(file, {flags:'wx'}));
    const add = (name, text) => zip.addBuffer(Buffer.from(text), name, {
        mtime:new Date(2020, 0, 1), forceDosTimestamp:true,
    });
    const author = 'Булгаков,Михаил,Афанасьевич:';
    let id = 0;
    const row = (name, title, del = 0, lang = 'ru', ext = 'fb2') =>
        [name,'sf:',title,'Серия',1,++id,500,id,del,ext,'2020-01-01',lang,0,''].join('\x04');
    add('collection.info','RC15 compatibility CI\n');
    add('version.info','20200101');
    for (let part = 0; part < 8; part++) {
        const rows = part ? [] : [row(author,'Мастер и Маргарита')];
        for (let i = part * 8; i < (part + 1) * 8; i++) {
            rows.push(row(author,'Театр '+i), row(author,'Письма '+i),
                row('Клайн,Барбара,Ловетт:','Записки '+i,0,'ru','epub'),
                row('Ауренга:Кимури,Мария:','Главы '+i), row(author,'Letters '+i,0,'en'),
                row(author,'Удалена '+i,1));
            for (let n = 0; n < 512; n++) rows.push(row('Автор,Вне фильтра:','Книга '+id));
        }
        add('part-'+part+'.inp',rows.join('\n')+'\n');
    }
    zip.end();
    await output;
    console.log('Created reproducible RC15 comparison INPX with '+id+' records');
}

module.exports = {expected};
if (require.main === module) writeFixture(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
