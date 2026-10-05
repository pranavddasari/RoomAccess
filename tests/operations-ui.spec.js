import {test,expect} from '@playwright/test';
import {makeDatabase,as,identities,command,holder} from './helpers/database.js';
let db,rooms,queue,files,uploads,errors;
test.beforeEach(async()=>{db=await makeDatabase();rooms=(await db.query('select id from rooms order by display_name')).rows.map(r=>r.id);queue=Promise.resolve();files=new Map();uploads=[];errors=[];});
test.afterEach(async()=>{await queue;await db.close();});
const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
async function connect(page,actor){
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(({actor,email})=>{
  const token='e30.'+btoa(JSON.stringify({sub:actor,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'}))+'.sig';
  localStorage.setItem('sb-membership-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:actor,email,aud:'authenticated',app_metadata:{provider:'google'}}}));
  localStorage.setItem('music-club-rooms-demo-v2','old demo history must not be imported');
 },{actor,email:Object.entries(identities).find(([,id])=>id===actor)[0]+'@vitstudent.ac.in'});
 await page.routeWebSocket('wss://membership.test/**',()=>{});
 await page.route('https://membership.test/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  try{
   if(path.includes('/rest/v1/rpc/')){
    const name=path.split('/').at(-1),p=req.postDataJSON()??{};
    const allowed={authorize_membership:[],member_directory:[],operational_directory:[],operational_snapshot:[],register_photo_upload:['p_id','p_session_id','p_stage','p_category'],operational_command:['p_operation_id','p_action','p_room_id','p_expected_version','p_session_id','p_payload']};
    if(!allowed[name])throw new Error('Unknown test RPC: '+name);
    const values=allowed[name].map(k=>typeof p[k]==='object' && p[k]!==null?JSON.stringify(p[k]):p[k]);
    const result=await serial(()=>as(db,actor,`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as result`,values));
    let data=result.rows[0].result;
    if(['member_directory','operational_directory'].includes(name)){const names=await serial(()=>as(db,actor,`select * from public.${name}()`));data=names.rows;}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
   }
   if(path==='/rest/v1/club_members'){const result=await serial(()=>as(db,actor,'select * from club_members order by name'));return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result.rows)});}
   if(path.startsWith('/storage/v1/object/')){
    const authenticatedDownload=path.startsWith('/storage/v1/object/authenticated/');
    const objectPath=decodeURIComponent(path.slice((authenticatedDownload?'/storage/v1/object/authenticated/session-photos/':'/storage/v1/object/session-photos/').length));
    if(req.method()==='POST'){
     const request=new Request('http://fixture',{method:'POST',headers:req.headers(),body:req.postDataBuffer()});const form=await request.formData();const image=form.get('');const body=Buffer.from(await image.arrayBuffer());
     await serial(()=>as(db,actor,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('session-photos',$1,$2,$3)",[objectPath,actor,JSON.stringify({size:body.length,mimetype:image.type})]));
     files.set(objectPath,body);uploads.push({path:objectPath,bytes:body.length,mime:image.type});
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({Key:'session-photos/'+objectPath,Id:crypto.randomUUID()})});
    }
    const visible=await serial(()=>as(db,actor,"select * from storage.objects where bucket_id='session-photos' and name=$1",[objectPath]));
    if(!visible.rows.length)throw new Error('Unauthorized private photo');
    return route.fulfill({status:200,contentType:'image/jpeg',body:files.get(objectPath)});
   }
   if(path.endsWith('/logout'))return route.fulfill({status:204});
   throw new Error('Unhandled fixture request: '+path);
  }catch(e){return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:e.message,code:e.code??'TEST_ERROR',error:e.message})});}
 });
 await page.goto('/');await expect(page.getByRole('heading',{name:'Rooms',exact:true})).toBeVisible();
}
async function imageFile(page){
 const encoded=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2400;c.height=1800;const ctx=c.getContext('2d'),data=ctx.createImageData(c.width,c.height);let n=12345;for(let i=0;i<data.data.length;i+=4){n=(n*1664525+1013904223)>>>0;data.data[i]=n&255;data.data[i+1]=(n>>>8)&255;data.data[i+2]=(n>>>16)&255;data.data[i+3]=255;}ctx.putImageData(data,0,0);return c.toDataURL('image/png').split(',')[1];});
 return {name:'camera.png',mimeType:'image/png',buffer:Buffer.from(encoded,'base64')};
}
async function photo(page,file,category='room'){
 const capture=page.locator('.photo-capture').nth(category==='room'?0:1);await capture.locator('input[type=file]').setInputFiles(file);await expect(capture.getByRole('button',{name:'Use Photo'})).toBeVisible();await capture.getByRole('button',{name:'Use Photo'}).click();await expect(capture.locator('.ready-check')).toBeVisible();
}
const roomCard=(page,name='MR-1')=>page.getByRole('article').filter({has:page.getByRole('heading',{name,exact:true})});
async function initialize(page,name='MR-1',destination='member'){
 await page.getByRole('button',{name:/^Admin/}).click();const card=page.locator('.admin-card').filter({has:page.getByRole('heading',{name,exact:true})});await card.getByRole('button',{name:'Correct Custody',exact:true}).click();
 if(destination==='member'){await page.getByRole('button',{name:'Club Member',exact:true}).click();await page.getByRole('button',{name:'a',exact:true}).click();}else await page.getByRole('button',{name:'SW Office',exact:true}).click();
 await page.getByLabel('Reason for correction (required)').fill('Physically verified test key');await page.getByRole('button',{name:'Confirm Correction'}).click();await page.getByRole('button',{name:'Done'}).click();await page.getByRole('button',{name:'Rooms',exact:true}).click();
}
test('Admin initializes shared custody; Member photos compress, start/end retain key, refresh and Admin private evidence inspection',async({page,browser})=>{
 test.setTimeout(60000);await connect(page,identities.admin);await expect(page.getByText('Key status not initialized. An administrator must record physical custody first.')).toHaveCount(5);await initialize(page);
 const context=await browser.newContext({viewport:{width:390,height:844}}),student=await context.newPage();await connect(student,identities.a);const file=await imageFile(student);
 expect(file.buffer.length).toBeGreaterThan(512000);
 await roomCard(student).getByRole('button',{name:'Start Session',exact:true}).click();await photo(student,file);await photo(student,file,'cables');await student.getByRole('button',{name:'Start MR-1 Session'}).click();await expect(roomCard(student).getByRole('button',{name:'End Session'})).toBeVisible();
 expect(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await student.screenshot({path:'/tmp/music-room-shared-session-390.png'});expect(uploads.length).toBe(2);for(const u of uploads){expect(u.bytes).toBeLessThanOrEqual(512000);expect(u.mime).toBe('image/jpeg');}
 await student.reload();await expect(roomCard(student).getByRole('button',{name:'End Session'})).toBeVisible();
 await roomCard(student).getByRole('button',{name:'End Session'}).click();await photo(student,file);await photo(student,file,'cables');await student.getByRole('button',{name:'Continue to Key Disposition'}).click();await student.getByRole('button',{name:'Keep Key With Me'}).click();await student.getByRole('button',{name:'Confirm & Complete Session'}).click();await student.getByRole('button',{name:'Done'}).click();
 await expect(roomCard(student).getByRole('button',{name:'Start Session',exact:true})).toBeVisible();
 expect((await db.query("select count(*)::int as n from key_custody_events where mode='SESSION_CHECKOUT'")).rows[0].n).toBe(0);
 await page.reload();await page.getByRole('button',{name:/^Admin/}).click();await page.getByRole('navigation',{name:'Admin sections'}).getByRole('button',{name:'History',exact:true}).click();const sessionCard=page.locator('.admin-card').filter({has:page.getByText('MR-1 · a',{exact:true})});await sessionCard.getByText('View Details',{exact:true}).click();await sessionCard.getByRole('button',{name:'View Photo · Start Room',exact:true}).click();await expect(sessionCard.locator('.photo-inspection img')).toBeVisible();
 expect(await student.evaluate(()=>localStorage.getItem('music-club-rooms-demo-v2'))).toBe('old demo history must not be imported');expect(errors).toEqual([]);await context.close();
});
test('Two clients share multi-room activity; receipt recovery freezes partial evidence and resolves flag without repairing outcome',async({page,browser})=>{
 test.setTimeout(60000);await connect(page,identities.admin);await initialize(page,'MR-1');await initialize(page,'MR-2');
 const contextA=await browser.newContext(),contextB=await browser.newContext(),student=await contextA.newPage(),receiver=await contextB.newPage();await connect(student,identities.a);await connect(receiver,identities.b);const file=await imageFile(student);
 for(const room of ['MR-1','MR-2']){await roomCard(student,room).getByRole('button',{name:'Start Session',exact:true}).click();await photo(student,file);await photo(student,file,'cables');await student.getByRole('button',{name:`Start ${room} Session`}).click();}
 await roomCard(student).getByRole('button',{name:'End Session'}).click();await photo(student,file);await student.getByRole('button',{name:'Close',exact:true}).click();
 await receiver.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(roomCard(receiver).getByText(/unfinished session from a/)).toBeVisible();
 await roomCard(receiver).getByRole('button',{name:'I Received This Key'}).click();await receiver.getByRole('button',{name:'Club Member',exact:true}).click();await receiver.getByRole('button',{name:'a',exact:true}).click();
 await receiver.getByLabel('Recovery reason').selectOption('OTHER');await receiver.getByLabel(/Recovery remarks/).fill('Previous band left; key physically received');await receiver.getByRole('button',{name:'Review Receipt',exact:true}).click();await receiver.getByRole('button',{name:'Confirm Recovery & Receipt',exact:true}).click();await receiver.getByRole('button',{name:'Done'}).click();
 await expect(roomCard(receiver).getByRole('button',{name:'Start Session',exact:true})).toBeVisible();await student.reload();await expect(roomCard(student,'MR-2').getByRole('button',{name:'End Session'})).toBeVisible();
 const first=(await db.query('select * from sessions where room_id=$1',[rooms[0]])).rows[0];expect(first.status).toBe('INCOMPLETE');expect(first.closed_by).toBe(identities.b);expect((await db.query("select * from session_photos where session_id=$1 and stage='END'",[first.id])).rows.length).toBe(1);
 await page.reload();await page.getByRole('button',{name:/^Admin/}).click();await page.getByRole('button',{name:/^Flags/}).click();await page.getByText('Review Flag',{exact:true}).click();await page.getByRole('button',{name:'Resolve Flag',exact:true}).click();await page.getByRole('button',{name:'Confirm Resolution',exact:true}).click();await expect(page.getByText('No open flags match these filters.')).toBeVisible();expect((await db.query('select status from sessions where id=$1',[first.id])).rows[0].status).toBe('INCOMPLETE');expect(errors).toEqual([]);await contextA.close();await contextB.close();
});
test('Compression rejects invalid images and constrains dimensions/bytes without uploading originals',async({page})=>{
 await connect(page,identities.a);const file=await imageFile(page);
 const result=await page.evaluate(async encoded=>{const {compressPhoto}=await import('/src/data/photos.js');const input=await(await fetch('data:image/png;base64,'+encoded)).blob();const result=await compressPhoto(new File([input],'camera.png',{type:'image/png'}));let invalid='';try{await compressPhoto(new File(['bad image'],'invalid.jpg',{type:'image/jpeg'}));}catch(e){invalid=e.message;}return {bytes:result.blob.size,width:result.width,height:result.height,mime:result.blob.type,invalid};},file.buffer.toString('base64'));
 expect(result.bytes).toBeLessThanOrEqual(512000);expect(Math.max(result.width,result.height)).toBeLessThanOrEqual(1600);expect(result.mime).toBe('image/jpeg');expect(result.invalid).toContain('could not be decoded');expect(uploads.length).toBe(0);
});

test('Failed photo upload leaves the requirement incomplete and retains the preview for retry',async({page})=>{
 test.setTimeout(45000);await command(db,identities.admin,'CORRECT',rooms[0],{payload:{destination:holder(identities.a),reason:'Verified fixture custody'}});
 await connect(page,identities.a);const file=await imageFile(page);await roomCard(page).getByRole('button',{name:'Start Session',exact:true}).click();
 const capture=page.locator('.photo-capture').first();await capture.locator('input[type=file]').setInputFiles(file);
 await page.route('https://membership.test/storage/v1/object/session-photos/**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary upload failure',message:'Temporary upload failure',statusCode:'503'})}),{times:1});
 await capture.getByRole('button',{name:'Use Photo'}).click();await expect(capture.locator('.field-error')).toBeVisible();await expect(capture.locator('.ready-check')).toHaveCount(0);await expect(page.getByRole('button',{name:'Add both photos to continue'})).toBeDisabled();
 await expect(capture.locator('img')).toBeVisible();await capture.getByRole('button',{name:'Use Photo'}).click();await expect(capture.locator('.ready-check')).toBeVisible();expect((await db.query('select * from sessions')).rows.length).toBe(0);
});
