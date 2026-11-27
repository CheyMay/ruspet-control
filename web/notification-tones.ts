export const notificationTones={
 classic:'Классический',
 bell:'Колокольчик',
 drops:'Капли',
 radio:'Рация Сергея',
} as const;

export type NotificationTone=keyof typeof notificationTones;
const samples=new Map<NotificationTone,Promise<AudioBuffer>>();

function loadSample(audio:AudioContext,tone:Exclude<NotificationTone,'classic'>){
 const existing=samples.get(tone);
 if(existing)return existing;
 const pending=fetch('/notification-sounds/'+tone+'.mp3').then(response=>{
  if(!response.ok)throw new Error('Звук недоступен.');
  return response.arrayBuffer();
 }).then(data=>audio.decodeAudioData(data)).catch(error=>{
  samples.delete(tone);
  throw error;
 });
 samples.set(tone,pending);
 return pending;
}

export async function playTone(audio:AudioContext,tone:NotificationTone,shouldPlay:()=>boolean){
 if(tone!=='classic'){
  const buffer=await loadSample(audio,tone);
  if(audio.state!=='running'||!shouldPlay())return false;
  const source=audio.createBufferSource(),volume=audio.createGain();
  source.buffer=buffer;volume.gain.value=.22;
  source.connect(volume);volume.connect(audio.destination);
  source.start();
  source.onended=()=>{source.disconnect();volume.disconnect();};
  return true;
 }
 const start=audio.currentTime;
 for(const [i,frequency] of [660,880].entries()){
  const oscillator=audio.createOscillator(),volume=audio.createGain(),at=start+i*.12;
  oscillator.type='sine';oscillator.frequency.value=frequency;
  volume.gain.setValueAtTime(.0001,at);
  volume.gain.exponentialRampToValueAtTime(.15,at+.025);
  volume.gain.exponentialRampToValueAtTime(.0001,at+.18);
  oscillator.connect(volume);volume.connect(audio.destination);
  oscillator.start(at);oscillator.stop(at+.19);
  oscillator.onended=()=>{oscillator.disconnect();volume.disconnect();};
 }
 return true;
}
