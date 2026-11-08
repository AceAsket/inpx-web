const assert=require('assert/strict'),fs=require('fs-extra'),os=require('os'),path=require('path');
const images=require('../server/core/ImageUtils');
const {normalizeEmbeddedImages}=require('../server/core/Fb2Images');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZcQAAAAASUVORK5CYII=','base64');
const webp=Buffer.from('RIFF0000WEBPpayload'),jxl=Buffer.from('ff0a010203','hex');
const document=()=>'<FictionBook><description><title-info><coverpage><image href="#cover.jpg"/></coverpage></title-info></description><body><section><image href="#picture.jxl"/><p>Text preserved.</p></section></body>'
    +`<binary id="cover.jpg" content-type="image/jpeg">${webp.toString('base64')}</binary>`
    +`<binary id="picture.jxl" content-type="image/png">${jxl.toString('base64')}</binary>`
    +`<binary id="correct-bytes" content-type="image/jpeg">${png.toString('base64')}</binary>`
    +'<binary id="attachment" content-type="application/octet-stream">YWJj</binary></FictionBook>';
async function temporary(work){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inpx-fb2-images-'));try{await work(dir);}finally{await fs.remove(dir);}}
async function testFb2EmbeddedImageSignaturesOverrideWrongMimeAndKeepReferences(){
    await temporary(async dir=>{
        const file=path.join(dir,'book.fb2'),original=images.normalizeForFb2,calls=[];await fs.writeFile(file,document());
        images.normalizeForFb2=async bytes=>{calls.push(images.contentType(bytes));return {data:png,contentType:'image/png'};};
        try{
            assert.equal(await normalizeEmbeddedImages(file,{tempDir:dir}),true);
            const text=await fs.readFile(file,'utf8');assert(text.includes('<image href="#cover.jpg"/>'));assert(text.includes('<image href="#picture.jxl"/>'));
            assert(text.includes('<binary id="cover.jpg" content-type="image/png">'));assert(text.includes('<binary id="picture.jxl" content-type="image/png">'));
            assert(text.includes('<binary id="correct-bytes" content-type="image/png">'));
            assert(text.includes('<binary id="attachment" content-type="application/octet-stream">YWJj</binary>'));
            assert.deepEqual(calls,['image/webp','image/jxl','image/png']);
            assert.equal(await normalizeEmbeddedImages(file,{tempDir:dir}),false);assert.equal(calls.length,3,'Normalized images are not decoded again');
        }finally{images.normalizeForFb2=original;}
    });
}
async function testFb2EmbeddedImageFailureDoesNotWritePartialDocument(){
    await temporary(async dir=>{
        const file=path.join(dir,'book.fb2'),text=document(),original=images.normalizeForFb2;await fs.writeFile(file,text);
        images.normalizeForFb2=async()=>{throw Object.assign(new Error('decoder unavailable'),{code:'INPX_MISSING_DWEBP'});};
        try{await assert.rejects(normalizeEmbeddedImages(file,{tempDir:dir}),{code:'INPX_MISSING_DWEBP'});assert.equal(await fs.readFile(file,'utf8'),text);}
        finally{images.normalizeForFb2=original;}
    });
}
module.exports=[testFb2EmbeddedImageSignaturesOverrideWrongMimeAndKeepReferences,testFb2EmbeddedImageFailureDoesNotWritePartialDocument];
