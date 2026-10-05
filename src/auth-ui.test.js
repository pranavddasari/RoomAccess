import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
test('rendered access and navigation enforce member/admin distinction before displaying operational data',async()=>{
 const server=await createServer({cacheDir:'node_modules/.vite-ssr-tests',optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
 try {
  const {AccessScreen}=await server.ssrLoadModule('/src/auth.jsx');
  const {BottomNav}=await server.ssrLoadModule('/src/main.jsx');
  const {default:AdminView}=await server.ssrLoadModule('/src/admin.jsx');
  const member={status:'ACTIVE',role:'MEMBER'};
  const navigation=renderToStaticMarkup(React.createElement(BottomNav,{tab:'rooms',isAdmin:false,activeCount:2,setTab:()=>{}}));
  assert.ok(!navigation.includes('Admin'));assert.ok(navigation.includes('Rooms'));
  const adminNav=renderToStaticMarkup(React.createElement(BottomNav,{tab:'rooms',isAdmin:true,activeCount:2,setTab:()=>{}}));assert.ok(adminNav.includes('Admin'));
  const directAdmin=renderToStaticMarkup(React.createElement(AdminView,{member}));assert.match(directAdmin,/Administrator access required/);assert.ok(!directAdmin.includes('Room Status'));
  const login=renderToStaticMarkup(React.createElement(AccessScreen,{state:'LOGIN'}));assert.match(login,/Continue with Google/);assert.ok(!login.includes('<input'));
  const loading=renderToStaticMarkup(React.createElement(AccessScreen,{state:'LOADING'}));assert.match(loading,/Checking your access/);assert.ok(!loading.includes('Admin'));
 }finally {await server.close();}
});
