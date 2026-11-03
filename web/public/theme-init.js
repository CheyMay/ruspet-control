// Run before rendering to avoid a light flash for returning dark-theme users.
try {
 const saved=localStorage.getItem('ruspet-theme');
 const theme=saved==='dark'||saved==='light'?saved:'light';
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#141c19':'#f5f6f5');
} catch {
 document.documentElement.dataset.theme='light';
}
window.addEventListener('storage',event=>{
 if(event.key!=='ruspet-theme')return;
 const theme=event.newValue==='dark'?'dark':'light';
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#141c19':'#f5f6f5');
});
