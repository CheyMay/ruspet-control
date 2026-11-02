export function CapMark({loading=false}:{loading?:boolean}){
 return <span className={`cap-mark${loading?' cap-loading':''}`} aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="M9 18c0-6 30-6 30 0v15c0 7-30 7-30 0Z" fill="currentColor" opacity=".18"/><ellipse cx="24" cy="18" rx="15" ry="6" stroke="currentColor" strokeWidth="2"/><path d="M9 19v14c0 7 30 7 30 0V19M10 30c4 6 24 6 28 0M15 23v7m6-5v7m6-7v7m6-9v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></span>;
}
