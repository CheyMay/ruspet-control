// Apply saved palettes before React paints. Only the presets below can be selected.
(() => {
 const root=document.documentElement;
 const bases={
  forest:{label:'Лесной',light:['#f1f5f1','#fcfefd','#f5f8f5','#e5eee7','#26382e','#4d6557','#5c7365','#d0ded4','#8fae98'],dark:['#141c19','#1b2621','#19231e','#283a30','#e5eee8','#bfcec3','#9eb2a5','#35473c','#648571']},
  slate:{label:'Серо-синий',light:['#eef3f8','#fbfdff','#f3f7fb','#e0e9f3','#263447','#4e6179','#5d6f85','#ced9e6','#90a6bf'],dark:['#141a23','#1c2633','#18212c','#29384b','#e5edf8','#bdcbe0','#9dadc4','#36485f','#657f9e']},
  sand:{label:'Песочный',light:['#f6f2e9','#fffdf8','#faf6ed','#eee5d5','#3d3427','#6c5d46','#7b694e','#dfd4bf','#b5a07c'],dark:['#211d16','#2b261d','#252117','#3a3225','#f2eadb','#d2c5af','#b9a98c','#514532','#897352']},
  lavender:{label:'Лавандовый',light:['#f2eff8','#fdfbff','#f7f3fc','#e9e1f4','#393047','#645574','#746382','#dcd1e8','#aa95c0'],dark:['#1d1824','#282131','#221b2a','#362c43','#eee6f7','#cfc0de','#b3a1c5','#4b3c5a','#826a99']},
  rose:{label:'Розовый',light:['#f9eff2','#fffbfc','#fcf4f6','#f1dfe6','#452f38','#775461','#855e6c','#e8cfd9','#be93a4'],dark:['#23191e','#30232b','#291e25','#402d37','#f6e6ed','#dcc1cc','#c1a0ad','#573d49','#956a7c']},
  neutral:{label:'Нейтральный',light:['#f2f3f4','#ffffff','#f6f7f8','#e7e9ec','#29313b','#535f6e','#626e7c','#d4d9df','#9aa5b3'],dark:['#17191d','#22252b','#1c1f24','#30353e','#eceff4','#c5ccd7','#a8b2c1','#414854','#748094']}
 };
 const accents={
  green:{label:'Хвойный',light:['#1d5143','#285347','#438572'],dark:['#90c8a4','#345f49','#a7d6b8']},
  blue:{label:'Синий',light:['#285f92','#204d78','#407aa9'],dark:['#a2cdf1','#315477','#93c5ef']},
  plum:{label:'Сливовый',light:['#704468','#603458','#95658b'],dark:['#e2b7d9','#633b5c','#dcb1d4']},
  graphite:{label:'Графитовый',light:['#445463','#364452','#60758a'],dark:['#c0cddd','#435569','#b8cadd']},
  teal:{label:'Бирюзовый',light:['#11666b','#15565d','#32858a'],dark:['#8cd8d2','#235f62','#a3e0db']},
  amber:{label:'Янтарный',light:['#805000','#805000','#9a6610'],dark:['#edc577','#76541c','#efce91']},
  rose:{label:'Малиновый',light:['#99435e','#8e3e57','#ad5c77'],dark:['#efb0c4','#813d56','#f2c1d1']},
  indigo:{label:'Индиго',light:['#504ca4','#4a4694','#7771bc'],dark:['#bcb7ff','#4e4785','#cecaff']}
 };
 const baseVars=['background','surface','surface-soft','surface-raised','text','text-secondary','text-muted','border','border-strong'];
 const accentVars=['accent','accent-solid','focus'];
 const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
 const save=(key,value)=>{try{localStorage.setItem(key,value);}catch{/* Keep the selection for this tab. */}};
 const valid=(catalog,id,fallback)=>Object.hasOwn(catalog,id)?id:fallback;
 let theme=read('ruspet-theme')==='dark'?'dark':'light';
 const preferences={};
 function load(){
  const legacy=valid(accents,read('ruspet-accent'),'green');
  for(const mode of ['light','dark'])preferences[mode]={base:valid(bases,read('ruspet-base-'+mode),'forest'),accent:valid(accents,read('ruspet-accent-'+mode),legacy)};
 }
 function apply(){
  const {base,accent}=preferences[theme],baseValues=bases[base][theme],accentValues=accents[accent][theme];
  root.dataset.theme=theme;root.dataset.base=base;root.dataset.accent=accent;
  baseVars.forEach((key,i)=>root.style.setProperty('--theme-'+key,baseValues[i]));
  accentVars.forEach((key,i)=>root.style.setProperty('--theme-'+key,accentValues[i]));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',baseValues[0]);
  window.dispatchEvent(new Event('ruspet-appearance-change'));
 }
 window.ruspetAppearance={
  bases:Object.entries(bases).map(([id,p])=>({id,label:p.label,light:p.light.slice(0,4),dark:p.dark.slice(0,4)})),
  accents:Object.entries(accents).map(([id,p])=>({id,label:p.label,light:p.light[1],dark:p.dark[0]})),
  getSnapshot:()=>[theme,preferences[theme].base,preferences[theme].accent].join(':'),
  subscribe:listener=>{window.addEventListener('ruspet-appearance-change',listener);return()=>window.removeEventListener('ruspet-appearance-change',listener);},
  setTheme:mode=>{if(!['light','dark'].includes(mode))return;theme=mode;save('ruspet-theme',theme);apply();},
  setBase:id=>{if(!Object.hasOwn(bases,id))return;preferences[theme].base=id;save('ruspet-base-'+theme,id);apply();},
  setAccent:id=>{if(!Object.hasOwn(accents,id))return;preferences[theme].accent=id;save('ruspet-accent-'+theme,id);apply();}
 };
 load();apply();
 window.addEventListener('storage',event=>{
  if(event.key!==null&&!['ruspet-theme','ruspet-accent','ruspet-base-light','ruspet-base-dark','ruspet-accent-light','ruspet-accent-dark'].includes(event.key))return;
  theme=read('ruspet-theme')==='dark'?'dark':'light';load();apply();
 });
})();
