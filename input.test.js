import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

// Exercise the real browser input code without a browser or simulated hardware.
function inputHarness() {
  const elements = new Map();
  const element = () => ({ value: '', classList: { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, toggle(name,force) { const on=force===undefined?!this.values.has(name):force; if(on)this.values.add(name);else this.values.delete(name); }, contains(name) { return this.values.has(name); } }, style: {}, dataset: {}, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {}, focus() {}, setSelectionRange(start,end) { this.selectionStart=start;this.selectionEnd=end; }, showModal() { this.open = true; }, close() { this.open = false; }, setPointerCapture() {}, getBoundingClientRect: () => ({left:0,top:0}), getContext: () => ({ measureText: text => ({ width: text.length * 14 }) }), matches: () => false });
  const document = { body: element(), getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, querySelectorAll: () => [], activeElement: null };
  const context = vm.createContext({ document, window: { addEventListener() {} }, location: { search: '?board=' + 'a'.repeat(32) }, localStorage: { getItem() {}, setItem() {} }, crypto: webcrypto, URLSearchParams, innerWidth: 1200, innerHeight: 800, EventSource: class { addEventListener() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, console });
  vm.runInContext(readFileSync(new URL('./public/model.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('./public/vocab-pen.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext('restoringCache = false; pauseImport = async () => {};', context);
  return code => vm.runInContext(code, context);
}
const event = (overrides = '') => `({pointerId:1,pointerType:'pen',clientX:600,clientY:400,pressure:.5,buttons:1,button:0,timeStamp:100,preventDefault(){},${overrides}})`;

test('the original StrokeCanvas class is copied word for word from vocab.html', () => {
  const source = readFileSync(new URL('./vocab.html', import.meta.url), 'utf8');
  const start = source.indexOf('class StrokeCanvas {');
  const original = source.slice(start, source.indexOf('\n\nfunction toolbarHTML', start));
  const restored = readFileSync(new URL('./public/vocab-pen.js', import.meta.url), 'utf8');
  assert.equal(restored.slice(restored.indexOf('class StrokeCanvas {')).trimEnd(), original);
});

test('pen input uses the unchanged original methods with no new stream handoff', () => {
  const run = inputHarness();
  assert.equal(run('penEngine._down === StrokeCanvas.prototype._down'), true);
  assert.equal(run('penEngine._move === StrokeCanvas.prototype._move'), true);
  assert.equal(run('penEngine._up === StrokeCanvas.prototype._up'), true);
  run(`down(${event("fromStylusTouch:true,pointerId:'stylus-1'")}); move(${event('timeStamp:200,clientX:630')});`);
  assert.equal(run('active.id'), 'stylus-1');
  assert.equal(run('active.stroke.points.length'), 1);
});

test('palm touches never create ink; a short pen stroke retains its lift coordinate', () => {
  const run = inputHarness();
  run(`down(${event("pointerType:'touch'")})`);
  assert.equal(run('active'), null);
  run(`down(${event()})`);
  run(`up(${event('clientX:620,timeStamp:110,pressure:0,buttons:0')})`);
  assert.equal(run('pending.length'), 1);
  assert.equal(run('pending[0].stroke.points.length'), 2);
  assert.equal(run('pending[0].stroke.points[1][0]'), 20);
});

test('preferred Apple Pencil touch stream replaces provisional pointer ink', () => {
  const run = inputHarness();
  run(`down(${event()})`);
  run(`down(${event("fromStylusTouch:true,pointerId:'stylus-1',timeStamp:105")})`);
  assert.equal(run('active.source'), 'stylus-touch');
  assert.equal(run('pending.length'), 0);
  run(`down(${event('timeStamp:110')})`);
  assert.equal(run('active.id'), 'stylus-1');
  run(`up(${event("fromStylusTouch:true,pointerId:'stylus-1',timeStamp:120")})`);
  assert.equal(run('pending.length'), 1);
});

test('missing pen-down and reused pointer IDs preserve fast handwriting', () => {
  const run = inputHarness();
  run(`move(${event()})`);
  assert.equal(run('active.stroke.points.length'), 1);
  run(`down(${event('timeStamp:200,clientX:630')})`);
  assert.equal(run('pending.length'), 1);
  run(`up(${event('timeStamp:210,clientX:640')})`);
  assert.equal(run('pending.length'), 2);
  assert.notEqual(run('pending[0].stroke.id'), run('pending[1].stroke.id'));
});

test('undo only removes its recorded stroke and redo restores it', () => {
  const run = inputHarness();
  run(`down(${event()}); up(${event()});`);
  const id = run('pending[0].stroke.id');
  run(`state.strokes.remote = { id:'remote',color:'#263b36',width:3,points:[[1,2,.5]] }; historyAction(undoStack,redoStack,true);`);
  assert.equal(run(`Boolean(view().strokes['${id}'])`), false);
  assert.equal(run('Boolean(view().strokes.remote)'), true);
  run('historyAction(redoStack,undoStack,false)');
  assert.equal(run(`Boolean(view().strokes['${id}'])`), true);
});

test('auto-fit includes live ink when it fits above the readability threshold', () => {
  const run = inputHarness();
  run(`innerWidth=390; innerHeight=700; autoFit=true;
    state.strokes.local={id:'local',color:'#263b36',width:3,points:[[-120,-220,.5]]};
    remote.set('live',{stroke:{id:'live',color:'#263b36',width:6,points:[[520,520,.8]]}});
    updateAutoFit();`);
  assert.ok(run('camera.z') >= .425 && run('camera.z') < 1);
  assert.ok(run('-123*camera.z+camera.x') >= 80 - 1e-7);
  assert.ok(run('526*camera.z+camera.x') <= 360 + 1e-7);
  assert.ok(run('-223*camera.z+camera.y') >= 110 - 1e-7);
  assert.ok(run('526*camera.z+camera.y') <= 580 + 1e-7);
});

test('auto-fit stays put when fitting the page would require less than 42.5 percent', () => {
  const run = inputHarness();
  run(`camera={x:321,y:654,z:1}; state.strokes.wide={id:'wide',width:3,points:[[0,0,.5],[10000,5000,.5]]}; setAutoFit(true); updateAutoFit();`);
  assert.equal(run('JSON.stringify(camera)'), JSON.stringify({ x: 321, y: 654, z: 1 }));
  assert.equal(run('autoFit'), true);
  run(`state.strokes.wide.points=[[0,0,.5],[1000,500,.5]]; updateAutoFit();`);
  assert.ok(run('camera.z') >= .425);
});

test('auto-fit freezes during pen contact, resumes on lift, and manual zoom disables it', () => {
  const run = inputHarness();
  run(`autoFit=true; down(${event()}); remote.set('live',{stroke:{id:'live',color:'#263b36',width:3,points:[[900,900,.5]]}}); updateAutoFit();`);
  assert.equal(run('camera.z'), 1);
  run(`up(${event()}); updateAutoFit();`);
  assert.ok(run('camera.z') < 1);
  run('changeZoom(1)'); assert.equal(run('autoFit'), false);
});

test('editable board round-trips pressure and offscreen coordinates with fresh import IDs', () => {
  const run = inputHarness();
  run(`state.title='Saved drawing'; state.strokes.existing={id:'existing',color:'#6385b8',width:6,points:[[-5000,8000,.2],[9000,-4000,.9]]};
    globalThis.saved=JSON.stringify(boardDocument()); globalThis.loaded=readBoard(saved);`);
  assert.equal(run('loaded.title'), 'Saved drawing');
  assert.equal(run('JSON.stringify(loaded.pages[0].strokes[0].points)'), '[[-5000,8000,0.2],[9000,-4000,0.9]]');
  assert.notEqual(run('loaded.pages[0].strokes[0].id'), 'existing');
  run('importBoard(loaded)'); assert.equal(run('Object.keys(view().strokes).length'), 2);
  run('historyAction(undoStack,redoStack,true)'); assert.equal(run('Object.keys(view().strokes).length'), 1);
  assert.equal(run('Boolean(view().strokes.existing)'), true);
  run('historyAction(redoStack,undoStack,false)'); assert.equal(run('Object.keys(view().strokes).length'), 2);
});

test('board import rejects malformed ink before changing the shared board', () => {
  const run = inputHarness();
  for (const text of ['null', '{}', '{"format":"field-whiteboard","version":1,"strokes":[{"color":"<script>","width":3,"points":[[1,2,0.5]]}]}', '{"format":"field-whiteboard","version":1,"strokes":[{"color":"#263b36","width":3,"points":[[null,2,0.5]]}]}']) {
    assert.throws(() => run(`readBoard(${JSON.stringify(text)})`));
  }
  assert.equal(run('pending.length'), 0);
});

test('page switching isolates ink and fits the arriving page', () => {
  const run = inputHarness();
  run(`down(${event()}); up(${event()}); camera.x=333; addPage();`);
  assert.equal(run('view().pages.length'), 2);
  assert.equal(run('Object.keys(pageView().strokes).length'), 0);
  run(`down(${event('timeStamp:200')}); up(${event('timeStamp:210')}); navigatePage(-1);`);
  assert.equal(run('Object.keys(pageView().strokes).length'), 1);
  assert.equal(run('JSON.stringify(camera)'), run('JSON.stringify(fitCamera(Object.values(pageView().strokes)))'));
  assert.equal(run('boardDocument().pages.length'), 2);
  assert.equal(run('boardDocument().pages.every(p=>p.strokes.length===1)'), true);
});

test('colored multiline text can be saved, moved, exported and undone', () => {
  const run = inputHarness();
  run(`choose('text'); down(${event()}); $('text-content').value='Hello <world>\nSecond line'; $('text-color').value='#cc816e'; $('text-background').value='#edf3df'; $('text-save').onclick();` .replace("'Hello <world>\nSecond line'", "'Hello <world>\\nSecond line'"));
  assert.equal(run('Object.values(pageView().strokes)[0].kind'), 'text');
  assert.equal(run('Object.values(pageView().strokes)[0].color'), '#cc816e');
  run(`down(${event('timeStamp:200,clientX:615,clientY:415')}); move(${event('timeStamp:220,clientX:715,clientY:465')}); up(${event('timeStamp:230,clientX:715,clientY:465')});`);
  assert.equal(run('Object.values(pageView().strokes)[0].x'), 100);
  assert.equal(run('Object.values(pageView().strokes)[0].y'), 50);
  run('historyAction(undoStack,redoStack,true)');
  assert.equal(run('Object.values(pageView().strokes)[0].x'), 0);
  assert.equal(run('readBoard(JSON.stringify(boardDocument())).pages[0].strokes[0].text'), 'Hello <world>\nSecond line');
  assert.equal(run("escapeXML('<script>&')"), '&lt;script&gt;&amp;');
});

test('legacy imports stay on the active page; document import undo/redo restores pages and text', () => {
  const run = inputHarness();
  run(`importBoard(readBoard(JSON.stringify({format:'field-whiteboard',version:1,title:'Old board',strokes:[{id:'s1',color:'#263b36',width:3,points:[[1,2,.5]]}]})));`);
  assert.equal(run('view().pages.length'), 1);
  assert.equal(run('Object.keys(pageView().strokes).length'), 1);
  run(`addPage(); globalThis.copy=readBoard(JSON.stringify(boardDocument())); importBoard(copy);`);
  assert.equal(run('view().pages.length'), 4);
  run('historyAction(undoStack,redoStack,true)');
  assert.equal(run('view().pages.length'), 2);
  assert.equal(run('view().pages.some(p=>p.id===currentPageId)'), true);
  run('historyAction(redoStack,undoStack,false)');
  assert.equal(run('view().pages.length'), 4);
});

test('auto-follow tracks only the selected writer and retains zoom instead of fitting all ink', () => {
  const run = inputHarness();
  run(`online=true; connectedUsers=[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}]; camera.z=1.5; startFollowing('alice');
    noteWriter('bob',{pageId:'page-1',points:[[90000,90000,.5]]}); updateAutoFollow();`);
  assert.equal(run('followTarget'), null);
  assert.equal(run('camera.x'), 600);
  run(`noteWriter('alice',{pageId:'page-1',points:[[10000,5000,.5]]}); for(let i=0;i<80;i++)updateAutoFollow();`);
  assert.equal(run('camera.z'), 1.5);
  assert.ok(run('10000*camera.z+camera.x') > 110 && run('10000*camera.z+camera.x') < 1170);
  assert.ok(run('5000*camera.z+camera.y') > 152 && run('5000*camera.z+camera.y') < 690);
  assert.equal(run('autoFit'), false);
});

test('auto-follow keeps the camera still for writing inside its safe area', () => {
  const run = inputHarness();
  assert.equal(run('JSON.stringify(followDestination(camera,{x:0,y:0}))'), run('JSON.stringify(camera)'));
});

test('removing a page preserves others and undo restores its position, ink, and text', () => {
  const run = inputHarness();
  run(`enqueue({type:'page-add',page:{id:'middle',title:'Middle'}}); enqueue({type:'page-add',page:{id:'last',title:'Last'}});
    switchPage('middle'); down(${event()}); up(${event()});
    enqueue({type:'put',stroke:{id:'box',pageId:'middle',kind:'text',text:'Keep me',color:'#263b36',background:'transparent',fontSize:28,boxWidth:320,x:0,y:0}});
    removePage('middle');`);
  assert.equal(run("view().pages.map(p=>p.id).join(',')"), 'page-1,last');
  assert.equal(run('currentPageId'), 'last');
  assert.equal(run('Object.keys(view().strokes).length'), 0);
  run('historyAction(undoStack,redoStack,true)');
  assert.equal(run("view().pages.map(p=>p.id).join(',')"), 'page-1,middle,last');
  assert.equal(run('Object.keys(view().strokes).length'), 2);
  assert.equal(run('view().strokes.box.text'), 'Keep me');
  run('historyAction(redoStack,undoStack,false)');
  assert.equal(run("view().pages.map(p=>p.id).join(',')"), 'page-1,last');
  assert.equal(run('Object.keys(view().strokes).length'), 0);
});

test('the final remaining page cannot be removed', () => {
  const run = inputHarness();
  run("removePage('page-1')");
  assert.equal(run('view().pages.length'), 1);
  assert.equal(run('pending.length'), 0);
  assert.equal(run("model.validEdit(view(),{id:'remove',type:'page-remove',pageId:'page-1'})"), false);
});

test('text wraps whole words, preserves newlines, and only breaks oversized words', () => {
  const run = inputHarness();
  assert.equal(run("JSON.stringify(textLayout({text:'hello world again',fontSize:28,boxWidth:178}).lines)"), '["hello world","again"]');
  assert.equal(run("JSON.stringify(textLayout({text:'hello world',fontSize:28,boxWidth:164}).lines)"), '["hello","world"]');
  assert.equal(run("JSON.stringify(textLayout({text:'abcdefghijklmno',fontSize:28,boxWidth:164}).lines)"), '["abcdefghij","klmno"]');
  assert.equal(run("JSON.stringify(textLayout({text:'one\\n\\ntwo',fontSize:28,boxWidth:164}).lines)"), '["one","","two"]');
});

test('selected words support combined bold and italic through editing and document round-trip', () => {
  const run = inputHarness();
  run(`choose('text'); down(${event()}); $('text-content').value='hello world'; $('text-content').oninput(); $('text-content').setSelectionRange(6,11); toggleTextStyle('bold'); toggleTextStyle('italic');`);
  assert.equal(run('editingText.formats[0].start'), 6);
  assert.equal(run('editingText.formats[0].bold && editingText.formats[0].italic'), true);
  run("$('text-content').value='Say hello world'; $('text-content').oninput();");
  assert.equal(run('editingText.formats[0].start'), 10);
  run("$('text-save').onclick(); globalThis.item=Object.values(pageView().strokes)[0];");
  assert.equal(run('model.validItem(item)'), true);
  assert.equal(run('textLayout(item).runLines.flat().some(r=>r.text===\'world\'&&r.bold&&r.italic)'), true);
  assert.equal(run('JSON.stringify(readBoard(JSON.stringify(boardDocument())).pages[0].strokes[0].formats)'), run('JSON.stringify(item.formats)'));
  run("openText(item); $('text-content').setSelectionRange(10,15); toggleTextStyle('bold');");
  assert.equal(run('editingText.formats[0].bold'), false);
  assert.equal(run('editingText.formats[0].italic'), true);
});

test('invalid formatting ranges are rejected', () => {
  const run = inputHarness();
  run(`globalThis.box={id:'box',kind:'text',text:'word',color:'#263b36',background:'transparent',fontSize:28,boxWidth:320,x:0,y:0};`);
  assert.equal(run('model.validItem({...box,formats:[{start:0,end:5,bold:true}]})'), false);
  assert.equal(run('model.validItem({...box,formats:[{start:-1,end:2,italic:true}]})'), false);
  assert.equal(run('model.validItem({...box,formats:[{start:0,end:4,bold:true}]})'), true);
});

test('images move, resize with aspect ratio, undo, and survive document round-trip', () => {
  const run = inputHarness();
  run(`globalThis.photo={id:'photo',pageId:'page-1',kind:'image',color:'#263b36',data:'data:image/png;base64,AAAA',x:0,y:0,imageWidth:200,imageHeight:100}; enqueue({type:'put',stroke:photo}); choose('select'); down(${event('clientX:620,clientY:420')}); move(${event('timeStamp:120,clientX:670,clientY:450')}); up(${event('timeStamp:130,clientX:670,clientY:450')});`);
  assert.equal(run('view().strokes.photo.x'), 50);
  assert.equal(run('view().strokes.photo.y'), 30);
  run("openImage(view().strokes.photo); $('image-width').value='400'; $('image-save').onclick();");
  assert.equal(run('view().strokes.photo.imageHeight'), 200);
  run('historyAction(undoStack,redoStack,true)');
  assert.equal(run('view().strokes.photo.imageHeight'), 100);
  assert.equal(run('readBoard(JSON.stringify(boardDocument())).pages[0].strokes[0].data'), 'data:image/png;base64,AAAA');
  assert.equal(run("model.validItem({...photo,data:'https://example.com/image.png'})"), false);
});

test('background changes apply to one page and support undo and export', () => {
  const run = inputHarness();
  run("addPage(); $('page-background').value='#234567'; $('page-background').onchange();");
  assert.equal(run('pageBackground()'), '#234567');
  assert.equal(run('boardDocument().pages[1].background'), '#234567');
  run('historyAction(undoStack,redoStack,true)');
  assert.equal(run('pageBackground()'), '#f8f9f6');
  run('historyAction(redoStack,undoStack,false); navigatePage(-1)');
  assert.equal(run('pageBackground()'), '#f8f9f6');
});

test('compact mode independently hides chosen menus and reveals them with its arrow', () => {
  const run = inputHarness();
  run("compactMode=true; compactMenus={header:true,pages:false,palette:true,bottom:false,hints:true}; updateCompactMode();");
  assert.equal(run("document.body.classList.contains('hide-header')"), true);
  assert.equal(run("document.body.classList.contains('hide-pages')"), false);
  assert.equal(run("document.body.classList.contains('hide-palette')"), true);
  run("$('reveal-controls').onclick()");
  assert.equal(run("document.body.classList.contains('hide-header')"), false);
  assert.equal(run("document.body.classList.contains('hide-palette')"), false);
});

test('follow pointer, page, and both modes respond separately to idle pointer/page activity', () => {
  const run = inputHarness();
  run("enqueue({type:'page-add',page:{id:'second',title:'Second'}}); online=true; connectedUsers=[{id:'alice',name:'Alice'}]; startFollowing('alice'); followMode='pointer'; receiveActivity({clientId:'alice',pageId:'second',x:10000,y:20000}); updateAutoFollow();");
  assert.equal(run('currentPageId'), 'page-1'); assert.equal(run('camera.x'), 600);
  run("followMode='slide'; receiveActivity({clientId:'alice',pageId:'second',x:null,y:null}); updateAutoFollow();");
  assert.equal(run('currentPageId'), 'second'); assert.equal(run('camera.x'), 600);
  run("receiveActivity({clientId:'alice',pageId:'second',x:10000,y:20000}); updateAutoFollow();");
  assert.equal(run('camera.x'), 600);
  run("followMode='both'; for(let i=0;i<80;i++)updateAutoFollow();");
  assert.ok(run('camera.x') < 0); assert.equal(run('camera.z'), 1);
});

test('following switches pages, pauses under the local pen, and manual navigation stops it', () => {
  const run = inputHarness();
  run(`enqueue({type:'page-add',page:{id:'second',title:'Second'}}); online=true; connectedUsers=[{id:'alice',name:'Alice'}]; startFollowing('alice');
    down(${event()}); noteWriter('alice',{pageId:'second',points:[[9000,1000,.5]]}); updateAutoFollow();`);
  assert.equal(run('currentPageId'), 'page-1');
  assert.equal(run('camera.x'), 600);
  run(`online=false; up(${event()}); online=true; updateAutoFollow();`);
  assert.equal(run('currentPageId'), 'second');
  assert.equal(run('camera.z'), 1);
  run("switchPage('page-1')"); assert.equal(run('followedId'), null);
  run("startFollowing('alice'); changeZoom(2)"); assert.equal(run('followedId'), null);
  run("startFollowing('alice'); setAutoFit(true)"); assert.equal(run('followedId'), null);
});

test('imports finish each slide before uploading the next slide', async () => {
  const run = inputHarness();
  run(`
    importBoard({title:'Shared presentation',legacy:false,pages:[
      {id:'import-a',title:'First',strokes:[{id:'photo-a',kind:'image',color:'#000000',x:0,y:0,imageWidth:100,imageHeight:100,data:'data:image/png;base64,AAAA'}]},
      {id:'import-b',title:'Second',strokes:[{id:'text-b',kind:'text',text:'Shared text',color:'#000000',background:'transparent',x:0,y:0,fontSize:24,boxWidth:200}]}
    ]});
    var uploaded=[];
    post=async(route,value)=>{if(route==='edit')uploaded.push(value);return {revision:uploaded.length};};
    online=true;
  `);
  await run('pump()');
  assert.equal(run('uploaded.length'), 2);
  assert.equal(run('pending.length'), 5, 'optimistic objects remain until SSE confirmation');
  assert.equal(run('uploaded.filter(op=>op.type==="put").length'), 1);
  await run('pump()');
  assert.equal(run('uploaded.length'), 2, 'next slide waits until this slide is received');
  run('pending = pending.filter(op => !submittedEdits.has(op.id));');
  await run('pump()');
  assert.equal(run('uploaded.length'), 5);
});

test('page navigation broadcasts immediately without any edit or pointer movement', async () => {
  const run = inputHarness();
  run(`state.pages.push({id:'next-page',title:'Next'});var activityPosts=[];post=async(route,value)=>{activityPosts.push({route,...value});return {};};online=true;switchPage('next-page');`);
  assert.ok(run('activityPosts.length') >= 1);
  assert.equal(run('activityPosts.at(-1).route'), 'activity');
  assert.equal(run('activityPosts.at(-1).pageId'), 'next-page');
  assert.equal(run('pending.length'), 0);
});

test('delayed imported objects cannot override explicit slide-follow activity', () => {
  const run = inputHarness();
  run(`state.pages.push({id:'chosen',title:'Chosen'},{id:'imported',title:'Imported'});online=true;connectedUsers=[{id:'presenter',name:'Presenter'}];startFollowing('presenter');followMode='slide';
    receiveActivity({clientId:'presenter',pageId:'chosen',x:null,y:null});
    noteWriter('presenter',{kind:'image',pageId:'imported',x:0,y:0,imageWidth:100,imageHeight:100});updateAutoFollow();`);
  assert.equal(run('currentPageId'), 'chosen');
});

test('large browser backups use the asynchronous cache and retire localStorage only after success', async () => {
  const run = inputHarness(); await run('Promise.resolve()');
  run(`var cacheTask, savedBackup, removedKey;setTimeout=callback=>{cacheTask=callback;};
    globalThis.FieldCache={write:async(key,value)=>{savedBackup=value;}};
    localStorage.setItem=()=>{throw Error('localStorage quota exceeded');};
    localStorage.removeItem=key=>{removedKey=key;};
    state.strokes.large={id:'large',kind:'image',data:'x'.repeat(6000000)};cache();`);
  await run('cacheTask()');
  assert.equal(run('savedBackup.state.strokes.large.data.length'), 6000000);
  assert.equal(run('removedKey'), run('storageKey'));
  assert.equal(run('storageFailed'), false);
  run(`removedKey=null;FieldCache.write=async()=>{throw Error('quota');};pending=[{id:'unsaved'}];cache();`);
  await run('cacheTask()');
  assert.equal(run('removedKey'), null, 'failed migration keeps the original backup');
  assert.equal(run('pending.length'), 1);
  assert.equal(run('storageFailed'), true);
});

test('late cache recovery preserves current host state and merges only unsent local edits', async () => {
  const run = inputHarness(); await run('Promise.resolve()');
  run(`online=true;state.revision=10;state.title='Host title';state.receipts=['saved'];
    pending=[{id:'new',type:'title',title:'New title'}];receivedEdits.add('echoed');
    globalThis.FieldCache={read:async()=>({state:{title:'Old cache',revision:1,pages:[],strokes:{}},pending:[{id:'saved'},{id:'echoed'},{id:'new'},{id:'offline',type:'title',title:'Offline edit'}]})};
    pump=()=>{};`);
  await run('restoreCache()');
  assert.equal(run('state.title'), 'Host title');
  assert.equal(run('pending.map(op=>op.id).join(",")'), 'offline,new');
});

test('follow starts panning at 62.5 percent when fitting would require more zoom-out', () => {
  const run = inputHarness();
  run(`state.strokes.wide={id:'wide',width:3,points:[[0,0,.5],[1800,700,.5]]};
    online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');
    noteWriter('alice',{points:[[1800,700,.5]]});for(let i=0;i<120;i++)updateAutoFollow();`);
  assert.ok(Math.abs(run('camera.z') - .625) < .001);
  assert.ok(run('1800*camera.z+camera.x') > 300);
  assert.ok(run('1800*camera.z+camera.x') < 980);
});

test('follow stops shrinking at a readable scale and follows distant writing', () => {
  const run = inputHarness();
  run(`state.strokes.wide={id:'wide',width:3,points:[[0,0,.5],[10000,5000,.5]]};
    online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');
    noteWriter('alice',{points:[[10000,5000,.5]]});for(let i=0;i<150;i++)updateAutoFollow();`);
  assert.ok(Math.abs(run('camera.z') - .625) < .001);
  assert.ok(run('10000*camera.z+camera.x') > 110 && run('10000*camera.z+camera.x') < 1170);
  assert.ok(run('camera.x') < 0, 'older distant content may be clipped');
});

test('page-only following preserves zoom despite large content', () => {
  const run = inputHarness();
  run(`state.strokes.wide={id:'wide',width:3,points:[[0,0,.5],[10000,5000,.5]]};
    online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');followMode='slide';
    noteWriter('alice',{points:[[10000,5000,.5]]});updateAutoFollow();`);
  assert.equal(run('camera.z'), 1);
});

test('page-only follow and auto-fit coexist regardless of which is enabled first', () => {
  const run = inputHarness();
  run(`online=true;connectedUsers=[{id:'alice',name:'Alice'}];followMode='slide';setAutoFit(true);startFollowing('alice');`);
  assert.equal(run('autoFit'), true);
  run(`setAutoFit(false);setAutoFit(true);`);
  assert.equal(run('followedId'), 'alice');
  run(`state.pages.push({id:'next',title:'Next'});state.strokes.wide={id:'wide',pageId:'next',width:3,points:[[0,0,.5],[10000,5000,.5]]};
    receiveActivity({clientId:'alice',pageId:'next',x:null,y:null});updateAutoFollow();updateAutoFit();`);
  assert.equal(run('currentPageId'), 'next');
  assert.equal(run('followedId'), 'alice');
  assert.ok(run('camera.z') < .2);
  run(`$('follow-mode').value='both';$('follow-mode').onchange();`);
  assert.equal(run('autoFit'), false);
  assert.equal(run('followedId'), 'alice');
  run('setAutoFit(true)');
  assert.equal(run('followedId'), null);
});

test('follow pans at 62.5 percent, then enlarges smaller content again', () => {
  const run = inputHarness();
  run(`online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');
    state.strokes.s={id:'s',width:3,points:[[0,0,.5],[2800,500,.5]]};
    noteWriter('alice',{points:[[2800,500,.5]]});for(let i=0;i<150;i++)updateAutoFollow();`);
  assert.ok(Math.abs(run('camera.z') - .625) < .001);
  run(`state.strokes.s.points=[[0,0,.5],[200,100,.5]];noteWriter('alice',{points:[[200,100,.5]]});for(let i=0;i<200;i++)updateAutoFollow();`);
  assert.ok(run('camera.z') > 4);
  assert.ok(run('203*camera.z+camera.x') <= 1170);
});

test('auto-fit zooms in again and uses the full supported zoom range', () => {
  const run = inputHarness();
  run(`camera.z=.1;state.strokes.s={id:'s',width:3,points:[[0,0,.5],[200,100,.5]]};setAutoFit(true);updateAutoFit();`);
  assert.ok(run('camera.z') > 4);
  run(`state.strokes.s.points=[[0,0,.5],[10,10,.5]];updateAutoFit();`);
  assert.equal(run('camera.z'), 8);
});

test('follow zoom overrides framing and auto-fit, including page-only activity', () => {
  const run = inputHarness();
  run(`online=true;connectedUsers=[{id:'alice',name:'Alice'}];followMode='slide';setAutoFit(true);startFollowing('alice');
    $('follow-zoom').checked=true;$('follow-zoom').onchange();
    receiveActivity({clientId:'alice',pageId:'page-1',x:null,y:null,zoom:.07});updateAutoFollow();`);
  assert.equal(run('autoFit'), false);
  assert.equal(run('camera.z'), .07);
  run(`followMode='both';state.strokes.s={id:'s',width:3,points:[[0,0,.5],[10000,5000,.5]]};
    receiveActivity({clientId:'alice',pageId:'page-1',x:10000,y:5000,zoom:4});for(let i=0;i<80;i++)updateAutoFollow();`);
  assert.equal(run('camera.z'), 4);
  run(`$('follow-zoom').checked=false;$('follow-zoom').onchange();for(let i=0;i<100;i++)updateAutoFollow();`);
  assert.ok(Math.abs(run('camera.z') - .625) < .001);
});

test('zoom changes broadcast without pointer movement or edits', async () => {
  const run = inputHarness();
  run(`online=true;activityDirty=false;lastSentZoom=1;camera.z=2;var sentZoom;post=async(route,data)=>{sentZoom=data;};`);
  await run('flushActivity()');
  assert.equal(run('sentZoom.zoom'), 2);
  assert.equal(run('pending.length'), 0);
});

test('focus appears for presenters and animates only a selected follower to their point and zoom', () => {
  const run = inputHarness();
  run(`followers.set('viewer',false);updateFocusControl();var focused;post=async(route,data)=>{focused={route,...data};return {};};$('focus').onclick();down(${event('clientX:700,clientY:500')});down(${event("fromStylusTouch:true,pointerId:'stylus-focus'")});move(${event("fromStylusTouch:true,pointerId:'stylus-focus',clientX:730")});`);
  assert.equal(run("$('focus').hidden"), false);
  assert.equal(run('focusMode'), false);
  assert.equal(run('focused.route'), 'focus');
  assert.equal(run('focused.x'), 100);
  assert.equal(run('focused.y'), 100);
  assert.equal(run('active'), null);
  assert.equal(run('pending.length'), 0);
  run(`online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');camera={x:0,y:0,z:1};receiveFocus({clientId:'alice',pageId:'page-1',x:400,y:200,zoom:2});var started=focusAnimation.started;stepFocusAnimation(started+225);`);
  assert.equal(run('followedId'), 'alice');
  assert.ok(run('camera.z') > 1 && run('camera.z') < 2);
  run('stepFocusAnimation(started+450)');
  assert.equal(run('camera.z'), 2);
  assert.equal(run('400*camera.z+camera.x'), 640);
  assert.equal(run('200*camera.z+camera.y'), 416);
  run(`focusAnimation=null;camera={x:12,y:34,z:1};receiveFocus({clientId:'bob',pageId:'page-1',x:0,y:0,zoom:4});`);
  assert.equal(run('focusAnimation'), null);
  assert.equal(run('camera.z'), 1);
});

test('re-zoom appears only for followers without persistent zoom and animates their current view', () => {
  const run = inputHarness();
  run(`followers.set('viewer',false);updateFocusControl();var requested;post=async(route,data)=>{requested={route,...data};return {};};camera={x:40,y:80,z:1.5};$('re-zoom').onclick();`);
  assert.equal(run("$('re-zoom').hidden"), false);
  assert.equal(run('requested.route'), 'rezoom');
  assert.equal(run('requested.zoom'), 1.5);
  run(`followers.set('zoom-viewer',true);updateFocusControl();`);
  assert.equal(run("$('re-zoom').hidden"), true);
  run(`followers.delete('zoom-viewer');online=true;connectedUsers=[{id:'alice',name:'Alice'}];startFollowing('alice');camera={x:20,y:40,z:1};receiveReZoom({clientId:'alice',zoom:3});var started=focusAnimation.started;stepFocusAnimation(started+450);`);
  assert.equal(run('camera.z'), 3);
  assert.equal(run('(innerWidth/2-camera.x)/camera.z'), 580);
  assert.equal(run('(innerHeight/2-camera.y)/camera.z'), 360);
  assert.equal(run('followedId'), 'alice');
  run(`focusAnimation=null;camera={x:1,y:2,z:1};receiveReZoom({clientId:'bob',zoom:4});`);
  assert.equal(run('focusAnimation'), null);
});

test('arrival fits once without changing follow or auto-fit settings', () => {
  const run = inputHarness();
  run(`state.pages.push({id:'next',title:'Next'});state.strokes.s={id:'s',pageId:'next',width:3,points:[[1000,2000,.5],[3000,3000,.5]]};
    online=true;connectedUsers=[{id:'alice',name:'Alice'}];followMode='slide';startFollowing('alice');
    receiveActivity({clientId:'alice',pageId:'next',x:null,y:null});updateAutoFollow();`);
  assert.equal(run('JSON.stringify(camera)'), run('JSON.stringify(fitCamera(Object.values(pageView().strokes)))'));
  assert.equal(run('followedId'), 'alice');
  assert.equal(run('autoFit'), false);
  run(`var arrival=JSON.stringify(camera);state.strokes.s.points.push([90000,90000,.5]);updateAutoFollow();updateAutoFit();`);
  assert.equal(run('JSON.stringify(camera)'), run('arrival'), 'arrival fitting is not continuous');
  run(`setAutoFit(true);switchPage('page-1',true);`);
  assert.equal(run('autoFit'), true, 'an explicitly enabled auto-fit remains enabled');
  assert.equal(run('followedId'), 'alice');
  assert.equal(run('camera.z'), 1);
});
