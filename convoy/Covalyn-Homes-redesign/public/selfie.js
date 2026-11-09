// Camera permission is requested only when the account holder chooses Take a selfie.
export function createSelfieCamera({getUserMedia=constraints=>navigator.mediaDevices.getUserMedia(constraints)}={}){
 let stream=null,preview=null,generation=0;
 function stop(){generation++;stream?.getTracks().forEach(track=>track.stop());stream=null;if(preview)preview.srcObject=null;preview=null;}
 async function start(video){
  stop();const request=++generation;
  const incoming=await getUserMedia({video:{facingMode:'user'},audio:false});
  if(request!==generation||!video.isConnected){incoming.getTracks().forEach(track=>track.stop());return false;}
  stream=incoming;preview=video;video.srcObject=stream;
  try{await video.play();return request===generation;}catch(error){if(request===generation)stop();throw error;}
 }
 async function capture(video,documentRef=document){
  if(!stream||!video.videoWidth)throw Error('The camera is still starting. Please try again.');
  const request=generation,canvas=documentRef.createElement('canvas'),scale=Math.min(1,1280/video.videoWidth,1280/video.videoHeight);
  canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
  if(request!==generation)return null;
  if(!blob||blob.size>4*1024*1024)throw Error('Please retake your selfie or upload an image under 4 MB.');
  stop();return new File([blob],'selfie.jpg',{type:'image/jpeg'});
 }
 return {start,capture,stop};
}
