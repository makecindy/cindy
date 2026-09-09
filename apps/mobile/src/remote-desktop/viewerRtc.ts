/** Static WebView code: stays independent of Hermes function serialization.
 * A media attempt owns its timers/candidates. The native screen retains the human lease.
 */
export const DESKTOP_RTC_SCRIPT = String.raw`
  let trickleIce=false,attemptId=null,retries=0,exchangeId=0;
  let configPending=false;
  let retryTimer=null,deadlineTimer=null,disconnectTimer=null,stableTimer=null,iceTimer=null,gatherTimer=null,gatherDone=null;
  let localCandidates=[],localAck=0,remoteAfter=0,icePending=null,remoteSeen=new Set(),exchangeUntil=0,remoteComplete=false;
  function clearRtcTimers(){
    for(const timer of [retryTimer,deadlineTimer,disconnectTimer,stableTimer,iceTimer,gatherTimer])clearTimeout(timer);
    retryTimer=deadlineTimer=disconnectTimer=stableTimer=iceTimer=gatherTimer=null;
    if(gatherDone){gatherDone();gatherDone=null;}
  }
  function closeRtc(preserveFrame=true){
    configPending=false;
    if(preserveFrame)retainFrame();generation++;clearRtcTimers();
    localCandidates=[];localAck=remoteAfter=0;icePending=null;remoteSeen=new Set();attemptId=null;
    clearInterval(statsTimer);statsTimer=null;statsSample=null;
    if(dc)dc.close();if(pc)pc.close();pc=null;dc=null;
    video.onplaying=null;video.srcObject=null;video.style.display='none';image.style.display='block';
    if(!preserveFrame)image.removeAttribute('src');
  }
  function failRtc(reason,canRetry=true){
    const failedAttempt=attemptId;
    release();closeRtc();post({type:'fallback',attemptId:failedAttempt,reason});
    if(canRetry&&epoch&&retries<net.retryMs.length){
      const delay=net.retryMs[retries++];
      retryTimer=setTimeout(()=>{retryTimer=null;if(epoch)connect();},delay);
    }
  }
  function pollIce(){
    if(!pc||!trickleIce||!pc.remoteDescription||icePending||Date.now()>=exchangeUntil)return;
    const candidates=localCandidates.slice(localAck,localAck+net.batchSize);
    icePending={after:remoteAfter,sent:candidates.length,exchangeId:++exchangeId};
    post({type:'ice',attemptId,candidates,after:remoteAfter,exchangeId});
    iceTimer=setTimeout(()=>{icePending=null;pollIce();},4500);
  }
  async function receiveIce(message){
    if(!pc||!icePending||message.attemptId!==attemptId||message.exchangeId!==icePending.exchangeId)return;
    const rtc=pc,g=generation,batch=icePending;
    clearTimeout(iceTimer);
    try{
      if(message.error){icePending=null;iceTimer=setTimeout(pollIce,1000);return;}
      if(!Array.isArray(message.candidates)||message.candidates.length>net.batchSize||message.next!==batch.after+message.candidates.length||message.next>net.maxCandidates)throw new Error();
      for(const candidate of message.candidates){
        if(g!==generation)return;
        const key=JSON.stringify(candidate);
        if(remoteSeen.has(key))continue;
        if(remoteSeen.size>=net.maxCandidates)throw new Error();
        await rtc.addIceCandidate(candidate);
        if(g!==generation)return;
        remoteSeen.add(key);
      }
      if(g!==generation)return;
      localAck+=batch.sent;remoteAfter=message.next;remoteComplete=message.complete===true;icePending=null;
      if(!(remoteComplete&&rtc.iceGatheringState==='complete'&&localAck===localCandidates.length))
        iceTimer=setTimeout(pollIce,net.pollMs);
    }catch{if(g===generation)failRtc('candidates');}
  }
  async function receiveAnswer(message){
    if(!pc||message.attemptId!==attemptId)return;
    const rtc=pc,g=generation;
    try{
      await rtc.setRemoteDescription({type:'answer',sdp:message.sdp});
      if(g!==generation)return;
      clearTimeout(deadlineTimer);
      deadlineTimer=setTimeout(()=>{if(g===generation&&rtc.connectionState!=='connected')failRtc('connect-timeout');},net.connectMs);
      exchangeUntil=Date.now()+net.exchangeMs;pollIce();
    }catch{if(g===generation)failRtc('answer');}
  }
  async function connect(){
    closeRtc();const g=generation;attemptId=String(g);
    if(!window.RTCPeerConnection){failRtc('unsupported',false);return;}
    configPending=true;
    deadlineTimer=setTimeout(()=>{if(g===generation&&configPending){configPending=false;void startRtc(g,iceServers);}},3500);
    return post({type:'iceConfig',attemptId});
  }
  async function receiveIceConfig(message){
    if(!epoch||!configPending||message.attemptId!==attemptId)return;
    configPending=false;clearTimeout(deadlineTimer);deadlineTimer=null;
    await startRtc(generation,message.iceServers);
  }
  async function startRtc(g,servers){
    try{
      const rtc=new RTCPeerConnection({iceServers:servers});pc=rtc;
      dc=rtc.createDataChannel('input-v1');rtc.addTransceiver('video',{direction:'recvonly'});rtc.addTransceiver('audio',{direction:'recvonly'});
      rtc.onicecandidate=({candidate})=>{
        if(g!==generation||!candidate?.candidate||!trickleIce)return;
        if(localCandidates.length>=net.maxCandidates){failRtc('candidate-limit',false);return;}
        localCandidates.push({candidate:candidate.candidate,sdpMid:candidate.sdpMid,sdpMLineIndex:candidate.sdpMLineIndex,
          ...(candidate.usernameFragment?{usernameFragment:candidate.usernameFragment}:{})});
        // Gathering continues after the offer; the serial exchange flushes late addresses.
      };
      dc.onmessage=e=>{try{if(g!==generation||pc!==rtc)return;if(typeof e.data!=='string'||e.data.length>80000)return;const message=JSON.parse(e.data);if(message.type==='cursor')receiveCursor(message.cursor);if((video.webkitPresentationMode==='picture-in-picture'||document.pictureInPictureElement===video)&&message.type==='viewPing'&&typeof message.challenge==='string'&&message.challenge.length<=64&&dc?.readyState==='open')dc.send(message.challenge);}catch{}};
      let readingStats=false;
      statsTimer=setInterval(async()=>{
        if(readingStats||g!==generation)return;readingStats=true;
        try{const stats=await rtc.getStats();if(g!==generation||pc!==rtc)return;const result=networkStats(stats,statsSample);statsSample=result.sample;post({type:'network',transport:result.transport,bytesPerSecond:result.bytesPerSecond,latencyMs:result.latencyMs});}catch{}finally{readingStats=false;}
      },1000);
      rtc.ontrack=e=>{if(g!==generation)return;video.srcObject=e.streams[0]||new MediaStream([e.track]);video.play().catch(()=>{});};
      video.onplaying=()=>{if(g!==generation)return;video.style.display='block';image.style.display='none';post({type:'streaming',attemptId});post({type:'pipCapability',supported:!!(video.webkitSupportsPresentationMode?.('picture-in-picture')||document.pictureInPictureEnabled)});render();};
      rtc.onconnectionstatechange=()=>{
        if(g!==generation)return;
        if(['failed','closed'].includes(rtc.connectionState)){failRtc('transport');return;}
        if(rtc.connectionState==='disconnected'){
          clearTimeout(stableTimer);stableTimer=null;
          if(!disconnectTimer){release();post({type:'reconnecting',attemptId});disconnectTimer=setTimeout(()=>{if(g===generation)failRtc('disconnected');},net.disconnectedMs);}
        }else if(rtc.connectionState==='connected'){
          clearTimeout(disconnectTimer);disconnectTimer=null;clearTimeout(deadlineTimer);
          if(!stableTimer)stableTimer=setTimeout(()=>{if(g===generation)retries=0;},net.stableMs);
          if(video.style.display==='block')post({type:'streaming',attemptId});
        }
      };
      await rtc.setLocalDescription(await rtc.createOffer());
      if(!trickleIce)await new Promise(resolve=>{
        if(rtc.iceGatheringState==='complete')return resolve();gatherDone=resolve;
        gatherTimer=setTimeout(resolve,net.legacyGatherMs);
        rtc.onicegatheringstatechange=()=>{if(rtc.iceGatheringState==='complete'){clearTimeout(gatherTimer);resolve();}};
      });
      if(g!==generation)return;
      post({type:'offer',attemptId,sdp:rtc.localDescription.sdp});
      deadlineTimer=setTimeout(()=>{if(g===generation)failRtc('answer-timeout');},net.answerMs);
    }catch{if(g===generation)failRtc('setup');}
  }
`;
