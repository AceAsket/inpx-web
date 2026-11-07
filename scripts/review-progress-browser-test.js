// Real compiled UI and WebSocket transport; measured-stage frames are supplied
// by an isolated fixture so slow/unknown/error/late cases are deterministic.
const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {unusedPort} = require('./binary-smoke-test');
const {fixture} = require('./library-appearance-browser-test');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

(async()=>{
    const directory = process.env.INPX_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(),'inpx-review-progress-ui-'));
    await fs.ensureDir(directory);
    let browser,child,page,output='';
    try {
        const library = path.join(directory,'library'); await fixture(library);
        const dataDir = path.join(directory,'data'); await fs.copy(path.resolve('dist/tmp/public'),path.join(dataDir,'public'));
        const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath,[path.resolve('server'),`--data-dir=${dataDir}`,`--config=${library}/config.json`,`--lib-dir=${library}`,`--port=${port}`,'--host=127.0.0.1'],
            {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,INPX_TTS_ENABLED:'false',INPX_LIBRARY_SOURCES:'',LIBRARY_SOURCES:'',
                INPX_ADMIN_PASSWORD:'progress-local-fixture',INPX_REQUIRE_AUTH:'false',INPX_AUTH_MODE:'local',INPX_ALLOW_ANONYMOUS_ACCESS:'true',INPX_TELEGRAM_BOT_ENABLED:'false'}});
        for (const stream of [child.stdout,child.stderr]) stream.on('data',data=>{output=(output+data).slice(-12000);});
        let ready=false;
        for(let i=0;i<120;i++) {
            try {const response=await fetch(base+'/ready');ready=response.ok && (await response.json()).ready;} catch (_) { /* Local startup. */ }
            if(ready || child.exitCode!==null) break; await pause(500);
        }
        assert(ready,output);
        const books = await new Promise((resolve,reject)=>{
            const socket = new (require('ws'))(base.replace(/^http/,'ws')+'/ws');
            const timer=setTimeout(()=>{socket.terminate();reject(new Error('Fixture search timeout'));},15000);
            socket.on('error',reject);
            socket.on('open',()=>socket.send(JSON.stringify({action:'search',from:'title',query:{title:'Косточка',del:'0',limit:10},requestId:'fixture-search'})));
            socket.on('message',raw=>{const value=JSON.parse(raw);if(value._rok)return;clearTimeout(timer);socket.close();if(value.error)reject(new Error(value.error));else resolve(value.found.flatMap(row=>row.books||[]));});
        });
        assert(books.length>=2);
        browser = await chromium.launch({headless:true,executablePath:process.env.INPX_CHROMIUM_PATH || undefined});
        const context = await browser.newContext({viewport:{width:1280,height:900}});
        await context.addInitScript(()=>{
            localStorage.setItem('vuex',JSON.stringify({settings:{catalogAppearance:'shelves',autoLoadBookReviews:false,autoLoadAuthorInfo:false}}));
        });
        page=await context.newPage(); const errors=[],requests=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.text().includes('Failed to resolve component'))errors.push(message.text());});
        await page.routeWebSocket('**/ws',socket=>{
            const server=socket.connectToServer();
            socket.onMessage(message=>{
                let request;try {request=JSON.parse(String(message));} catch (_) {server.send(message);return;}
                if(request.action!=='get-book-reviews') {server.send(message);return;}
                assert.equal(request.wantProgress,true);
                socket.send(JSON.stringify({requestId:request.requestId,_rok:1}));
                requests.push({request,progress:steps=>socket.send(JSON.stringify({requestId:request.requestId,_progress:true,progress:{steps}})),
                    finish:value=>socket.send(JSON.stringify({requestId:request.requestId,...value}))});
            });
            server.onMessage(message=>socket.send(message));
        });
        const requested=async count=>{for(let i=0;i<80 && requests.length<count;i++)await pause(100);assert.equal(requests.length,count);return requests[count-1];};
        const open=async uid=>{
            await page.evaluate(uid=>{location.hash='/book?bookUid='+encodeURIComponent(uid);},uid);
            await page.locator('.catalog-book-details').waitFor();
            await page.getByRole('tab',{name:'Отзывы и оценки',exact:true}).click();
        };
        await page.goto(base+'/#/book?bookUid='+encodeURIComponent(books[0]._uid));
        await page.locator('.catalog-book-details').waitFor();
        await page.getByRole('tab',{name:'Отзывы и оценки',exact:true}).click();
        const first=await requested(1), area=page.locator('.reviews-block');
        assert.equal(await area.locator('.loading-state__percent').count(),0,'No denominator means no percentage');
        first.progress([{id:'reviews',phase:'Проверка архивов отзывов',done:1,total:4,unit:'archives'},
            {id:'ratings',phase:'Получение оценок с удалённого сервера',done:5,total:null,unit:'reviews'}]);
        await area.getByText('25%',{exact:true}).waitFor();
        assert.equal(await area.locator('.loading-state').count(),2);
        assert.equal(await area.locator('.loading-state').nth(1).locator('.loading-state__percent').count(),0);
        await pause(450); assert.equal(await area.locator('.loading-state__percent').innerText(),'25%','Time alone must not advance work');
        await page.screenshot({path:path.join(directory,'reviews-known-and-unknown.png')});
        await open(books[1]._uid); const second=await requested(2);
        first.progress([{id:'reviews',phase:'Obsolete progress',done:99,total:100}]); first.finish({reviews:[{text:'Obsolete review'}]});
        await pause(150); assert.equal(await page.getByText('Obsolete progress',{exact:true}).count(),0); assert.equal(await page.getByText('Obsolete review',{exact:true}).count(),0);
        second.progress([{id:'reviews',phase:'Чтение отзывов книги',done:2,total:4,unit:'files'},
            {id:'ratings',phase:'Чтение файла оценок',done:1024,total:4096,unit:'bytes'}]);
        await area.getByText('50%',{exact:true}).waitFor(); await area.getByText('25%',{exact:true}).waitFor();
        await page.setViewportSize({width:390,height:844});
        assert(await area.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
        await page.screenshot({path:path.join(directory,'reviews-mobile-two-stages.png'),fullPage:true});
        second.finish({error:'fixture offline'});
        await area.getByRole('alert').filter({hasText:'fixture offline'}).waitFor();
        assert.equal(await area.locator('.loading-state').count(),0);
        await area.getByRole('button',{name:'Повторить',exact:true}).click();
        const retry=await requested(3);
        retry.finish({reviews:[{name:'Reader',text:'Отзыв после повтора'}],libraryRating:{value:4.5,count:2}});
        await area.getByText('Отзыв после повтора',{exact:true}).waitFor();
        assert.equal(await area.locator('.loading-state').count(),0,'Old servers may send only the final reply');
        await page.screenshot({path:path.join(directory,'reviews-retry-result.png')});
        assert.deepEqual(errors,[]);
        await fs.writeJson(path.join(directory,'result.json'),{requests:requests.length,knownPercent:25,unknownPercent:null,
            parallelPercents:[50,25],lateFramesIgnored:true,retryAndOldServer:true,errors},{spaces:2});
        console.log(`Review progress browser: actual compiled UI, two named stages, unknown totals, late frames, failure and retry passed. Artifacts: ${directory}`);
    } catch(error) {
        if(page)await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});
        console.error(`Artifacts: ${directory}\n${output}`);throw error;
    } finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
