export const notificationTones={
 classic:'Классический',
 bell:'Колокольчик',
 drops:'Капли',
 radio:'Рация Сергея',
} as const;

export type NotificationTone=keyof typeof notificationTones;

type Note={
 delay:number;
 hz:number;
 duration:number;
 level:number;
 attack?:number;
 endHz?:number;
 wave?:OscillatorType;
};

const melodies:Record<NotificationTone,Note[]>={
 classic:[
  {delay:0,hz:660,duration:.18,level:.15},
  {delay:.12,hz:880,duration:.18,level:.15},
 ],
 bell:[
  {delay:0,hz:784,duration:.32,level:.11,attack:.008},
  {delay:0,hz:1568,duration:.12,level:.033,attack:.005},
  {delay:.12,hz:1174.7,duration:.25,level:.066,attack:.01},
 ],
 drops:[
  {delay:0,hz:1010,endHz:655,duration:.13,level:.13,attack:.012},
  {delay:.102,hz:1410,endHz:916,duration:.16,level:.1,attack:.009},
 ],
 radio:[
  {delay:.044,hz:910,endHz:865,duration:.093,level:.12,attack:.008,wave:'triangle'},
  {delay:.147,hz:1230,endHz:1190,duration:.068,level:.085,attack:.007,wave:'triangle'},
 ],
};

function playNote(audio:BaseAudioContext,start:number,note:Note){
 const oscillator=audio.createOscillator(),envelope=audio.createGain();
 const at=start+note.delay,end=at+note.duration;
 oscillator.type=note.wave??'sine';
 oscillator.frequency.setValueAtTime(note.hz,at);
 if(note.endHz)oscillator.frequency.exponentialRampToValueAtTime(note.endHz,end);
 envelope.gain.setValueAtTime(.0001,at);
 envelope.gain.exponentialRampToValueAtTime(note.level,at+(note.attack??.025));
 envelope.gain.exponentialRampToValueAtTime(.0001,end);
 oscillator.connect(envelope);envelope.connect(audio.destination);
 oscillator.start(at);oscillator.stop(end+.01);
 oscillator.onended=()=>{oscillator.disconnect();envelope.disconnect();};
}

function playRadioStatic(audio:BaseAudioContext,start:number){
 const buffer=audio.createBuffer(1,Math.ceil(audio.sampleRate*.29),audio.sampleRate);
 const samples=buffer.getChannelData(0);
 for(let i=0;i<samples.length;i++)samples[i]=Math.random()*2-1;

 const source=audio.createBufferSource(),band=audio.createBiquadFilter(),envelope=audio.createGain();
 source.buffer=buffer;band.type='bandpass';band.frequency.value=1670;band.Q.value=1.1;
 envelope.gain.setValueAtTime(.0001,start);
 envelope.gain.exponentialRampToValueAtTime(.17,start+.009);
 envelope.gain.exponentialRampToValueAtTime(.0001,start+.065);
 envelope.gain.setValueAtTime(.0001,start+.203);
 envelope.gain.exponentialRampToValueAtTime(.14,start+.217);
 envelope.gain.exponentialRampToValueAtTime(.0001,start+.286);
 source.connect(band);band.connect(envelope);envelope.connect(audio.destination);
 source.start(start);
 source.onended=()=>{source.disconnect();band.disconnect();envelope.disconnect();};
}

export function playTone(audio:BaseAudioContext,tone:NotificationTone){
 const start=audio.currentTime;
 if(tone==='radio')playRadioStatic(audio,start);
 for(const note of melodies[tone])playNote(audio,start,note);
}
