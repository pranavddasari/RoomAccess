import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEmail, canAdmin, memberInput, resolveAuthorization, membershipError } from './auth-model.js';
const session={user:{id:'auth-id',email:'member@vitstudent.ac.in'}};
const client=(data,error=null)=>({rpc:async(name)=>{assert.equal(name,'authorize_membership');return {data,error};}});
test('no session returns Login without membership call',async()=>assert.equal((await resolveAuthorization(null,null)).state,'LOGIN'));
test('only exact VIT domain is accepted',async()=>{
 assert.ok(allowedEmail(' Student@vitstudent.ac.in '));
 for(const email of ['student@gmail.com','student@vit.ac.in','student@vitstudent.ac.in.fake','x@y@vitstudent.ac.in',''])assert.equal(allowedEmail(email),false);
 assert.equal((await resolveAuthorization(null,{user:{email:'x@gmail.com'}})).state,'DOMAIN_DENIED');
});
test('active Member enters with no admin privileges; Admin is allowed',async()=>{
 for(const role of ['MEMBER','ADMIN']) {const member={id:'membership',auth_user_id:'auth-id',status:'ACTIVE',role};const result=await resolveAuthorization(client({state:'ACTIVE',member}),session);assert.equal(result.state,'ACTIVE');assert.equal(canAdmin(result.member),role==='ADMIN');}
 assert.equal(canAdmin({role:'ADMIN',status:'DISABLED'}),false);
});
test('unknown, disabled and conflicting identities deny access',async()=>{
 for(const state of ['NOT_REGISTERED','DISABLED','IDENTITY_CONFLICT'])assert.equal((await resolveAuthorization(client({state}),session)).state,state);
 await assert.rejects(resolveAuthorization(client({state:'ACTIVE',member:{role:'ADMIN',status:'ACTIVE',auth_user_id:'wrong'}}),session),/verify/);
});
test('membership form normalizes both roles and rejects invalid inputs',()=>{
 for(const role of ['MEMBER','ADMIN'])assert.deepEqual(memberInput(' Arjun ',' ARJUN@vitstudent.ac.in ',role),{p_name:'Arjun',p_email:'arjun@vitstudent.ac.in',p_role:role});
 assert.throws(()=>memberInput('Arjun','x@gmail.com','MEMBER'),/vitstudent/);assert.throws(()=>memberInput('','x@vitstudent.ac.in','MEMBER'),/name/);
 assert.equal(membershipError({code:'23505'}),'This email is already registered.');
});
