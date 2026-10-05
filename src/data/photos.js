import { supabase } from '../lib/supabase.js';
export const MAX_PHOTO_BYTES=512000,MAX_PHOTO_EDGE=1600,TARGET_PHOTO_BYTES=350000;
export async function decodePhoto(file) {
 if(!file || !file.type.startsWith('image/'))throw new Error('Choose a valid image.');
 const url=URL.createObjectURL(file);
 try { const image=new Image();image.src=url;await image.decode();if(!image.naturalWidth || !image.naturalHeight)throw new Error();return {image,url}; }
 catch {URL.revokeObjectURL(url);throw new Error('This image could not be decoded. Retake the photo.');}
}
const blobFromCanvas=(canvas,quality)=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('Image compression failed.')),'image/jpeg',quality));
export async function compressPhoto(file) {
 const {image,url}=await decodePhoto(file);
 try {
  let scale=Math.min(1,MAX_PHOTO_EDGE/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');
  for(let resize=0;resize<5;resize++) {
   canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
   const context=canvas.getContext('2d');if(!context)throw new Error('Image compression unavailable.');
   context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
   for(const quality of [.86,.76,.66,.56,.46]) {
    const blob=await blobFromCanvas(canvas,quality);
    if(blob.type==='image/jpeg' && blob.size<=TARGET_PHOTO_BYTES) return {blob,width:canvas.width,height:canvas.height};
    if(quality===.46 && blob.size<=MAX_PHOTO_BYTES && resize===4)return {blob,width:canvas.width,height:canvas.height};
   }
   scale*=.8;
  }
  throw new Error('Could not compress this photo below the upload limit. Retake it.');
 }finally{URL.revokeObjectURL(url);}
}
export async function uploadPhoto(file,{id,sessionId,stage,category}) {
 const compressed=await compressPhoto(file);
 if(compressed.blob.size>MAX_PHOTO_BYTES)throw new Error('Photo exceeds the upload limit.');
 const {data:path,error}=await supabase.rpc('register_photo_upload',{p_id:id,p_session_id:sessionId,p_stage:stage.toUpperCase(),p_category:category.toUpperCase()});
 if(error)throw error;
 const response=await supabase.storage.from('session-photos').upload(path,compressed.blob,{contentType:'image/jpeg',upsert:false});
 // A lost response may leave an uploaded object. Never overwrite it; a new
 // unique intent on retry leaves the previous object for orphan cleanup.
 if(response.error) {
  if(response.error.statusCode!=='409' && response.error.statusCode!==409)throw response.error;
  // Unattached objects deliberately cannot be read. Use a new unique upload path
  // on retry, leaving the previous attempt for orphan cleanup.
  throw new Error('This photo upload already exists. Use Photo again to retry safely.');
 }
 return {id,stage,category,storagePath:path,accepted:true,acceptedAt:new Date().toISOString(),availability:'AVAILABLE',width:compressed.width,height:compressed.height,byteSize:compressed.blob.size,previewUrl:URL.createObjectURL(compressed.blob)};
}
export async function downloadPhoto(path) {
 const {data,error}=await supabase.storage.from('session-photos').download(path);if(error)throw error;
 return URL.createObjectURL(data);
}
