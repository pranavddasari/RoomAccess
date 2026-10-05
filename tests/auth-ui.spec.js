import { test, expect } from '@playwright/test';
const authId='11111111-1111-4111-8111-111111111111';
const memberId='22222222-2222-4222-8222-222222222222';
const profile={id:memberId,name:'Test Student',email:'student@vitstudent.ac.in',auth_user_id:authId,role:'MEMBER',status:'ACTIVE'};
async function setup(page,{role='MEMBER',state='ACTIVE',email=profile.email,signedIn=true,callbackSuffix=''}={}) {
 await page.addInitScript(()=> { window.adminFlashed=false; new MutationObserver(()=>{if(document.querySelector('.admin-view'))window.adminFlashed=true;}).observe(document,{subtree:true,childList:true}); });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const records=[{...profile,role}, ...Array.from({length:199},(_,i)=>({id:`person-${i}`,name:`Person ${i}`,email:`person${i}@vitstudent.ac.in`,role:i%20===0?'ADMIN':'MEMBER',status:i%15===0?'DISABLED':'ACTIVE'}))];
 if(signedIn) await page.addInitScript(({email,authId})=>{
  const payload=btoa(JSON.stringify({sub:authId,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'}));
  localStorage.setItem('sb-membership-auth-token',JSON.stringify({access_token:`e30.${payload}.signature`,refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:authId,email,app_metadata:{provider:'google'},aud:'authenticated'}}));
 },{email,authId});
 const requests=[];
 const snapshot={rooms:Array.from({length:5},(_,i)=>({id:`room-${i+1}`,display_name:`MR-${i+1}`,active:true,version:0})),keys:Array.from({length:5},(_,i)=>({room_id:`room-${i+1}`,holder_type:'SW',holder_member_id:null,version:0})),sessions:[],photos:[],custody:[],flags:[],audit:[]};
 await page.routeWebSocket('wss://membership.test/**',()=>{});
 await page.route('https://membership.test/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;requests.push({path,body:request.postDataJSON()});
  let data={};
  if(path.endsWith('/authorize_membership'))data={state,member:{...profile,role}};
  else if(path.endsWith('/operational_snapshot'))data=snapshot;
  else if(path.endsWith('/operational_directory'))data=records.map(({id,name})=>({id,name}));
  else if(path.endsWith('/operational_command')) {const p=request.postDataJSON(),r=snapshot.rooms.find(r=>r.id===p.p_room_id),k=snapshot.keys.find(k=>k.room_id===r.id);k.holder_type='MEMBER';k.holder_member_id=memberId;r.version++;snapshot.custody.push({id:'receipt',room_id:r.id,actor_id:memberId,mode:'INCOMING',previous_recorded_holder:{type:'location',id:'sw'},reported_source:p.p_payload.source,new_holder:{type:'member',id:memberId},created_at:new Date().toISOString()});data={ok:true,version:r.version};}
  else if(path.endsWith('/member_directory'))data=records.filter(m=>m.status==='ACTIVE').map(({id,name})=>({id,name}));
  else if(path.endsWith('/club_members'))data=records;
  else if(path.endsWith('/add_club_member')) { const p=request.postDataJSON(); data={id:`new-${records.length}`,name:p.p_name,email:p.p_email,role:p.p_role,status:'ACTIVE'};records.push(data); }
  else if(path.endsWith('/change_club_member')) { const p=request.postDataJSON(),m=records.find(m=>m.id===p.p_id);if(p.p_role)m.role=p.p_role;if(p.p_status)m.status=p.p_status;data=m; }
  else if(path.endsWith('/logout')) return route.fulfill({status:204});
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('/' + callbackSuffix);
 return {errors,requests};
}
async function noOverflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
test('mobile login has Google only and initiates Supabase OAuth',async({page})=>{
 const {errors}=await setup(page,{signedIn:false});await expect(page.getByRole('button',{name:'Continue with Google'})).toBeVisible();
 await expect(page.locator('input')).toHaveCount(0);await noOverflow(page);await page.screenshot({path:'/tmp/music-club-login-390.png'});
 await page.route('https://membership.test/auth/v1/authorize**',route=>route.fulfill({status:200,contentType:'text/html',body:'Google OAuth test destination'}));
 await page.getByRole('button',{name:'Continue with Google'}).click();await page.waitForURL(/auth\/v1\/authorize/);expect(page.url()).toContain('provider=google');expect(page.url()).toContain('redirect_to=');expect(errors).toEqual([]);
});
test('Member sees rooms, cannot impersonate, never renders Admin and signout preserves local data',async({page})=>{
 const {errors}=await setup(page);await expect(page.getByRole('heading',{name:'Rooms',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/^Admin/})).toHaveCount(0);await expect(page.locator('.user-switcher')).toHaveCount(0);expect(await page.evaluate(()=>window.adminFlashed)).toBe(false);
 expect(await page.evaluate(()=>localStorage.getItem('music-club-rooms-demo-v2'))).toBeNull();
 await page.getByRole('button',{name:'I Received This Key'}).first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Club Member',exact:true}).click(); await expect(page.getByText('Select a member',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close',exact:true}).click();
 const room=page.getByRole('article').filter({has:page.getByRole('heading',{name:'MR-2',exact:true})});
 await room.getByRole('button',{name:'I Received This Key'}).click();await page.getByRole('button',{name:'SW Office',exact:true}).click();await page.getByRole('button',{name:'Confirm Receipt',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();await expect(room.getByRole('button',{name:'Start Session'})).toBeVisible();
 expect((await page.request.get('/')).ok()).toBe(true); const receiptRequest=await page.evaluate(()=>localStorage.getItem('music-club-rooms-demo-v2'));expect(receiptRequest).toBeNull();
 await page.getByRole('button',{name:'Sign Out',exact:true}).click();
 await expect(page.getByRole('button',{name:'Continue with Google'})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('music-club-rooms-demo-v2'))).toBeNull();expect(errors).toEqual([]);
});
for(const [state,text] of [['NOT_REGISTERED',"You're not currently registered"],['DISABLED','Your Music Club access is currently disabled'],['IDENTITY_CONFLICT','linked to a different account']])test(`${state} shows denial and Sign Out only`,async({page})=>{
 const {errors}=await setup(page,{state});await expect(page.getByRole('alert')).toContainText(text);await expect(page.getByRole('button')).toHaveCount(1);await expect(page.getByRole('button',{name:'Sign Out'})).toBeVisible();expect(errors).toEqual([]);
});
test('non-VIT identity is denied before membership request',async({page})=>{
 const {requests}=await setup(page,{email:'student@gmail.com'});await expect(page.getByRole('alert')).toContainText('@vitstudent.ac.in Google account');expect(requests.some(r=>r.path.endsWith('/authorize_membership'))).toBe(false);
});
test('Admin members layout works at 390px with 200 people; adds both roles and confirms promotion',async({page})=>{
 const {requests,errors}=await setup(page,{role:'ADMIN'});
 await page.getByRole('button',{name:/^Admin/}).click();await page.getByRole('button',{name:'Members',exact:true}).click();await expect(page.getByText('200 people',{exact:true})).toBeVisible();await noOverflow(page);await page.screenshot({path:'/tmp/music-club-members-390.png'});
 for(const role of ['MEMBER','ADMIN']) {
 await page.getByRole('button',{name:'Add Person'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Name',{exact:true}).fill(' Arjun ');await dialog.getByLabel('Email',{exact:true}).fill(` ARJUN-${role}@vitstudent.ac.in `);await dialog.getByLabel('Role',{exact:true}).selectOption(role);await dialog.getByRole('button',{name:'Add',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(requests.findLast(r=>r.path.endsWith('/add_club_member')).body).toEqual({p_name:'Arjun',p_email:`arjun-${role.toLowerCase()}@vitstudent.ac.in`,p_role:role});
 }
 await page.getByLabel('Search name or email').fill('person1@');const card=page.locator('.admin-card').filter({hasText:'person1@vitstudent.ac.in'});await card.getByRole('button',{name:'Make Admin'}).click();await expect(page.getByRole('dialog')).toContainText('Administrators can view all room/session records and photos');await page.getByRole('dialog').getByRole('button',{name:'Confirm'}).click();await expect(card).toContainText('ADMIN');expect(errors).toEqual([]);
});

for (const separator of ['#', '?']) test(`OAuth ${separator} callback shows one clean domain rejection message`, async ({ page }) => {
 const message = 'This website is available only to approved Music Club members using a @vitstudent.ac.in Google account.';
 const callbackSuffix = separator + new URLSearchParams({ error: 'access_denied', error_description: message.replace('@', '%40') });
 const { errors } = await setup(page, { signedIn: false, callbackSuffix });
 await expect(page.getByRole('alert')).toHaveText(message);
 await expect(page.getByRole('alert')).toHaveCount(1);
 await expect(page.getByRole('button', { name: 'Sign Out / Try Another Account', exact: true })).toBeVisible();
 expect(errors).toEqual([]);
});
