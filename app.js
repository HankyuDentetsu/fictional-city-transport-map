(() => {
  const svg = document.querySelector('#mapSvg');
  const content = document.querySelector('#mapContent');
  const preview = document.querySelector('#previewLayer');
  const viewport = document.querySelector('#mapViewport');
  const $ = s => document.querySelector(s);
  const el = (name, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', name); Object.entries(attrs).forEach(([k,v]) => n.setAttribute(k, v)); return n; };
  const defaults = { road:{ color:'#506c79', width:16, name:'', elevation:'ground', roadClass:'primary' }, bus:{ color:'#2d8a57', width:6, name:'', lineStyle:'solid' }, metro:{ color:'#d14f51', width:8, name:'', lineStyle:'solid' }, station:{ color:'#d14f51', name:'' }, building:{ color:'#b7a58d', name:'' }, area:{ color:'#74a989', name:'' }, label:{ color:'#18394a', name:'', size:22 } };
  const roadClassStyles={expressway:{width:22,color:'#385d70'},primary:{width:16,color:'#506c79'},secondary:{width:11,color:'#6e7d82'},local:{width:6,color:'#899397'}};
  let data = { title:'新曙光市', roads:[], buses:[], metros:[], stations:[], buildings:[], areas:[], labels:[] };
  let tool = 'select', selected = null, draft = null, drawMode = 'line', drawLevel = 0, view = { x:0, y:0, w:1600, h:1000 }, panning = null;
  const ids = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
  const pointString = points => points.map(p => `${p.x},${p.y}`).join(' ');
  const midpoint = pts => pts[Math.floor(pts.length / 2)];
  const visible = k => document.querySelector(`[data-layer="${k}"]`).checked;

  function render() {
    content.replaceChildren();
    ['areas','buildings'].forEach(kind=>{if(visible(kind))data[kind].forEach(o=>content.append(renderObject(kind,o)));});
    const levels=[...new Set([
      ...(visible('roads')?data.roads.flatMap(o=>o.points.slice(0,-1).map((_,i)=>segmentLevel(o,i))):[]),
      ...(visible('metros')?data.metros.flatMap(o=>o.points.slice(0,-1).map((_,i)=>segmentLevel(o,i))):[])
    ])].sort((a,b)=>a-b);
    levels.forEach(level=>{
      if(visible('roads'))data.roads.forEach(road=>road.points.slice(0,-1).forEach((_,i)=>{if(segmentLevel(road,i)===level)content.append(renderRoadSegment(road,i));}));
      if(visible('metros'))data.metros.forEach(metro=>metro.points.slice(0,-1).forEach((_,i)=>{if(segmentLevel(metro,i)===level)content.append(renderMetroSegment(metro,i));}));
    });
    if (visible('roads')) {
      const markers=el('g',{class:'crossing-markers'}); appendCrossingMarkers(markers); content.append(markers);
      data.roads.forEach(road=>{if(road.name)content.append(renderRoadLabels(road));});
    }
    if(visible('buses')) data.buses.forEach(o=>content.append(renderObject('buses',o)));
    if(visible('metros'))data.metros.forEach(o=>{if(o.name)content.append(renderTransitLabel('metros',o));});
    ['stations','labels'].forEach(kind => { if (visible(kind)) data[kind].forEach(o => content.append(renderObject(kind, o))); });
    $('#roadCount').textContent = data.roads.length; $('#busCount').textContent = data.buses.length; $('#metroCount').textContent = data.metros.length; $('#stationCount').textContent = data.stations.length; $('#buildingCount').textContent=data.buildings.length;$('#areaCount').textContent=data.areas.length;$('#labelCount').textContent = data.labels.length;
    $('#emptyTip').style.display = Object.values(data).slice(1).some(v => v.length) ? 'none' : 'block';
    if (selected) drawSelected(selected);
  }
  function renderObject(kind, o) {
    const g = el('g', { class:'map-object', 'data-kind':kind, 'data-id':o.id });
    if (kind === 'buses') {
      const pathData=geometryPath(o.points,o);
      const line = el('polyline',{class:'bus-line transit-line',points:pointString(o.points),stroke:o.color,'stroke-width':o.width});
      if (o.lineStyle === 'dash') line.setAttribute('stroke-dasharray', `${o.width * 2.2} ${o.width * 1.4}`);
      g.append(line);
      if (o.name) { const p = midpoint(o.points); const t=el('text', { class:'object-label road-label', x:p.x + 10, y:p.y - 10, 'text-anchor':'middle' }); t.textContent=o.name; g.append(t); }
    } else if (kind === 'stations') {
      g.append(el('circle', { class:'station-ring', cx:o.x, cy:o.y, r:8 })); g.append(el('circle', { class:'station-dot', cx:o.x, cy:o.y, r:8, stroke:o.color }));
      if (o.name) { const t = el('text', { class:'object-label station-label', x:o.x + 13, y:o.y - 12 }); t.textContent=o.name; g.append(t); }
    } else if(kind==='buildings'||kind==='areas'){g.append(el('polygon',{class:kind==='buildings'?'building-shape':'area-shape',points:pointString(o.points),fill:o.color}));if(o.name){const p=polygonCenter(o.points),t=el('text',{class:'polygon-label',x:p.x,y:p.y,'text-anchor':'middle'});t.textContent=o.name;g.append(t);}}
    else { const t = el('text', { class:'object-label place-label', x:o.x, y:o.y, fill:o.color, 'font-size':o.size }); t.textContent=o.name; g.append(t); }
    return g;
  }
  function segmentPath(o,i) { const p0=o.points[i-1]||o.points[i],p1=o.points[i],p2=o.points[i+1],p3=o.points[i+2]||p2;if(segmentMode(o,i)==='curve')return `M ${p1.x} ${p1.y} C ${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6}, ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6}, ${p2.x} ${p2.y}`;return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`; }
  function renderRoadSegment(road,index) { const level=segmentLevel(road,index),g=el('g',{class:'map-object','data-kind':'roads','data-id':road.id}),d=segmentPath(road,index),roadClass=level<0?' road-tunnel':level>0?' road-bridge':'';if(level>0)g.append(el('path',{class:'bridge-casing',d,'stroke-width':road.width+8}));g.append(el('path',{class:`road-line${roadClass}`,d,stroke:road.color,'stroke-width':road.width}));return g; }
  function renderMetroSegment(metro,index) { const level=segmentLevel(metro,index),g=el('g',{class:'map-object','data-kind':'metros','data-id':metro.id}),d=segmentPath(metro,index),klass=level<0?' metro-tunnel':'';if(level>0)g.append(el('path',{class:'metro-elevated-casing',d,'stroke-width':metro.width+6}));g.append(el('path',{class:`metro-line transit-line${klass}`,d,stroke:metro.color,'stroke-width':metro.width}));return g; }
  function renderTransitLabel(kind,o){const g=el('g',{class:'map-object','data-kind':kind,'data-id':o.id}),p=midpoint(o.points),t=el('text',{class:'object-label road-label',x:p.x+10,y:p.y-10,'text-anchor':'middle'});t.textContent=o.name;g.append(t);return g;}
  function polygonCenter(points){return{x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};}
  function renderRoadLabels(road){const g=el('g',{class:'map-object','data-kind':'roads','data-id':road.id}),segments=roadRoutingSegments(road).map(s=>({...s,length:Math.hypot(s.b.x-s.a.x,s.b.y-s.a.y)})),total=segments.reduce((sum,s)=>sum+s.length,0);if(!total)return g;const count=Math.max(1,Math.round(total/260)),step=total/count;for(let n=0;n<count;n++){let target=step*(n+.5),passed=0,segment=segments.at(-1);for(const s of segments){if(target<=passed+s.length){segment=s;break;}passed+=s.length;}const ratio=Math.max(0,Math.min(1,(target-passed)/segment.length)),dx=segment.b.x-segment.a.x,dy=segment.b.y-segment.a.y,len=segment.length,angleRaw=Math.atan2(dy,dx)*180/Math.PI,angle=angleRaw>90?angleRaw-180:angleRaw<-90?angleRaw+180:angleRaw,nx=-dy/len,ny=dx/len,sign=ny>0?-1:1,offset=road.width/2+13,x=segment.a.x+dx*ratio+nx*offset*sign,y=segment.a.y+dy*ratio+ny*offset*sign,t=el('text',{class:'object-label road-label',x,y,'text-anchor':'middle',transform:`rotate(${angle} ${x} ${y})`});t.textContent=road.name;g.append(t);}return g;}
  function segmentMode(o,index) { return o.segmentModes?.[index] || (o.curved ? 'curve' : 'line'); }
  function legacyLevel(elevation) { return elevation==='bridge'?1:elevation==='tunnel'?-1:0; }
  function segmentLevel(o,index) { return Number.isFinite(o.segmentLevels?.[index]) ? o.segmentLevels[index] : legacyLevel(o.elevation); }
  function geometryPath(points,o={}) { if(!points.length)return '';let d=`M ${points[0].x} ${points[0].y}`;for(let i=0;i<points.length-1;i++){const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;if(segmentMode(o,i)==='curve')d+=` C ${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6}, ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6}, ${p2.x} ${p2.y}`;else d+=` L ${p2.x} ${p2.y}`;}return d; }
  function curvePoint(points, index, t) { const p0=points[index-1] || points[index],p1=points[index],p2=points[index+1],p3=points[index+2] || p2,u=1-t,c1={x:p1.x+(p2.x-p0.x)/6,y:p1.y+(p2.y-p0.y)/6},c2={x:p2.x-(p3.x-p1.x)/6,y:p2.y-(p3.y-p1.y)/6}; return {x:u*u*u*p1.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*p2.x,y:u*u*u*p1.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*p2.y}; }
  function roadRoutingSegments(road) { const segments=[];for(let i=0;i<road.points.length-1;i++){const level=segmentLevel(road,i);if(segmentMode(road,i)==='curve'){let a=curvePoint(road.points,i,0);for(let step=1;step<=12;step++){const b=curvePoint(road.points,i,step/12);segments.push({road,sourceIndex:i,a,b,level});a=b;}}else segments.push({road,sourceIndex:i,a:road.points[i],b:road.points[i+1],level});}return segments; }
  function segmentCrossing(a, b, c, d) {
    const abx=b.x-a.x, aby=b.y-a.y, cdx=d.x-c.x, cdy=d.y-c.y, denom=abx*cdy-aby*cdx;
    if (Math.abs(denom)<0.001) return null;
    const acx=c.x-a.x, acy=c.y-a.y, t=(acx*cdy-acy*cdx)/denom, u=(acx*aby-acy*abx)/denom;
    return t>0.025 && t<0.975 && u>0.025 && u<0.975 ? {x:a.x+t*abx,y:a.y+t*aby,segment:{a,b}} : null;
  }
  function addCrossingMarker(layer, road, hit, type) {
    const dx=hit.segment.b.x-hit.segment.a.x,dy=hit.segment.b.y-hit.segment.a.y,len=Math.hypot(dx,dy);
    if (!len) return;
    const ux=dx/len,uy=dy/len,nx=-uy,ny=ux,offset=Math.max(road.width*1.15,13),half=road.width/2+4;
    [-offset,offset].forEach(step=>{const x=hit.x+ux*step,y=hit.y+uy*step;layer.append(el('line',{class:`crossing-marker ${type}-marker`,x1:x-nx*half,y1:y-ny*half,x2:x+nx*half,y2:y+ny*half,stroke:road.color}));});
  }
  function appendCrossingMarkers(layer) {
    const segments=data.roads.flatMap(roadRoutingSegments);
    for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){const a=segments[i],b=segments[j];if(a.road===b.road||a.level===b.level)continue;const hit=segmentCrossing(a.a,a.b,b.a,b.b);if(!hit)continue;const upper=a.level>b.level?a:b,lower=upper===a?b:a,upperHit={...hit,segment:{a:upper.a,b:upper.b}},lowerHit={...hit,segment:{a:lower.a,b:lower.b}};if(upper.level>0)addCrossingMarker(layer,upper.road,upperHit,'bridge');if(lower.level<0)addCrossingMarker(layer,lower.road,lowerHit,'tunnel');}
  }
  function drawSelected(item) {
    const { kind, obj } = item; let shape;
    if (kind === 'roads' || kind === 'metros') shape = el('path', { class:'selected-outline', d:geometryPath(obj.points,obj) });
    else if (kind === 'buses') shape = el('polyline', { class:'selected-outline', points:pointString(obj.points) });
    else if (kind === 'buildings' || kind === 'areas') shape = el('polygon', { class:'selected-outline', points:pointString(obj.points) });
    else if (kind === 'stations') shape = el('circle', { class:'selected-outline', cx:obj.x, cy:obj.y, r:15 });
    else shape = el('rect', { class:'selected-outline', x:obj.x - 7, y:obj.y - obj.size, width:Math.max(28, obj.name.length * obj.size * .65), height:obj.size + 10 });
    content.append(shape);
  }
  function toMap(e) {
    const p = svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY; const q=p.matrixTransform(svg.getScreenCTM().inverse()); return { x:Math.round(q.x), y:Math.round(q.y) };
  }
  function setTool(name) {
    tool = name; draft = null; preview.replaceChildren(); selected = null; document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    viewport.classList.toggle('drawing', !['select'].includes(name));
    $('#drawModeControl').hidden=!['road','metro'].includes(name);
    $('#levelControl').hidden=!['road','bus','metro'].includes(name);$('#levelControlTitle').textContent=name==='bus'?'选路层级':'下一段层级';
    const text = {select:'选择：单击对象进行编辑，拖动空白处平移',road:'道路：逐段设置直曲与层级，右键结束',bus:'公交：用 ↑↓ 选择交叉处道路层级，右键结束',metro:'地铁：逐段设置直曲与层级；冲突段会被阻止',station:'站点：只能点击地铁线，在线路上插站',building:'建筑：逐点绘制轮廓，右键闭合',area:'区域：逐点绘制边界，右键闭合',label:'文字：单击地图后输入地名或路名',eraser:'删除：单击要删除的对象'};
    $('#toolStatus').textContent=text[name]; loadInspector(null);
  }
  function setDrawMode(mode) { drawMode=mode; document.querySelectorAll('[data-draw-mode]').forEach(b=>b.classList.toggle('active',b.dataset.drawMode===mode)); $('#toolStatus').textContent=`${tool==='road'?'道路':'地铁'}：下一段为${mode==='curve'?'曲线':'直线'}，层级 ${drawLevel>0?'+':''}${drawLevel}`; }
  function setDrawLevel(level) { drawLevel=Math.max(-5,Math.min(5,level));$('#drawLevelValue').textContent=drawLevel===0?'地面 0':drawLevel>0?`上跨 +${drawLevel}`:`下钻 ${drawLevel}`;if(['road','metro'].includes(tool))$('#toolStatus').textContent=`${tool==='road'?'道路':'地铁'}：下一段为${drawMode==='curve'?'曲线':'直线'}，层级 ${drawLevel>0?'+':''}${drawLevel}`;else if(tool==='bus')$('#toolStatus').textContent=`公交：当前选择道路层级 ${drawLevel>0?'+':''}${drawLevel}`; }
  function findObject(kind, id) { return data[kind].find(x => x.id === id); }
  function selectObject(kind, id) { const obj=findObject(kind,id); if (!obj) return; selected={kind,obj}; loadInspector(obj); render(); }
  function loadInspector(o) { const d=o || defaults[tool] || defaults.road; $('#objectName').value=d.name || ''; $('#objectColor').value=d.color || '#18394a'; $('#objectWidth').value=d.width || 10; $('#widthValue').value=d.width || 10; $('#roadClass').value=d.roadClass||'primary'; $('#lineStyle').value=d.lineStyle || 'solid'; $('#labelSize').value=d.size || 22; $('#labelSizeValue').value=d.size || 22; $('#widthControl').style.display = ['roads','buses','metros'].includes(selected?.kind) || ['road','bus','metro'].includes(tool) ? '' : 'none'; $('#roadClassControl').style.display=selected?.kind==='roads'||tool==='road'?'':'none';$('#lineStyleControl').style.display = ['buses','metros'].includes(selected?.kind) || ['bus','metro'].includes(tool) ? '' : 'none'; $('#labelSizeControl').style.display = selected?.kind === 'labels' || tool === 'label' ? '' : 'none'; $('#applyStyle').disabled=!selected; }
  function finishDraft() {
    const polygon=['building','area'].includes(tool),minimum=polygon?3:2;if(!draft||draft.points.length<minimum){draft=null;preview.replaceChildren();return;}
    const type=tool==='road'?'roads':tool==='bus'?'buses':tool==='metro'?'metros':tool==='building'?'buildings':'areas';
    let obj;if(polygon)obj={id:ids(),points:draft.points,...defaults[tool],color:$('#objectColor').value};else obj={id:ids(),points:draft.points,segmentModes:draft.segmentModes||[],segmentLevels:['road','metro'].includes(tool)?(draft.segmentLevels||[]):undefined,...defaults[tool],color:$('#objectColor').value,width:+$('#objectWidth').value,lineStyle:$('#lineStyle').value,...(tool==='road'?{roadClass:$('#roadClass').value}:{})};
    data[type].push(obj);draft=null;preview.replaceChildren();
    if(tool==='road'||polygon){const label=tool==='road'?'道路名称':tool==='building'?'建筑名称':'区域名称',name=window.prompt(`请输入${label}（也可稍后修改）`,'');if(name!==null)obj.name=name.trim();}
    selectObject(type,obj.id);render();loadInspector(obj);saveLocal(false);toast(polygon?'区域对象已添加':tool==='road'?'道路已添加；层级变化段将作为匝道连接':'线路已添加');
  }
  function addDraftPoint(point) { if(!draft)draft={points:[point],segmentModes:[],segmentLevels:[]};else{draft.points.push(point);draft.segmentModes.push(drawMode);if(['road','metro'].includes(tool))draft.segmentLevels.push(drawLevel);} }
  function previewDraft(pointer) { preview.replaceChildren(); if (!draft) return; let pts=[...draft.points,pointer],modes=[...(draft.segmentModes||[]),drawMode];if(['building','area'].includes(tool)){preview.append(el('polygon',{class:'preview',points:pointString(pts)}));}else if(tool==='bus'){const snap=snapToRoad(pointer,drawLevel),route=snap&&routeAlongRoads(draft.anchor,snap);pts=route?[...draft.points,...route.slice(1)]:draft.points;preview.append(el('polyline',{class:'preview',points:pointString(pts)}));}else preview.append(el('path',{class:'preview',d:geometryPath(pts,{segmentModes:modes})}));draft.points.forEach(p=>preview.append(el('circle',{class:'node',cx:p.x,cy:p.y,r:5}))); }
  const pointKey=(p,level=p.level??'')=>`${level}:${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  function snapToRoad(p, preferredLevel=null) { let best=null;data.roads.forEach(road=>roadRoutingSegments(road).forEach((segment,index)=>{if(preferredLevel!==null&&segment.level!==preferredLevel)return;const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+t*dx,y=a.y+t*dy,distance=Math.hypot(p.x-x,p.y-y);if(!best||distance<best.distance)best={road,segment:index,sourceIndex:segment.sourceIndex,level:segment.level,t,x,y,distance};}));const threshold=view.w/svg.getBoundingClientRect().width*20;return best&&best.distance<=threshold?best:null; }
  function snapToLine(p, line) { let best=null; const test=(a,b,segment)=>{const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+t*dx,y=a.y+t*dy,distance=Math.hypot(p.x-x,p.y-y);if(!best||distance<best.distance)best={x,y,segment,distance};}; for(let i=0;i<line.points.length-1;i++){if(segmentMode(line,i)==='curve'){let a=curvePoint(line.points,i,0);for(let step=1;step<=16;step++){const b=curvePoint(line.points,i,step/16);test(a,b,i);a=b;}}else test(line.points[i],line.points[i+1],i);}return best; }
  function inclusiveCrossing(a,b,c,d){const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,den=rx*sy-ry*sx;if(Math.abs(den)<.001)return null;const qx=c.x-a.x,qy=c.y-a.y,t=(qx*sy-qy*sx)/den,u=(qx*ry-qy*rx)/den;return t>=-.001&&t<=1.001&&u>=-.001&&u<=1.001?{x:a.x+t*rx,y:a.y+t*ry}:null;}
  function pointSegmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)):0;return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));}
  function geometryConflict(a,b){const crossing=inclusiveCrossing(a.a,a.b,b.a,b.b);if(crossing)return crossing;const checks=[{p:a.a,d:pointSegmentDistance(a.a,b.a,b.b)},{p:a.b,d:pointSegmentDistance(a.b,b.a,b.b)},{p:b.a,d:pointSegmentDistance(b.a,a.a,a.b)},{p:b.b,d:pointSegmentDistance(b.b,a.a,a.b)}].sort((x,y)=>x.d-y.d);return checks[0].d<1.5?checks[0].p:null;}
  function isStationPoint(p){return data.stations.some(s=>Math.hypot(s.x-p.x,s.y-p.y)<8);}
  function validateNewSegment(kind,point){if(!draft||!draft.points.length)return null;const tempIndex=draft.points.length-1,temp={points:[...draft.points,point],segmentModes:[...(draft.segmentModes||[]),drawMode],segmentLevels:[...(draft.segmentLevels||[]),drawLevel]},candidates=roadRoutingSegments(temp).filter(s=>s.sourceIndex===tempIndex);if(kind==='metro'){
      if(drawLevel===0){const roads=data.roads.flatMap(roadRoutingSegments).filter(s=>s.level===0);for(const candidate of candidates)for(const road of roads)if(geometryConflict(candidate,road))return '地面层地铁不能与地面道路交叉';}
      const metros=data.metros.flatMap(roadRoutingSegments).filter(s=>s.level===drawLevel);for(const candidate of candidates)for(const metro of metros){const hit=geometryConflict(candidate,metro);if(hit&&!isStationPoint(hit))return `层级 ${drawLevel>0?'+':''}${drawLevel} 的地铁发生交叉；请通过既有站点接入`;}
      const own=roadRoutingSegments(temp).filter(s=>s.sourceIndex<tempIndex-1&&s.level===drawLevel);for(const candidate of candidates)for(const segment of own){const hit=geometryConflict(candidate,segment);if(hit&&!isStationPoint(hit))return '同一条地铁线路不能在同层自相交';}
    }else if(kind==='road'&&drawLevel===0){const metros=data.metros.flatMap(roadRoutingSegments).filter(s=>s.level===0);for(const candidate of candidates)for(const metro of metros)if(geometryConflict(candidate,metro))return '地面道路不能与地面层地铁交叉';}
    return null;}
  function routeAlongRoads(from, to) {
    if (!from || !to) return null;
    const stops=new Map(),nodes=new Map(),edges=new Map(),joins=[],routes=new Map();data.roads.forEach(road=>routes.set(road.id,roadRoutingSegments(road)));
    const segmentKey=(road,index)=>`${road.id}:${index}`;
    const addStop=(road,index,p)=>{const segment=routes.get(road.id)?.[index];if(!segment)return;const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?((p.x-a.x)*dx+(p.y-a.y)*dy)/len2:0,key=segmentKey(road,index);if(!stops.has(key))stops.set(key,[]);stops.get(key).push({t,p:{x:p.x,y:p.y,level:segment.level}});};
    data.roads.forEach(road=>{const segments=routes.get(road.id);segments.forEach((segment,index)=>{addStop(road,index,segment.a);addStop(road,index,segment.b);if(index&&segments[index-1].level!==segment.level&&Math.hypot(segments[index-1].b.x-segment.a.x,segments[index-1].b.y-segment.a.y)<.1)joins.push([{...segment.a,level:segments[index-1].level},{...segment.a,level:segment.level}]);});});
    const allSegments=data.roads.flatMap(road=>routes.get(road.id).map((segment,index)=>({...segment,index})));
    for(let i=0;i<allSegments.length;i++)for(let j=i+1;j<allSegments.length;j++){const a=allSegments[i],b=allSegments[j];if(a.road===b.road||a.level!==b.level)continue;const hit=segmentCrossing(a.a,a.b,b.a,b.b);if(hit){addStop(a.road,a.index,hit);addStop(b.road,b.index,hit);}}
    const junctionTolerance=view.w/svg.getBoundingClientRect().width*20;
    data.roads.forEach(road=>road.points.forEach((p,pointIndex)=>{
      const levels=[...new Set([pointIndex>0?segmentLevel(road,pointIndex-1):null,pointIndex<road.points.length-1?segmentLevel(road,pointIndex):null].filter(v=>v!==null))];
      levels.forEach(level=>allSegments.forEach(segment=>{
        if(segment.road===road||segment.level!==level)return;
        const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;
        const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+t*dx,y=a.y+t*dy;
        if(Math.hypot(p.x-x,p.y-y)<=junctionTolerance){addStop(segment.road,segment.index,{x,y});joins.push([{x:p.x,y:p.y,level},{x,y,level}]);}
      }));
    }));
    addStop(from.road,from.segment,from);addStop(to.road,to.segment,to);
    const addNode=p=>{const key=pointKey(p);if(!nodes.has(key))nodes.set(key,{x:p.x,y:p.y,level:p.level});if(!edges.has(key))edges.set(key,[]);return key;};
    const connect=(a,b)=>{const ak=addNode(a),bk=addNode(b),cost=Math.hypot(a.x-b.x,a.y-b.y);edges.get(ak).push({key:bk,cost});edges.get(bk).push({key:ak,cost});};
    stops.forEach(list=>{list.sort((a,b)=>a.t-b.t);for(let i=0;i<list.length-1;i++)connect(list[i].p,list[i+1].p);});joins.forEach(([a,b])=>connect(a,b));
    const start=pointKey(from,from.level), end=pointKey(to,to.level), dist=new Map([[start,0]]), prev=new Map(), remaining=new Set(nodes.keys());
    while(remaining.size){let current=null,best=Infinity;remaining.forEach(key=>{const value=dist.get(key)??Infinity;if(value<best){best=value;current=key;}});if(!current||current===end)break;remaining.delete(current);edges.get(current).forEach(({key,cost})=>{if(!remaining.has(key))return;const next=best+cost;if(next<(dist.get(key)??Infinity)){dist.set(key,next);prev.set(key,current);}});}
    if(!dist.has(end))return null;const path=[];for(let key=end;key;key=prev.get(key)){path.unshift(nodes.get(key));if(key===start)break;}return path[0]&&pointKey(path[0])===start?path:null;
  }
  function createPointObject(kind, p, line=null) { if(kind==='stations'&&!line){toast('请点击既有地铁线来新增站点');return;} const snap=kind==='stations' ? snapToLine(p,line) : null; if(snap)p={x:snap.x,y:snap.y}; const label=kind === 'stations' ? '站点名称' : '地名或路名'; const name=window.prompt(`请输入${label}`, kind === 'stations' ? '新城站' : '中央广场'); if (name === null) return; const d=kind === 'stations' ? defaults.station : defaults.label; const obj={id:ids(),x:p.x,y:p.y,...d,name:name.trim() || (kind === 'stations'?'未命名站':'未命名'),...(snap?{level:segmentLevel(line,snap.segment),lineId:line.id,segmentIndex:snap.segment}:{})}; data[kind].push(obj); selectObject(kind,obj.id); render(); saveLocal(false); }
  function hit(e) { const node=e.target.closest?.('[data-kind]'); return node ? {kind:node.dataset.kind,id:node.dataset.id} : null; }
  svg.addEventListener('click', e => { if (panning?.moved) return; const target=hit(e), p=toMap(e);
    if (tool === 'select') { if (target) selectObject(target.kind,target.id); else { selected=null; render(); loadInspector(null); } return; }
    if (tool === 'eraser') { if (target) { data[target.kind]=data[target.kind].filter(o=>o.id!==target.id); selected=null; render(); saveLocal(false); toast('对象已删除'); } return; }
    if (tool === 'station') return createPointObject('stations',p,target?.kind==='metros'?findObject('metros',target.id):null); if (tool === 'label') return createPointObject('labels',p);
    if (tool === 'bus') { const snap=snapToRoad(p,drawLevel); if (!snap) { toast(`当前附近没有层级 ${drawLevel>0?'+':''}${drawLevel} 的道路`); return; } if (!draft) { draft={points:[{x:snap.x,y:snap.y,level:snap.level}],anchor:snap}; previewDraft(snap); return; } const route=routeAlongRoads(draft.anchor,snap); if (!route) { toast('两处道路未通过同层路口或匝道连通'); return; } draft.points.push(...route.slice(1)); draft.anchor=snap; previewDraft(snap); return; }
    if (tool==='metro') { const station=target?.kind==='stations'?findObject('stations',target.id):null,point=station?{x:station.x,y:station.y}:p,conflict=validateNewSegment('metro',point);if(conflict){toast(conflict);return;}addDraftPoint(point);previewDraft(point);return; }
    if (tool==='road') { const snap=snapToRoad(p,drawLevel),point=snap?{x:snap.x,y:snap.y}:p,conflict=validateNewSegment('road',point);if(conflict){toast(conflict);return;}addDraftPoint(point);previewDraft(point);return; }
    if(['building','area'].includes(tool)){if(!draft)draft={points:[p]};else draft.points.push(p);previewDraft(p);}
  });
  svg.addEventListener('contextmenu', e => { if (['road','bus','metro','building','area'].includes(tool)) { e.preventDefault(); finishDraft(); } });
  svg.addEventListener('pointerdown', e => { const allowPan=tool==='select'||e.button===1; if (!allowPan || hit(e)) return; panning={clientX:e.clientX,clientY:e.clientY,view:{...view},moved:false}; viewport.setPointerCapture?.(e.pointerId); });
  svg.addEventListener('pointermove', e => { const p=toMap(e); if (panning) { const box=svg.getBoundingClientRect(); const dx=(e.clientX-panning.clientX)*panning.view.w/box.width,dy=(e.clientY-panning.clientY)*panning.view.h/box.height; view.x=panning.view.x-dx;view.y=panning.view.y-dy;svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);panning.moved=true;viewport.classList.add('panning'); } else if (draft) previewDraft(p); });
  svg.addEventListener('pointerup', () => { panning=null; viewport.classList.remove('panning'); });
  viewport.addEventListener('wheel', e => { e.preventDefault(); const p=toMap(e); const factor=e.deltaY>0?1.12:.89; const nw=Math.max(280,Math.min(2600,view.w*factor)),nh=nw/1.6; view.x=p.x-(p.x-view.x)*(nw/view.w);view.y=p.y-(p.y-view.y)*(nh/view.h);view.w=nw;view.h=nh; svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`); $('#zoomStatus').textContent=`${Math.round(160000/view.w)}%`; },{passive:false});
  document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
  document.querySelectorAll('[data-draw-mode]').forEach(b=>b.addEventListener('click',()=>setDrawMode(b.dataset.drawMode)));
  $('#levelUp').addEventListener('click',()=>setDrawLevel(drawLevel+1));$('#levelDown').addEventListener('click',()=>setDrawLevel(drawLevel-1));
  document.addEventListener('keydown',e=>{ if (e.target.matches('input,select')) return; const key=e.key.toLowerCase(),keys={v:'select',r:'road',b:'bus',m:'metro',t:'metro',s:'station',g:'building',a:'area',l:'label',e:'eraser'}; if (keys[key]) setTool(keys[key]); if(['road','metro'].includes(tool)&&key==='c')setDrawMode('curve');if(['road','metro'].includes(tool)&&key==='x')setDrawMode('line');if(['road','bus','metro'].includes(tool)&&e.key==='ArrowUp'){e.preventDefault();setDrawLevel(drawLevel+1);}if(['road','bus','metro'].includes(tool)&&e.key==='ArrowDown'){e.preventDefault();setDrawLevel(drawLevel-1);} if (e.key==='Escape') { draft=null;preview.replaceChildren(); } if ((e.key==='Delete'||e.key==='Backspace')&&selected){data[selected.kind]=data[selected.kind].filter(o=>o.id!==selected.obj.id);selected=null;render();saveLocal(false);} });
  $('#objectWidth').addEventListener('input',e=>$('#widthValue').value=e.target.value); $('#labelSize').addEventListener('input',e=>$('#labelSizeValue').value=e.target.value);
  $('#roadClass').addEventListener('change',e=>{const style=roadClassStyles[e.target.value];if(!style)return;$('#objectWidth').value=style.width;$('#widthValue').value=style.width;$('#objectColor').value=style.color;});
  $('#applyStyle').addEventListener('click',()=>{ if(!selected)return; const o=selected.obj;o.name=$('#objectName').value.trim();o.color=$('#objectColor').value;o.width=+$('#objectWidth').value;o.lineStyle=$('#lineStyle').value;o.size=+$('#labelSize').value;if(selected.kind==='roads')o.roadClass=$('#roadClass').value;render();saveLocal(false);toast('样式已应用'); });
  document.querySelectorAll('[data-layer]').forEach(i=>i.addEventListener('change',render));
  function normalizeMap(v) { if (!v || !['roads','stations','labels'].every(k=>Array.isArray(v[k]))) return null; return { title:v.title || '未命名城市', roads:v.roads, buses:Array.isArray(v.buses)?v.buses:[], metros:Array.isArray(v.metros)?v.metros:(Array.isArray(v.transit)?v.transit:[]), stations:v.stations, buildings:Array.isArray(v.buildings)?v.buildings:[], areas:Array.isArray(v.areas)?v.areas:[], labels:v.labels }; }
  function saveLocal(show=true){ data.title=$('#projectTitle').value.trim()||'未命名城市'; localStorage.setItem('fictional-city-map-v1',JSON.stringify(data));if(show)toast('已保存到此浏览器'); }
  function toast(s){const t=$('#toast');t.textContent=s;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2200);}
  $('#saveMap').addEventListener('click',()=>saveLocal()); $('#projectTitle').addEventListener('change',()=>saveLocal(false));
  $('#newMap').addEventListener('click',()=>{if(!confirm('新建地图会清空当前画布；已保存的本地内容也会被替换。继续吗？'))return;data={title:'新曙光市',roads:[],buses:[],metros:[],stations:[],buildings:[],areas:[],labels:[]};$('#projectTitle').value=data.title;selected=null;render();saveLocal(false);});
  $('#exportMap').addEventListener('click',()=>{saveLocal(false);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=`${data.title||'city-map'}.json`;a.click();URL.revokeObjectURL(a.href);toast('地图 JSON 已导出');});
  $('#importMap').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const v=normalizeMap(JSON.parse(await f.text()));if(!v)throw Error();data=v;$('#projectTitle').value=v.title;selected=null;render();saveLocal(false);toast('地图已导入');}catch{toast('无法读取此地图文件');}e.target.value='';});
  try { const stored=normalizeMap(JSON.parse(localStorage.getItem('fictional-city-map-v1'))); if(stored) { data=stored; $('#projectTitle').value=data.title; } } catch {}
  render(); loadInspector(null);
})();
