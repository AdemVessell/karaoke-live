const {app,BrowserWindow,session,Menu,shell}=require('electron');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {homedir}=require('node:os');
const {connectObs}=require('./lib/obs-connector.cjs');
const PORT=4318,ORIGIN=`http://127.0.0.1:${PORT}`,SCENE='Karaoke Live',SCREEN='Karaoke Stage',AUDIO='Karaoke App Audio',BUNDLE='org.stevenson.karaoke-live';
app.setName('Karaoke Live');app.setPath('userData',process.env.KARAOKE_USER_DATA_DIR ? path.resolve(process.env.KARAOKE_USER_DATA_DIR) : path.join(app.getPath('appData'),'Karaoke Live'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let stage,control,server,ownedRecording=false,previousRecordDirectory=null,quitting=false,quitReady=false;
const ownOrigin=url=>{try{return new URL(url).origin===ORIGIN;}catch{return false;}};
async function obsConnection(){return connectObs();}
async function obsStatus(o){const [r,s,c]=await Promise.all([o.request('GetRecordStatus'),o.request('GetStreamStatus'),o.request('GetCurrentProgramScene')]);return {connected:true,recording:r.outputActive,streaming:s.outputActive,scene:c.currentProgramSceneName,correctScene:c.currentProgramSceneName===SCENE,recordTimecode:r.outputTimecode};}
async function ensureInput(o,inputName,inputKind,inputSettings){const list=await o.request('GetInputList');if(!list.inputs.some(i=>i.inputName===inputName))await o.request('CreateInput',{sceneName:SCENE,inputName,inputKind,inputSettings,sceneItemEnabled:true});else{await o.request('SetInputSettings',{inputName,inputSettings,overlay:true});const items=await o.request('GetSceneItemList',{sceneName:SCENE});if(!items.sceneItems.some(i=>i.sourceName===inputName))await o.request('CreateSceneItem',{sceneName:SCENE,sourceName:inputName,sceneItemEnabled:true});}}
async function setupObs(o){
 const s=await obsStatus(o);if(s.recording||s.streaming)throw Error('Stop the current OBS recording or stream before setting up karaoke.');
 const scenes=await o.request('GetSceneList');if(!scenes.scenes.some(x=>x.sceneName===SCENE))await o.request('CreateScene',{sceneName:SCENE});
 await ensureInput(o,SCREEN,'screen_capture',{type:1,show_cursor:false,show_empty_names:false,show_hidden_windows:true});
 const windows=await o.request('GetInputPropertiesListPropertyItems',{inputName:SCREEN,propertyName:'window'});
 const match=windows.propertyItems.find(x=>x.itemEnabled!==false&&String(x.itemName).includes('Karaoke Live — Stage'));
 if(!match)throw Error('OBS cannot see the Karaoke Stage window yet. Keep Stage open and allow OBS Screen Recording access, then retry.');
 await o.request('SetInputSettings',{inputName:SCREEN,inputSettings:{type:1,window:match.itemValue,show_cursor:false,show_hidden_windows:true},overlay:true});
 // Window capture includes Electron's helper-process audio; bundle-only application capture was silent.
 await o.request('SetInputMute',{inputName:SCREEN,inputMuted:false});
 await o.request('SetInputVolume',{inputName:SCREEN,inputVolumeDb:0});
 await o.request('SetInputAudioMonitorType',{inputName:SCREEN,monitorType:'OBS_MONITORING_TYPE_NONE'});
 await o.request('SetInputAudioTracks',{inputName:SCREEN,inputAudioTracks:{'1':true,'2':false,'3':false,'4':false,'5':false,'6':false}});
 const filters=await o.request('GetSourceFilterList',{sourceName:SCREEN});if(!filters.filters.some(f=>f.filterName==='Karaoke peak safety'))await o.request('CreateSourceFilter',{sourceName:SCREEN,filterName:'Karaoke peak safety',filterKind:'limiter_filter',filterSettings:{threshold:-1,release_time:60}});
 const oldInputs=await o.request('GetInputList');if(oldInputs.inputs.some(i=>i.inputName===AUDIO))await o.request('SetInputMute',{inputName:AUDIO,inputMuted:true});
 const globals=await o.request('GetSpecialInputs');for(const name of Object.values(globals).filter(Boolean)){const m=await o.request('GetInputMute',{inputName:name});if(!m.inputMuted)throw Error(`OBS global audio “${name}” is active. Mute it before karaoke to avoid doubled sound.`);}
 const video=await o.request('GetVideoSettings');const item=await o.request('GetSceneItemId',{sceneName:SCENE,sourceName:SCREEN});
 await o.request('SetSceneItemTransform',{sceneName:SCENE,sceneItemId:item.sceneItemId,sceneItemTransform:{positionX:0,positionY:0,boundsType:'OBS_BOUNDS_SCALE_INNER',boundsWidth:video.baseWidth,boundsHeight:video.baseHeight,boundsAlignment:0,alignment:5}});
 await o.request('SetCurrentProgramScene',{sceneName:SCENE});
 return {...await obsStatus(o),message:'Karaoke Stage and app audio connected. OBS monitoring stays off to avoid echo.'};
}
async function api(route,body){
 if(route==='/api/stage/command'){
  const {SUPPORTED_STAGE_COMMANDS:allowed}=require('./lib/stage-commands.cjs');
  if(!allowed.has(body.command))throw Error('Unknown stage command.');
  if(body.command==='load'&&!/^[A-Za-z0-9_-]{11}$/.test(body.payload?.videoId||''))throw Error('Invalid YouTube video.');
  if(!stage||stage.isDestroyed())throw Error('Open the Stage window first.');
  await stage.webContents.executeJavaScript('window.__karaoke.execute('+JSON.stringify(body.command)+','+JSON.stringify(body.payload||{})+')',true);
  return {ok:true,status:await stage.webContents.executeJavaScript('window.__karaoke.getStatus()')};
 }
 if(route==='/api/app/show-stage'){stage.show();stage.focus();return {ok:true};}
 if(route==='/api/app/show-controls'){control.show();control.focus();return {ok:true};}
 if(route==='/api/app/status'){const stageOpen=!!stage&&!stage.isDestroyed();const stageStatus=stageOpen?await stage.webContents.executeJavaScript('({status:window.__karaoke?.getStatus?.()||null,actualTracks:Array.from(document.getElementById("camera")?.srcObject?.getTracks?.()||[]).map(t=>({kind:t.kind,readyState:t.readyState,enabled:t.enabled}))})'):null;return {app:'Karaoke Live',stageOpen,sampleRate:48000,stageStatus,selectedVideo:control&&!control.isDestroyed()?await control.webContents.executeJavaScript('document.getElementById("youtubeUrl")?.value||""'):''};}
 const o=await obsConnection();try{
  if(route==='/api/obs/status')return await obsStatus(o);
  if(route==='/api/obs/setup')return await setupObs(o);
  if(route==='/api/obs/record'){
   let s=await obsStatus(o);
   if(body.action==='start'){
    if(s.recording)throw Error('OBS is already recording.');if(s.streaming)throw Error('Use OBS to manage the active stream recording.');
    await setupObs(o);previousRecordDirectory=(await o.request('GetRecordDirectory')).recordDirectory;
    const dir=path.join(homedir(),'Desktop','Karaoke Recordings');await fs.mkdir(dir,{recursive:true});await o.request('SetRecordDirectory',{recordDirectory:dir});await o.request('StartRecord');ownedRecording=true;return {...await obsStatus(o),message:'Recording started.'};
   }
   if(body.action==='stop'){
    if(!s.recording)return {...s,message:'Recording already stopped.'};if(!ownedRecording)throw Error('This recording was started outside Karaoke Live. Stop it in OBS.');
    const result=await o.request('StopRecord');ownedRecording=false;if(previousRecordDirectory)await o.request('SetRecordDirectory',{recordDirectory:previousRecordDirectory}).catch(()=>{});previousRecordDirectory=null;return {...await obsStatus(o),savedPath:result.outputPath,message:'Recording saved.'};
   }
  }
  throw Error('Unknown karaoke request.');
 }finally{o.close();}
}
async function startServer(){
 server=http.createServer(async(req,res)=>{try{
  if(req.headers.host!==`127.0.0.1:${PORT}`){res.writeHead(403).end();return;}
  const url=new URL(req.url,ORIGIN);
  if(url.pathname.startsWith('/api/')){
   if(req.method!=='GET'&&req.method!=='POST'){res.writeHead(405).end();return;}
   if(req.headers.origin&&!ownOrigin(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403).end();return;}
   if(req.method==='GET'&&!['/api/obs/status','/api/app/status'].includes(url.pathname)){res.writeHead(405).end();return;}
   let body={};if(req.method==='POST'){if(!String(req.headers['content-type']).startsWith('application/json')){res.writeHead(415).end();return;}let raw='';for await(const b of req){raw+=b;if(raw.length>8192)throw Error('Request too large.');}body=JSON.parse(raw||'{}');}
   let result;try{result=await api(url.pathname,body);}catch(e){res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({connected:false,error:e.message}));return;}
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));return;
  }
  const filename=decodeURIComponent(url.pathname==='/'?'/control.html':url.pathname);const root=path.join(__dirname,'public'),file=path.resolve(root,'.'+filename);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const data=await fs.readFile(file);const type={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.wav':'audio/wav'}[path.extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(data);
 }catch(e){res.writeHead(e.code==='ENOENT'?404:500).end('Karaoke page unavailable.');}});
 await new Promise((resolve,reject)=>server.listen(PORT,'127.0.0.1',resolve).once('error',reject));
}
function protect(win){win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//.test(url))void shell.openExternal(url);return {action:'deny'};});win.webContents.on('will-navigate',(event,url)=>{if(!ownOrigin(url))event.preventDefault();});}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{control?.show();control?.focus();});
 app.whenReady().then(async()=>{
  // YouTube's official desktop-WebView identity format uses the installed app bundle ID.
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:['https://www.youtube.com/embed/*','https://www.youtube-nocookie.com/embed/*']},(details,callback)=>{const headers={...details.requestHeaders};for(const key of Object.keys(headers))if(key.toLowerCase()==='referer')delete headers[key];headers.Referer=`https://${BUNDLE}/`;callback({requestHeaders:headers});});
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(ownOrigin(details.requestingUrl||contents.getURL())&&['media','speaker-selection'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((contents,permission,origin)=>ownOrigin(origin)&&['media','speaker-selection'].includes(permission));
  await startServer();
  stage=new BrowserWindow({title:'Karaoke Live — Stage',width:1280,height:720,useContentSize:true,frame:false,backgroundColor:'#101119',resizable:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});stage.setAspectRatio(16/9);protect(stage);await stage.loadURL(ORIGIN+'/stage.html');
  stage.on('page-title-updated',event=>event.preventDefault());
  control=new BrowserWindow({title:'Karaoke Live — Controls',width:460,height:830,minWidth:400,minHeight:660,backgroundColor:'#101119',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});protect(control);await control.loadURL(ORIGIN+'/control.html');control.focus();
  control.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
  stage.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Karaoke Live',submenu:[{role:'about'},{label:'Show controls',click:()=>{control?.show();control?.focus();}},{label:'Show stage',click:()=>{stage?.show();stage?.focus();}},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'togglefullscreen'}]}]));
 }).catch(e=>{console.error('Karaoke startup:',e.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());app.on('before-quit',event=>{if(quitReady)return;event.preventDefault();if(quitting)return;quitting=true;(async()=>{try{if(ownedRecording)await api('/api/obs/record',{action:'stop'});}catch(e){console.error('OBS recording remains running:',e.message);}finally{server?.close();quitReady=true;app.exit(0);}})();});
}
