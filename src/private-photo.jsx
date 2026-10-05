import React,{useEffect,useState} from 'react';
import { downloadPhoto } from './data/photos.js';
export default function PrivatePhoto({photo,label}) {
 const [url,setUrl]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
 const view=async()=>{setBusy(true);setError('');try{setUrl(await downloadPhoto(photo.storagePath));}catch(e){setError(e.message || 'Unable to load photo. Try again.');}finally{setBusy(false);}};
 return <div className="photo-inspection">{url?<img src={url} alt={label}/>:<button className="text-action" disabled={busy} onClick={view}>{busy?'Loading photo…':`View Photo · ${label}`}</button>}{error&&<p role="alert">{error}</p>}</div>;
}
