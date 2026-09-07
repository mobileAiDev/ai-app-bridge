'use strict';
const PACKAGE = 'io.github.mobileaidev.notallyx.sample';
const PICKER = 'com.coloros.filemanager';
function view(result, route, parseXmlAttributes) {
  if (route === PICKER) {
    if (typeof result !== 'string') throw Error('raw_uia_xml_required');
    const all = [...result.matchAll(/<node\b[^>]*>/g)].map(match => parseXmlAttributes(match[0]));
    if (!all.length || all[0].package !== PICKER) throw Error('picker_foreground_root_required');
    const bounds = value => { const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value); if (!b) throw Error('uia_bounds_required');
      return {left:+b[1],top:+b[2],right:+b[3],bottom:+b[4]}; };
    const viewport = bounds(all[0].bounds);
    return {activity:'com.oplus.filemanager.picker.PickerActivity',viewport,nodes:all.filter(n=>n.package===PICKER&&n.enabled==='true').map(n=>({
      text:n.text,resourceName:n['resource-id'],contentDescription:n['content-desc'],className:n.class,checked:n.checked==='true',bounds:bounds(n.bounds)}))};
  }
  if (route !== PACKAGE || !Array.isArray(result.windows) || !result.windows.length) throw Error('native_foreground_window_required');
  const visible = n => n && n.visible!==false && n.effectiveVisible!==false && n.alpha!==0 && (n.visible===true || n.effectiveVisible===true);
  const window = [...result.windows].reverse().find(w=>visible(w.root));
  if (!window?.root?.bounds) throw Error('native_foreground_bounds_required');
  const nodes=[]; const walk=n=>{if(!visible(n))return;if(n.enabled!==false)nodes.push(n);(n.children||[]).forEach(walk);};walk(window.root);
  return {activity:result.activity,viewport:window.root.bounds,nodes};
}
function find(v, selector) {
  // OPPO's file list inserts line breaks into long labels. Owned fixture names forbid
  // newlines; only these presentation breaks are removed, with uniqueness still required.
  return v.nodes.filter(n=>Object.entries(selector).every(([k,val])=>k==='displayFilename'
    ?typeof n.text==='string'&&!val.includes('\n')&&n.text.replaceAll('\n','')===val:n[k]===val)).filter(n=>{
    const b=n.bounds,p=v.viewport;if(!b)return false;const x=(b.left+b.right)/2,y=(b.top+b.bottom)/2;
    return b.right>b.left&&b.bottom>b.top&&x>=p.left&&x<p.right&&y>=p.top&&y<p.bottom;
  });
}
function key(v) { return JSON.stringify({activity:v.activity,viewport:v.viewport,nodes:v.nodes.map(n=>({text:n.text,resourceName:n.resourceName,
  contentDescription:n.contentDescription,className:n.className,bounds:n.bounds,editable:n.editable,checked:n.checked,alpha:n.alpha}))}); }
function matches(v, expected) { return expected.present.every(s=>find(v,s).length===1)&&(expected.absent||[]).every(s=>find(v,s).length===0); }
module.exports={PACKAGE,PICKER,view,find,key,matches};
