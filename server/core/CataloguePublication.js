const fs = require('node:fs/promises');
const {join} = require('node:path');

const sequenceName = 'books-sequence.bin';
const facets = ['genre','lang','del','date','librate','ext','source'];

async function readBookSequence(directory,generation) {
    const bytes = await fs.readFile(join(directory,sequenceName));
    const header = Buffer.from('INPXSEQ1'+generation);
    if (!bytes.subarray(0,header.length).equals(header) || (bytes.length-header.length)%4!==0)
        throw new Error('Invalid published book sequence');
    const ids = new Uint32Array((bytes.length-header.length)/4);
    for (let index=0;index<ids.length;index++) ids[index]=bytes.readUInt32LE(header.length+4*index);
    return ids;
}

async function writeBookSequence(directory,generation,unchanged,changed,total) {
    const header = Buffer.from('INPXSEQ1'+generation);
    const bytes = Buffer.alloc(header.length+4*total);
    header.copy(bytes);
    let offset=header.length;
    for (const ids of [unchanged,changed]) {
        for (const id of ids) {
            bytes.writeUInt32LE(id,offset);
            offset+=4;
        }
    }
    if (offset!==bytes.length) throw new Error('The published book sequence does not cover the catalogue');
    await fs.writeFile(join(directory,sequenceName),bytes,{flag:'wx'});
}

async function writeFacets(directory,records) {
    const target=join(directory,'facets');
    await fs.mkdir(target);
    for (const name of facets)
        await fs.writeFile(join(target,name),JSON.stringify(records[`${name}Arr`]),{flag:'wx'});
}

module.exports = {readBookSequence,writeBookSequence,writeFacets};
