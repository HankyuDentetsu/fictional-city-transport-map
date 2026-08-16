(() => {
  const svg = document.querySelector('#mapSvg');
  const content = document.querySelector('#mapContent');
  const selectionLayer = document.querySelector('#selectionLayer');
  const preview = document.querySelector('#previewLayer');
  const viewport = document.querySelector('#mapViewport');
  const $ = s => document.querySelector(s);
  const el = (name, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', name); Object.entries(attrs).forEach(([k,v]) => n.setAttribute(k, v)); return n; };
  const defaults = { road:{ color:'#506c79', width:16, name:'', elevation:'ground', roadClass:'primary' }, bus:{ color:'#2d8a57', width:6, name:'', lineStyle:'solid', labelColor:'#2d8a57', labelTextColor:'#ffffff', labelShape:'pill', labelSize:16 }, metro:{ color:'#d14f51', width:8, name:'', lineStyle:'solid', labelColor:'#d14f51', labelTextColor:'#ffffff', labelShape:'pill', labelSize:16 }, station:{ color:'#d14f51', name:'' }, building:{ color:'#b7a58d', name:'' }, area:{ color:'#74a989', name:'' }, label:{ color:'#18394a', name:'', size:22 } };
  const roadClassStyles={expressway:{width:22,color:'#385d70'},primary:{width:16,color:'#506c79'},secondary:{width:11,color:'#6e7d82'},local:{width:6,color:'#899397'}};
  let data = { title:'新曙光市', roads:[], buses:[], metros:[], stations:[], buildings:[], areas:[], labels:[] };
  const INITIAL_VIEW = { x:0, y:0, w:1600, h:1000 };
  const MIN_ZOOM = 10, MAX_ZOOM = 500;
  let tool = 'select', selected = null, draft = null, extension = null, reroute = null, boundaryEdit = null, drawMode = 'line', drawLevel = 0, view = { ...INITIAL_VIEW }, panning = null, spacePanning = false, suppressClick = false;
  const SPATIAL_CELL_SIZE = 180;
  const MAX_ROAD_LABELS = 8;
  const sampledGeometryCache = new WeakMap();
  const objectBoundsCache = new WeakMap();
  let roadNetworkCache = null, metroNetworkCache = null, previewFrame = 0, pendingPreviewPosition = null, panFrame = 0, pendingPanPosition = null, viewRenderTimer = 0, history = [], historyIndex = -1, labelDrag = null;
  const HISTORY_LIMIT = 50;
  const ids = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
  const pointString = points => points.map(p => `${p.x},${p.y}`).join(' ');
  const midpoint = pts => pts[Math.floor(pts.length / 2)];
  const visible = k => document.querySelector(`[data-layer="${k}"]`).checked;
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const zoomPercent = () => 100 * INITIAL_VIEW.w / view.w;

  function applyView() {
    svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
    const zoom=clamp(zoomPercent(),MIN_ZOOM,MAX_ZOOM);
    $('#zoomStatus').textContent=`${Math.round(zoom)}%`;
    $('#zoomSlider').value=Math.round(zoom/5)*5;
    $('#viewPosition').textContent=`X ${Math.round(view.x+view.w/2)} · Y ${Math.round(view.y+view.h/2)}`;
  }
  function setZoom(percent,anchor=null) {
    const target=clamp(percent,MIN_ZOOM,MAX_ZOOM),old={...view},ratio=(100*INITIAL_VIEW.w/target)/old.w;
    const focus=anchor||{x:old.x+old.w/2,y:old.y+old.h/2};
    view.w=old.w*ratio; view.h=old.h*ratio;
    view.x=focus.x-(focus.x-old.x)*ratio; view.y=focus.y-(focus.y-old.y)*ratio;
    applyView();scheduleViewportRender();
  }
  function panView(direction) {
    const step=.18;
    if(direction==='left')view.x-=view.w*step;if(direction==='right')view.x+=view.w*step;
    if(direction==='up')view.y-=view.h*step;if(direction==='down')view.y+=view.h*step;
    applyView();scheduleViewportRender(0);
  }
  function resetView() { view={...INITIAL_VIEW};applyView();scheduleViewportRender(0); }
  function allMapPoints() {
    const points=[];
    ['roads','buses','metros','buildings','areas'].forEach(kind=>data[kind].forEach(o=>(o.points||[]).forEach(p=>points.push(p))));
    ['stations','labels'].forEach(kind=>data[kind].forEach(o=>points.push({x:o.x,y:o.y})));
    return points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  }
  function fitMap() {
    const points=allMapPoints();if(!points.length){resetView();toast('画布为空，已恢复初始视图');return;}
    const limits=points.reduce((a,p)=>({minX:Math.min(a.minX,p.x),minY:Math.min(a.minY,p.y),maxX:Math.max(a.maxX,p.x),maxY:Math.max(a.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity}),padding=90;
    let w=Math.max(240,limits.maxX-limits.minX+padding*2),h=Math.max(150,limits.maxY-limits.minY+padding*2);
    const ratio=INITIAL_VIEW.w/INITIAL_VIEW.h;if(w/h<ratio)w=h*ratio;else h=w/ratio;
    const targetZoom=clamp(100*INITIAL_VIEW.w/w,MIN_ZOOM,MAX_ZOOM);w=100*INITIAL_VIEW.w/targetZoom;h=100*INITIAL_VIEW.h/targetZoom;
    const cx=(limits.minX+limits.maxX)/2,cy=(limits.minY+limits.maxY)/2;view={x:cx-w/2,y:cy-h/2,w,h};applyView();scheduleViewportRender(0);toast('已适配全部地图内容');
  }

  function currentRenderBounds(){const padding=Math.min(700,Math.max(view.w,view.h)*.2);return{minX:view.x-padding,minY:view.y-padding,maxX:view.x+view.w+padding,maxY:view.y+view.h+padding};}
  function pointInBounds(p,bounds){return p.x>=bounds.minX&&p.x<=bounds.maxX&&p.y>=bounds.minY&&p.y<=bounds.maxY;}
  function boundsIntersect(a,b){return a.maxX>=b.minX&&a.minX<=b.maxX&&a.maxY>=b.minY&&a.minY<=b.maxY;}
  function mapObjectBounds(o){const cached=objectBoundsCache.get(o);if(cached&&cached.points===o.points)return cached.bounds;const points=o.points||[];let bounds;if(points.length){bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};points.forEach(p=>{bounds.minX=Math.min(bounds.minX,p.x);bounds.minY=Math.min(bounds.minY,p.y);bounds.maxX=Math.max(bounds.maxX,p.x);bounds.maxY=Math.max(bounds.maxY,p.y);});}else bounds={minX:o.x,minY:o.y,maxX:o.x,maxY:o.y};objectBoundsCache.set(o,{points:o.points,bounds});return bounds;}
  function objectInBounds(o,bounds){return boundsIntersect(mapObjectBounds(o),bounds);}
  function visibleSegmentSources(network,bounds){const result=new Map();querySpatial(network,bounds.minX,bounds.minY,bounds.maxX,bounds.maxY).forEach(segment=>{if(!result.has(segment.road.id))result.set(segment.road.id,new Set());result.get(segment.road.id).add(segment.sourceIndex);});return result;}
  function scheduleViewportRender(delay=90){clearTimeout(viewRenderTimer);viewRenderTimer=setTimeout(()=>{viewRenderTimer=0;render();},delay);}

  function render() {
    if(viewRenderTimer){clearTimeout(viewRenderTimer);viewRenderTimer=0;}
    content.replaceChildren();
    const bounds=currentRenderBounds(),roadSources=visible('roads')?visibleSegmentSources(getRoadNetwork(),bounds):new Map(),metroSources=visible('metros')?visibleSegmentSources(getMetroNetwork(),bounds):new Map();
    ['areas','buildings'].forEach(kind=>{if(visible(kind))data[kind].forEach(o=>{if(objectInBounds(o,bounds))content.append(renderObject(kind,o));});});
    const levels=[...new Set([
      ...data.roads.flatMap(o=>[...(roadSources.get(o.id)||[])].map(i=>segmentLevel(o,i))),
      ...data.metros.flatMap(o=>[...(metroSources.get(o.id)||[])].map(i=>segmentLevel(o,i)))
    ])].sort((a,b)=>a-b);
    levels.forEach(level=>{
      data.roads.forEach(road=>{const indices=[...(roadSources.get(road.id)||[])].filter(i=>segmentLevel(road,i)===level);if(indices.length)content.append(renderRoadLevel(road,level,indices));});
      data.metros.forEach(metro=>{const indices=[...(metroSources.get(metro.id)||[])].filter(i=>segmentLevel(metro,i)===level);if(indices.length)content.append(renderMetroLevel(metro,level,indices));});
    });
    if (visible('roads')) {
      const markers=el('g',{class:'crossing-markers'}); appendCrossingMarkers(markers,bounds); content.append(markers);
      data.roads.forEach(road=>{if(road.name&&roadSources.has(road.id)){const labels=renderRoadLabels(road,bounds);if(labels.childNodes.length)content.append(labels);}});
    }
    if(visible('buses')) data.buses.forEach(o=>{if(objectInBounds(o,bounds)){content.append(renderObject('buses',o));if(o.name&&zoomPercent()>=20)content.append(renderTransitLabel('buses',o));}});
    if(visible('metros')&&zoomPercent()>=20)data.metros.forEach(o=>{if(o.name&&metroSources.has(o.id))content.append(renderTransitLabel('metros',o));});
    ['stations','labels'].forEach(kind => { if (visible(kind)&&(kind!=='labels'||zoomPercent()>=20)) data[kind].forEach(o => {if(pointInBounds(o,bounds))content.append(renderObject(kind,o));}); });
    $('#roadCount').textContent = data.roads.length; $('#busCount').textContent = data.buses.length; $('#metroCount').textContent = data.metros.length; $('#stationCount').textContent = data.stations.length; $('#buildingCount').textContent=data.buildings.length;$('#areaCount').textContent=data.areas.length;$('#labelCount').textContent = data.labels.length;
    $('#emptyTip').style.display = Object.values(data).slice(1).some(v => v.length) ? 'none' : 'block';
    renderSelection();
  }

  function renderSelection() {
    selectionLayer.replaceChildren();
    if (selected) drawSelected(selected);
  }
  function renderObject(kind, o) {
    const g = el('g', { class:'map-object', 'data-kind':kind, 'data-id':o.id }),showDetail=zoomPercent()>=25;
    if (kind === 'buses') {
      const line = el('polyline',{class:'bus-line transit-line',points:pointString(o.points),stroke:o.color,'stroke-width':o.width});
      if (o.lineStyle === 'dash') line.setAttribute('stroke-dasharray', `${o.width * 2.2} ${o.width * 1.4}`);
      g.append(line);
    } else if (kind === 'stations') {
      g.append(el('circle', { class:'station-ring', cx:o.x, cy:o.y, r:8 })); g.append(el('circle', { class:'station-dot', cx:o.x, cy:o.y, r:8, stroke:o.color }));
      if (o.name&&showDetail) { const baseX=o.x+13,baseY=o.y-12,t=el('text', { class:'object-label station-label draggable-label',x:baseX+(o.labelOffsetX||0),y:baseY+(o.labelOffsetY||0),'data-label-kind':kind,'data-label-id':o.id,'data-label-base-x':baseX,'data-label-base-y':baseY }); t.textContent=o.name; g.append(t); }
    } else if(kind==='buildings'||kind==='areas'){g.append(el('polygon',{class:kind==='buildings'?'building-shape':'area-shape',points:pointString(o.points),fill:o.color}));if(o.name&&showDetail){const p=polygonCenter(o.points),t=el('text',{class:'polygon-label draggable-label',x:p.x+(o.labelOffsetX||0),y:p.y+(o.labelOffsetY||0),'text-anchor':'middle','data-label-kind':kind,'data-label-id':o.id,'data-label-base-x':p.x,'data-label-base-y':p.y});t.textContent=o.name;g.append(t);}}
    else { const t = el('text', { class:'object-label place-label draggable-label',x:o.x+(o.labelOffsetX||0),y:o.y+(o.labelOffsetY||0),fill:o.color,'font-size':o.size,'data-label-kind':kind,'data-label-id':o.id,'data-label-base-x':o.x,'data-label-base-y':o.y }); t.textContent=o.name; g.append(t); }
    return g;
  }
  function segmentPath(o,i) { const p0=o.points[i-1]||o.points[i],p1=o.points[i],p2=o.points[i+1],p3=o.points[i+2]||p2;if(segmentMode(o,i)==='curve')return `M ${p1.x} ${p1.y} C ${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6}, ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6}, ${p2.x} ${p2.y}`;return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`; }
  function renderRoadLevel(road,level,indices) { const g=el('g',{class:'map-object','data-kind':'roads','data-id':road.id}),d=indices.map(i=>segmentPath(road,i)).join(' '),roadClass=level<0?' road-tunnel':level>0?' road-bridge':'';if(level>0)g.append(el('path',{class:'bridge-casing',d,'stroke-width':road.width+8}));g.append(el('path',{class:`road-line${roadClass}`,d,stroke:road.color,'stroke-width':road.width}));return g; }
  function renderMetroLevel(metro,level,indices) { const g=el('g',{class:'map-object','data-kind':'metros','data-id':metro.id}),d=indices.map(i=>segmentPath(metro,i)).join(' '),klass=level<0?' metro-tunnel':'';if(level>0)g.append(el('path',{class:'metro-elevated-casing',d,'stroke-width':metro.width+6}));g.append(el('path',{class:`metro-line transit-line${klass}`,d,stroke:metro.color,'stroke-width':metro.width}));return g; }
  function renderTransitLabel(kind,o){const p=midpoint(o.points),baseX=p.x+10,baseY=p.y-10,x=baseX+(o.labelOffsetX||0),y=baseY+(o.labelOffsetY||0),size=+(o.labelSize||16),shape=o.labelShape||'pill',background=o.labelColor||o.color,textColor=o.labelTextColor||'#ffffff',length=Array.from(o.name).length,width=Math.max(size*2.2,length*size*.72+18),height=size+12,g=el('g',{class:'map-object draggable-label','data-kind':kind,'data-id':o.id,'data-label-kind':kind,'data-label-id':o.id,'data-label-base-x':baseX,'data-label-base-y':baseY,transform:`translate(${x} ${y})`});if(shape==='circle')g.append(el('circle',{class:'transit-name-shape',cx:0,cy:0,r:Math.max(width,height)/2,fill:background}));else if(shape!=='plain')g.append(el('rect',{class:'transit-name-shape',x:-width/2,y:-height/2,width,height,rx:shape==='pill'?height/2:3,fill:background}));const t=el('text',{class:shape==='plain'?'object-label transit-name-text':'transit-name-text',x:0,y:1,fill:textColor,'font-size':size});t.textContent=o.name;g.append(t);return g;}
  function polygonCenter(points){return{x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};}
  function shortRoadName(name){const max=zoomPercent()<25?4:zoomPercent()<50?5:8,chars=Array.from(name);return chars.length>max?`${chars.slice(0,max).join('')}…`:name;}
  function renderRoadLabels(road,bounds){const g=el('g',{class:'map-object','data-kind':'roads','data-id':road.id}),segments=roadRoutingSegments(road).map(s=>({...s,length:Math.hypot(s.b.x-s.a.x,s.b.y-s.a.y)})),total=segments.reduce((sum,s)=>sum+s.length,0);if(!total)return g;const zoom=zoomPercent(),limit=zoom<20?1:zoom<50?3:MAX_ROAD_LABELS,count=Math.min(limit,Math.max(1,Math.round(total/300))),step=total/count,label=shortRoadName(road.name);for(let n=0;n<count;n++){let target=step*(n+.5),passed=0,segment=segments.at(-1);for(const s of segments){if(target<=passed+s.length){segment=s;break;}passed+=s.length;}const ratio=Math.max(0,Math.min(1,(target-passed)/segment.length)),dx=segment.b.x-segment.a.x,dy=segment.b.y-segment.a.y,len=segment.length,angleRaw=Math.atan2(dy,dx)*180/Math.PI,angle=angleRaw>90?angleRaw-180:angleRaw<-90?angleRaw+180:angleRaw,nx=-dy/len,ny=dx/len,sign=ny>0?-1:1,offset=road.width/2+13,x=segment.a.x+dx*ratio+nx*offset*sign,y=segment.a.y+dy*ratio+ny*offset*sign;if(!pointInBounds({x,y},bounds))continue;const t=el('text',{class:'object-label road-label',x,y,'text-anchor':'middle','aria-label':road.name,transform:`rotate(${angle} ${x} ${y})`});t.textContent=label;g.append(t);}return g;}
  function segmentMode(o,index) { return o.segmentModes?.[index] || (o.curved ? 'curve' : 'line'); }
  function legacyLevel(elevation) { return elevation==='bridge'?1:elevation==='tunnel'?-1:0; }
  function segmentLevel(o,index) { return Number.isFinite(o.segmentLevels?.[index]) ? o.segmentLevels[index] : legacyLevel(o.elevation); }
  function geometryPath(points,o={}) { if(!points.length)return '';let d=`M ${points[0].x} ${points[0].y}`;for(let i=0;i<points.length-1;i++){const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;if(segmentMode(o,i)==='curve')d+=` C ${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6}, ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6}, ${p2.x} ${p2.y}`;else d+=` L ${p2.x} ${p2.y}`;}return d; }
  function curvePoint(points, index, t) { const p0=points[index-1] || points[index],p1=points[index],p2=points[index+1],p3=points[index+2] || p2,u=1-t,c1={x:p1.x+(p2.x-p0.x)/6,y:p1.y+(p2.y-p0.y)/6},c2={x:p2.x-(p3.x-p1.x)/6,y:p2.y-(p3.y-p1.y)/6}; return {x:u*u*u*p1.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*p2.x,y:u*u*u*p1.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*p2.y}; }
  function roadRoutingSegments(road) {
    const cached=sampledGeometryCache.get(road);
    if(cached&&cached.points===road.points&&cached.modes===road.segmentModes&&cached.levels===road.segmentLevels&&cached.curved===road.curved&&cached.elevation===road.elevation)return cached.segments;
    const segments=[];for(let i=0;i<road.points.length-1;i++){const level=segmentLevel(road,i);if(segmentMode(road,i)==='curve'){let a=curvePoint(road.points,i,0);for(let step=1;step<=12;step++){const b=curvePoint(road.points,i,step/12);segments.push({road,sourceIndex:i,a,b,level});a=b;}}else segments.push({road,sourceIndex:i,a:road.points[i],b:road.points[i+1],level});}
    sampledGeometryCache.set(road,{points:road.points,modes:road.segmentModes,levels:road.segmentLevels,curved:road.curved,elevation:road.elevation,segments});return segments;
  }

  function invalidateNetwork(kind=null) {
    if(!kind||kind==='roads')roadNetworkCache=null;
    if(!kind||kind==='metros')metroNetworkCache=null;
  }

  function buildSpatialNetwork(lines) {
    // Sampled geometry and its lookup grid live until the corresponding network changes.
    const routes=new Map(),segments=[],cells=new Map();
    const addCell=(x,y,item)=>{const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(item);};
    lines.forEach(road=>{const route=roadRoutingSegments(road);routes.set(road.id,route);route.forEach((segment,index)=>{const item={...segment,index,spatialId:segments.length},minX=Math.min(item.a.x,item.b.x),maxX=Math.max(item.a.x,item.b.x),minY=Math.min(item.a.y,item.b.y),maxY=Math.max(item.a.y,item.b.y);item.bounds={minX,minY,maxX,maxY};segments.push(item);for(let x=Math.floor(minX/SPATIAL_CELL_SIZE);x<=Math.floor(maxX/SPATIAL_CELL_SIZE);x++)for(let y=Math.floor(minY/SPATIAL_CELL_SIZE);y<=Math.floor(maxY/SPATIAL_CELL_SIZE);y++)addCell(x,y,item);});});
    return {routes,segments,cells,busGraphs:new Map(),crossings:null};
  }

  function getRoadNetwork(){return roadNetworkCache||(roadNetworkCache=buildSpatialNetwork(data.roads));}
  function getMetroNetwork(){return metroNetworkCache||(metroNetworkCache=buildSpatialNetwork(data.metros));}

  function querySpatial(network,minX,minY,maxX,maxY,level=null) {
    const found=new Map();
    for(let x=Math.floor(minX/SPATIAL_CELL_SIZE);x<=Math.floor(maxX/SPATIAL_CELL_SIZE);x++)for(let y=Math.floor(minY/SPATIAL_CELL_SIZE);y<=Math.floor(maxY/SPATIAL_CELL_SIZE);y++)for(const item of network.cells.get(`${x},${y}`)||[]){if((level===null||item.level===level)&&item.bounds.maxX>=minX&&item.bounds.minX<=maxX&&item.bounds.maxY>=minY&&item.bounds.minY<=maxY)found.set(item.spatialId,item);}
    return [...found.values()];
  }

  function queryNearSegment(network,segment,padding=0,level=null){const minX=Math.min(segment.a.x,segment.b.x)-padding,maxX=Math.max(segment.a.x,segment.b.x)+padding,minY=Math.min(segment.a.y,segment.b.y)-padding,maxY=Math.max(segment.a.y,segment.b.y)+padding;return querySpatial(network,minX,minY,maxX,maxY,level);}

  function roadCrossings() {
    const network=getRoadNetwork();if(network.crossings)return network.crossings;
    const same=[],different=[];
    for(const a of network.segments)for(const b of queryNearSegment(network,a)){if(b.spatialId<=a.spatialId||a.road===b.road)continue;const hit=segmentCrossing(a.a,a.b,b.a,b.b);if(!hit)continue;(a.level===b.level?same:different).push({a,b,hit});}
    network.crossings={same,different};return network.crossings;
  }
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
  function appendCrossingMarkers(layer,bounds) {
    roadCrossings().different.forEach(({a,b,hit})=>{if(bounds&&!pointInBounds(hit,bounds))return;const upper=a.level>b.level?a:b,lower=upper===a?b:a,upperHit={...hit,segment:{a:upper.a,b:upper.b}},lowerHit={...hit,segment:{a:lower.a,b:lower.b}};if(upper.level>0)addCrossingMarker(layer,upper.road,upperHit,'bridge');if(lower.level<0)addCrossingMarker(layer,lower.road,lowerHit,'tunnel');});
  }
  function drawSelected(item) {
    const { kind, obj } = item; let shape;
    if(boundaryEdit?.obj===obj){shape=el('polygon',{class:'selected-outline',points:pointString(boundaryEdit.points)});selectionLayer.append(shape);boundaryEdit.points.forEach((p,index)=>selectionLayer.append(el('circle',{class:'boundary-vertex','data-boundary-index':index,cx:p.x,cy:p.y,r:7})));return;}
    if (kind === 'roads' || kind === 'metros') shape = el('path', { class:'selected-outline', d:geometryPath(obj.points,obj) });
    else if (kind === 'buses') shape = el('polyline', { class:'selected-outline', points:pointString(obj.points) });
    else if (kind === 'buildings' || kind === 'areas') shape = el('polygon', { class:'selected-outline', points:pointString(obj.points) });
    else if (kind === 'stations') shape = el('circle', { class:'selected-outline', cx:obj.x, cy:obj.y, r:15 });
    else shape = el('rect', { class:'selected-outline', x:obj.x+(obj.labelOffsetX||0)-7, y:obj.y+(obj.labelOffsetY||0)-obj.size, width:Math.max(28, obj.name.length * obj.size * .65), height:obj.size + 10 });
    selectionLayer.append(shape);
  }
  function toMap(e) {
    const p = svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY; const q=p.matrixTransform(svg.getScreenCTM().inverse()); return { x:Math.round(q.x), y:Math.round(q.y) };
  }
  function setTool(name) {
    tool = name; draft = null; extension = null; reroute = null; boundaryEdit = null; cancelPreviewFrame(); preview.replaceChildren(); selected = null; renderSelection(); document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    viewport.classList.toggle('drawing', !['select'].includes(name));
    $('#drawModeControl').hidden=!['road','metro'].includes(name);
    $('#levelControl').hidden=!['road','bus','metro'].includes(name);$('#levelControlTitle').textContent=name==='bus'?'选路层级':'下一段层级';
    const text = {select:'选择：单击对象进行编辑，拖动空白处平移',road:'道路：逐段设置直曲与层级，右键结束',bus:'公交：用 ↑↓ 选择交叉处道路层级，右键结束',metro:'地铁：逐段设置直曲与层级；冲突段会被阻止',station:'站点：只能点击地铁线，在线路上插站',building:'建筑：逐点绘制轮廓，右键闭合',area:'区域：逐点绘制边界，右键闭合',label:'文字：单击地图后输入地名或路名',eraser:'删除：单击要删除的对象'};
    $('#toolStatus').textContent=text[name]; loadInspector(null);
  }
  function setDrawMode(mode) { drawMode=mode; document.querySelectorAll('[data-draw-mode]').forEach(b=>b.classList.toggle('active',b.dataset.drawMode===mode)); $('#toolStatus').textContent=`${tool==='road'?'道路':'地铁'}：下一段为${mode==='curve'?'曲线':'直线'}，层级 ${drawLevel>0?'+':''}${drawLevel}`; }
  function setDrawLevel(level) { drawLevel=Math.max(-5,Math.min(5,level));$('#drawLevelValue').textContent=drawLevel===0?'地面 0':drawLevel>0?`上跨 +${drawLevel}`:`下钻 ${drawLevel}`;if(['road','metro'].includes(tool))$('#toolStatus').textContent=`${tool==='road'?'道路':'地铁'}：下一段为${drawMode==='curve'?'曲线':'直线'}，层级 ${drawLevel>0?'+':''}${drawLevel}`;else if(tool==='bus')$('#toolStatus').textContent=`公交：当前选择道路层级 ${drawLevel>0?'+':''}${drawLevel}`; }
  function findObject(kind, id) { return data[kind].find(x => x.id === id); }
  function selectObject(kind, id) { const obj=findObject(kind,id); if (!obj) return; boundaryEdit=null;reroute=null;selected={kind,obj};loadInspector(obj);renderSelection(); }
  function loadInspector(o) { const d=o || defaults[tool] || defaults.road; $('#objectName').value=d.name || ''; $('#objectColor').value=d.color || '#18394a'; $('#objectWidth').value=d.width || 10; $('#widthValue').value=d.width || 10; $('#roadClass').value=d.roadClass||'primary'; $('#lineStyle').value=d.lineStyle || 'solid'; $('#labelSize').value=d.size || 22; $('#labelSizeValue').value=d.size || 22; $('#widthControl').style.display = ['roads','buses','metros'].includes(selected?.kind) || ['road','bus','metro'].includes(tool) ? '' : 'none'; $('#roadClassControl').style.display=selected?.kind==='roads'||tool==='road'?'':'none';$('#lineStyleControl').style.display = ['buses','metros'].includes(selected?.kind) || ['bus','metro'].includes(tool) ? '' : 'none'; $('#labelSizeControl').style.display = selected?.kind === 'labels' || tool === 'label' ? '' : 'none'; $('#extensionControl').hidden=!['roads','buses','metros'].includes(selected?.kind);$('#rerouteControl').hidden=!['roads','buses','metros'].includes(selected?.kind);$('#boundaryControl').hidden=!['buildings','areas'].includes(selected?.kind);$('#applyStyle').disabled=!selected;loadTransitLabelControls(d);if(!boundaryEdit){$('#editBoundary').textContent='拖动顶点';$('#cancelBoundary').hidden=true;} }
  function loadTransitLabelControls(d){const active=['buses','metros'].includes(selected?.kind);$('#transitLabelControl').hidden=!active;$('#transitLabelShape').value=d.labelShape||'pill';$('#transitLabelColor').value=d.labelColor||d.color||'#2d8a57';$('#transitLabelTextColor').value=d.labelTextColor||'#ffffff';$('#transitLabelSize').value=d.labelSize||16;$('#transitLabelSizeValue').value=d.labelSize||16;}

  function startBoundaryEdit(){if(!selected||!['buildings','areas'].includes(selected.kind))return;boundaryEdit={kind:selected.kind,obj:selected.obj,points:selected.obj.points.map(p=>({...p})),dragIndex:null};$('#editBoundary').textContent='完成调整';$('#cancelBoundary').hidden=false;$('#toolStatus').textContent='拖动边界顶点向外延伸或向内缩减';renderSelection();}
  function finishBoundaryEdit(){if(!boundaryEdit){startBoundaryEdit();return;}const {obj,points}=boundaryEdit;obj.points=points.map(p=>({...p}));boundaryEdit=null;$('#editBoundary').textContent='拖动顶点';$('#cancelBoundary').hidden=true;render();recordHistory();saveLocal(false);toast('边界已调整');}
  function cancelBoundaryEdit(){if(!boundaryEdit)return;boundaryEdit=null;$('#editBoundary').textContent='拖动顶点';$('#cancelBoundary').hidden=true;renderSelection();$('#toolStatus').textContent='选择：单击对象进行编辑，拖动空白处平移';}

  function beginLabelDrag(node,e){if(e.button!==0)return false;const obj=findObject(node.dataset.labelKind,node.dataset.labelId);if(!obj)return false;labelDrag={node,obj,start:toMap(e),offsetX:obj.labelOffsetX||0,offsetY:obj.labelOffsetY||0,baseX:+node.dataset.labelBaseX,baseY:+node.dataset.labelBaseY,moved:false,isGroup:node.tagName.toLowerCase()==='g'};viewport.setPointerCapture?.(e.pointerId);e.preventDefault();return true;}
  function moveLabel(e){const p=toMap(e),dx=p.x-labelDrag.start.x,dy=p.y-labelDrag.start.y,x=labelDrag.offsetX+dx,y=labelDrag.offsetY+dy;labelDrag.obj.labelOffsetX=x;labelDrag.obj.labelOffsetY=y;labelDrag.moved=labelDrag.moved||Math.abs(dx)>1||Math.abs(dy)>1;if(labelDrag.isGroup)labelDrag.node.setAttribute('transform',`translate(${labelDrag.baseX+x} ${labelDrag.baseY+y})`);else{labelDrag.node.setAttribute('x',labelDrag.baseX+x);labelDrag.node.setAttribute('y',labelDrag.baseY+y);}}
  function finishLabelDrag(){if(!labelDrag)return;const moved=labelDrag.moved;labelDrag=null;if(moved){renderSelection();recordHistory();saveLocal(false);suppressClick=true;setTimeout(()=>suppressClick=false,0);}}

  function startExtension(side) {
    const item=selected;if(!item||!['roads','buses','metros'].includes(item.kind))return;
    const {kind,obj}=item,atStart=side==='start',endpoint=atStart?obj.points[0]:obj.points.at(-1),toolName=kind==='roads'?'road':kind==='buses'?'bus':'metro';if(!endpoint)return;
    let anchor=null;if(kind==='buses'){const level=Number.isFinite(endpoint.level)?endpoint.level:null;anchor=snapToRoad(endpoint,level);if(!anchor){toast('线路端点已不在现有道路上，无法继续延长');return;}}
    setTool(toolName);extension={kind,obj,side};
    if(kind==='buses'){setDrawLevel(anchor.level);draft={points:[{x:anchor.x,y:anchor.y,level:anchor.level}],anchor};}
    else{const segmentIndex=atStart?0:Math.max(0,obj.points.length-2);setDrawMode(segmentMode(obj,segmentIndex));setDrawLevel(segmentLevel(obj,segmentIndex));draft={points:[{x:endpoint.x,y:endpoint.y}],segmentModes:[],segmentLevels:[]};}
    loadInspector(obj);$('#toolStatus').textContent=`${toolName==='road'?'道路':toolName==='bus'?'公交':'地铁'}：正在从${atStart?'起点':'终点'}延长，右键完成`;previewDraft(draft.points[0]);
  }

  function applyExtension() {
    const {kind,obj,side}=extension,prepend=side==='start',hasSegments=kind!=='buses',existingModes=hasSegments?obj.points.slice(0,-1).map((_,i)=>segmentMode(obj,i)):[],existingLevels=hasSegments?obj.points.slice(0,-1).map((_,i)=>segmentLevel(obj,i)):[],addedPoints=prepend?[...draft.points].reverse():draft.points;
    obj.points=prepend?[...addedPoints,...obj.points.slice(1)]:[...obj.points,...addedPoints.slice(1)];
    if(hasSegments){const modes=prepend?[...(draft.segmentModes||[])].reverse():draft.segmentModes||[],levels=prepend?[...(draft.segmentLevels||[])].reverse():draft.segmentLevels||[];obj.segmentModes=prepend?[...modes,...existingModes]:[...existingModes,...modes];obj.segmentLevels=prepend?[...levels,...existingLevels]:[...existingLevels,...levels];invalidateNetwork(kind);}
    const completed={kind,obj};extension=null;draft=null;cancelPreviewFrame();preview.replaceChildren();selected=completed;setDrawLevel(drawLevel);render();loadInspector(obj);recordHistory();saveLocal(false);toast('线路已延长');
  }

  function startReroute(side){const item=selected;if(!item||!['roads','buses','metros'].includes(item.kind))return;const toolName=item.kind==='roads'?'road':item.kind==='buses'?'bus':'metro';setTool(toolName);reroute={kind:item.kind,obj:item.obj,side,stage:side==='middle'?'pick-first':'pick'};selected=item;loadInspector(item.obj);renderSelection();$('#toolStatus').textContent=side==='middle'?`点击原${toolName==='road'?'道路':'线路'}上的修改起始点`:`点击原${toolName==='road'?'道路':'线路'}上的截断点，随后重画${side==='start'?'起点':'终点'}一侧`;}
  function retainedAtCut(kind,obj,snap,point,side){const i=snap.segment,a=obj.points[i],b=obj.points[i+1],atA=Math.hypot(point.x-a.x,point.y-a.y)<.1,atB=Math.hypot(point.x-b.x,point.y-b.y)<.1,hasSegments=kind!=='buses',modes=hasSegments?obj.points.slice(0,-1).map((_,index)=>segmentMode(obj,index)):[],levels=hasSegments?obj.points.slice(0,-1).map((_,index)=>segmentLevel(obj,index)):[];if(side==='end'){if(atA)return{points:obj.points.slice(0,i+1),modes:modes.slice(0,i),levels:levels.slice(0,i)};if(atB)return{points:obj.points.slice(0,i+2),modes:modes.slice(0,i+1),levels:levels.slice(0,i+1)};return{points:[...obj.points.slice(0,i+1),point],modes:[...modes.slice(0,i),modes[i]],levels:[...levels.slice(0,i),levels[i]]};}if(atA)return{points:obj.points.slice(i),modes:modes.slice(i),levels:levels.slice(i)};if(atB)return{points:obj.points.slice(i+1),modes:modes.slice(i+1),levels:levels.slice(i+1)};return{points:[point,...obj.points.slice(i+1)],modes:[modes[i],...modes.slice(i+1)],levels:[levels[i],...levels.slice(i+1)]};}
  function rerouteSnapAt(p){const {kind,obj}=reroute,snap=snapToLine(p,obj),threshold=view.w/svg.getBoundingClientRect().width*20;if(!snap||snap.distance>threshold){toast('请点击需要修改的原道路或线路');return null;}const sourcePoint=obj.points[snap.segment],nextPoint=obj.points[snap.segment+1],point={x:snap.x,y:snap.y};if(kind==='buses'){const level=Number.isFinite(sourcePoint?.level)?sourcePoint.level:nextPoint?.level;const anchor=snapToRoad(point,Number.isFinite(level)?level:null);if(!anchor){toast('该位置已不在现有道路上，无法从此处改线');return null;}point.x=anchor.x;point.y=anchor.y;point.level=anchor.level;return{snap,point,anchor,order:snap.segment+snap.t};}return{snap,point,anchor:null,order:snap.segment+snap.t};}
  function beginRerouteDrawing(startData){const {kind,obj,side}=reroute,point=startData.point;if(kind==='buses'){setDrawLevel(startData.anchor.level);draft={points:[{...point}],anchor:startData.anchor};}else{setDrawMode(segmentMode(obj,startData.snap.segment));setDrawLevel(segmentLevel(obj,startData.snap.segment));draft={points:[{...point}],segmentModes:[],segmentLevels:[]};}reroute.stage='draw';$('#toolStatus').textContent=side==='middle'?'绘制新的中间路线，左键点击原路线锁定回接点，再右键完成；Esc 取消':`正在重画${side==='start'?'起点一侧':'终点一侧'}，右键完成，Esc 取消`;previewDraft(point);}
  function pickReroutePoint(p){const dataAtPoint=rerouteSnapAt(p);if(!dataAtPoint)return;const {kind,obj,side}=reroute;if(side==='middle'){reroute.firstCut=dataAtPoint;reroute.cutPoints=[dataAtPoint.point];beginRerouteDrawing(dataAtPoint);return;}reroute.retained=retainedAtCut(kind,obj,dataAtPoint.snap,dataAtPoint.point,side);reroute.cutPoints=[dataAtPoint.point];reroute.cutPoint=dataAtPoint.point;beginRerouteDrawing(dataAtPoint);}
  function middleRetainedConflict(candidate){if(reroute.kind!=='metros')return null;const newLine={points:candidate.points,segmentModes:candidate.segmentModes,segmentLevels:candidate.segmentLevels},retainedParts=[reroute.retainedStart,reroute.retainedEnd].filter(Boolean),cuts=reroute.cutPoints||[];for(const added of roadRoutingSegments(newLine))for(const part of retainedParts){const retained={points:part.points,segmentModes:part.modes,segmentLevels:part.levels};for(const existing of roadRoutingSegments(retained)){if(added.level!==existing.level)continue;const hit=geometryConflict(added,existing);if(!hit)continue;const atCut=cuts.some(cut=>Math.hypot(hit.x-cut.x,hit.y-cut.y)<2);if(!atCut&&!isStationPoint(hit))return '修改后的地铁与保留线路在同层发生交叉';}}return null;}
  function renderFixedDraftPreview(){preview.replaceChildren();if(!draft)return;if(tool==='bus')preview.append(el('polyline',{class:'preview',points:pointString(draft.points)}));else preview.append(el('path',{class:'preview',d:geometryPath(draft.points,draft)}));draft.points.forEach(p=>preview.append(el('circle',{class:'node',cx:p.x,cy:p.y,r:5})));}
  function tryFinishMiddleReroute(p){if(reroute?.side!=='middle'||reroute.stage!=='draw')return false;const snap=snapToLine(p,reroute.obj),threshold=view.w/svg.getBoundingClientRect().width*20;if(!snap||snap.distance>threshold)return false;const returnCut=rerouteSnapAt(p);if(!returnCut)return true;const first=reroute.firstCut;if(Math.abs(returnCut.order-first.order)<.001){toast('请在原路线的其他位置完成回接');return true;}const [low,high]=[first,returnCut].sort((a,b)=>a.order-b.order);reroute.retainedStart=retainedAtCut(reroute.kind,reroute.obj,low.snap,low.point,'end');reroute.retainedEnd=retainedAtCut(reroute.kind,reroute.obj,high.snap,high.point,'start');reroute.cutPoints=[low.point,high.point];reroute.reverseMiddle=first.order>returnCut.order;let candidate;if(reroute.kind==='buses'){const route=routeAlongRoads(draft.anchor,returnCut.anchor);if(!route){toast('当前公交路线无法沿道路回接原线路');return true;}candidate={...draft,points:[...draft.points,...route.slice(1)],anchor:returnCut.anchor};}else{const kind=reroute.kind==='metros'?'metro':'road',conflict=validateNewSegment(kind,returnCut.point);if(conflict){toast(conflict);return true;}candidate={...draft,points:[...draft.points,{...returnCut.point}],segmentModes:[...(draft.segmentModes||[]),drawMode],segmentLevels:[...(draft.segmentLevels||[]),drawLevel]};}const retainedConflict=middleRetainedConflict(candidate);if(retainedConflict){toast(retainedConflict);return true;}draft=candidate;reroute.stage='ready';cancelPreviewFrame();renderFixedDraftPreview();$('#toolStatus').textContent='已回接原路线，单击右键完成绘制；Esc 取消';return true;}
  function applyReroute(){const {kind,obj,side}=reroute,hasSegments=kind!=='buses';if(side==='middle'){const middlePoints=reroute.reverseMiddle?[...draft.points].reverse():draft.points,middleModes=reroute.reverseMiddle?[...(draft.segmentModes||[])].reverse():draft.segmentModes||[],middleLevels=reroute.reverseMiddle?[...(draft.segmentLevels||[])].reverse():draft.segmentLevels||[];obj.points=[...reroute.retainedStart.points,...middlePoints.slice(1),...reroute.retainedEnd.points.slice(1)];if(hasSegments){obj.segmentModes=[...reroute.retainedStart.modes,...middleModes,...reroute.retainedEnd.modes];obj.segmentLevels=[...reroute.retainedStart.levels,...middleLevels,...reroute.retainedEnd.levels];invalidateNetwork(kind);}}else{const retained=reroute.retained,prepend=side==='start',addedPoints=prepend?[...draft.points].reverse():draft.points;obj.points=prepend?[...addedPoints,...retained.points.slice(1)]:[...retained.points,...addedPoints.slice(1)];if(hasSegments){const modes=prepend?[...(draft.segmentModes||[])].reverse():draft.segmentModes||[],levels=prepend?[...(draft.segmentLevels||[])].reverse():draft.segmentLevels||[];obj.segmentModes=prepend?[...modes,...retained.modes]:[...retained.modes,...modes];obj.segmentLevels=prepend?[...levels,...retained.levels]:[...retained.levels,...levels];invalidateNetwork(kind);}}const completed={kind,obj};reroute=null;draft=null;cancelPreviewFrame();preview.replaceChildren();selected=completed;setDrawLevel(drawLevel);render();loadInspector(obj);recordHistory();saveLocal(false);toast('线路修改已完成');}
  function finishDraft() {
    const polygon=['building','area'].includes(tool),minimum=polygon?3:2;if(reroute?.side==='middle'){if(reroute.stage==='draw'){toast('请先点击原路线上的回接位置；按 Esc 可取消');return;}if(reroute.stage==='ready'){applyReroute();return;}}if(!draft||draft.points.length<minimum){const wasEditing=!!extension||!!reroute;draft=null;extension=null;reroute=null;cancelPreviewFrame();preview.replaceChildren();if(wasEditing)setDrawLevel(drawLevel);return;}if(reroute?.stage==='draw'){applyReroute();return;}if(extension){applyExtension();return;}
    const type=tool==='road'?'roads':tool==='bus'?'buses':tool==='metro'?'metros':tool==='building'?'buildings':'areas';
    let obj;if(polygon)obj={id:ids(),points:draft.points,...defaults[tool],color:$('#objectColor').value};else obj={id:ids(),points:draft.points,segmentModes:draft.segmentModes||[],segmentLevels:['road','metro'].includes(tool)?(draft.segmentLevels||[]):undefined,...defaults[tool],color:$('#objectColor').value,width:+$('#objectWidth').value,lineStyle:$('#lineStyle').value,...(tool==='road'?{roadClass:$('#roadClass').value}:{})};
    if(['bus','metro'].includes(tool))obj.labelColor=obj.color;
    data[type].push(obj);if(type==='roads'||type==='metros')invalidateNetwork(type);draft=null;cancelPreviewFrame();preview.replaceChildren();
    if(tool==='road'||polygon){const label=tool==='road'?'道路名称':tool==='building'?'建筑名称':'区域名称',name=window.prompt(`请输入${label}（也可稍后修改）`,'');if(name!==null)obj.name=name.trim();}
    selectObject(type,obj.id);render();loadInspector(obj);recordHistory();saveLocal(false);toast(polygon?'区域对象已添加':tool==='road'?'道路已添加；层级变化段将作为匝道连接':'线路已添加');
  }
  function addDraftPoint(point) { if(!draft)draft={points:[point],segmentModes:[],segmentLevels:[]};else{draft.points.push(point);draft.segmentModes.push(drawMode);if(['road','metro'].includes(tool))draft.segmentLevels.push(drawLevel);} }
  function previewDraft(pointer) { preview.replaceChildren(); if (!draft) return; let pts=[...draft.points,pointer],modes=[...(draft.segmentModes||[]),drawMode];if(['building','area'].includes(tool)){preview.append(el('polygon',{class:'preview',points:pointString(pts)}));}else if(tool==='bus'){const snap=snapToRoad(pointer,drawLevel),route=snap&&routeAlongRoads(draft.anchor,snap);pts=route?[...draft.points,...route.slice(1)]:draft.points;preview.append(el('polyline',{class:'preview',points:pointString(pts)}));}else preview.append(el('path',{class:'preview',d:geometryPath(pts,{segmentModes:modes})}));draft.points.forEach(p=>preview.append(el('circle',{class:'node',cx:p.x,cy:p.y,r:5}))); }
  function cancelPreviewFrame(){if(previewFrame)cancelAnimationFrame(previewFrame);previewFrame=0;pendingPreviewPosition=null;}
  function scheduleDraftPreview(clientX,clientY){pendingPreviewPosition={clientX,clientY};if(previewFrame)return;previewFrame=requestAnimationFrame(()=>{previewFrame=0;const position=pendingPreviewPosition;pendingPreviewPosition=null;if(draft&&position)previewDraft(toMap(position));});}
  const pointKey=(p,level=p.level??'')=>`${level}:${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  function snapToRoad(p, preferredLevel=null, excludedRoad=null) { let best=null;const threshold=view.w/svg.getBoundingClientRect().width*20,network=getRoadNetwork(),segments=querySpatial(network,p.x-threshold,p.y-threshold,p.x+threshold,p.y+threshold,preferredLevel);segments.forEach(segment=>{if(segment.road===excludedRoad)return;const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+t*dx,y=a.y+t*dy,distance=Math.hypot(p.x-x,p.y-y);if(!best||distance<best.distance)best={road:segment.road,segment:segment.index,sourceIndex:segment.sourceIndex,level:segment.level,t,x,y,distance};});return best&&best.distance<=threshold?best:null; }
  function snapToLine(p, line) { let best=null; const test=(a,b,segment,segmentT=0,segmentSpan=1)=>{const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;const localT=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+localT*dx,y=a.y+localT*dy,distance=Math.hypot(p.x-x,p.y-y),t=segmentT+localT*segmentSpan;if(!best||distance<best.distance)best={x,y,segment,t,distance};}; for(let i=0;i<line.points.length-1;i++){if(segmentMode(line,i)==='curve'){let a=curvePoint(line.points,i,0);for(let step=1;step<=16;step++){const b=curvePoint(line.points,i,step/16);test(a,b,i,(step-1)/16,1/16);a=b;}}else test(line.points[i],line.points[i+1],i);}return best; }
  function inclusiveCrossing(a,b,c,d){const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,den=rx*sy-ry*sx;if(Math.abs(den)<.001)return null;const qx=c.x-a.x,qy=c.y-a.y,t=(qx*sy-qy*sx)/den,u=(qx*ry-qy*rx)/den;return t>=-.001&&t<=1.001&&u>=-.001&&u<=1.001?{x:a.x+t*rx,y:a.y+t*ry}:null;}
  function pointSegmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)):0;return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));}
  function geometryConflict(a,b){const crossing=inclusiveCrossing(a.a,a.b,b.a,b.b);if(crossing)return crossing;const checks=[{p:a.a,d:pointSegmentDistance(a.a,b.a,b.b)},{p:a.b,d:pointSegmentDistance(a.b,b.a,b.b)},{p:b.a,d:pointSegmentDistance(b.a,a.a,a.b)},{p:b.b,d:pointSegmentDistance(b.b,a.a,a.b)}].sort((x,y)=>x.d-y.d);return checks[0].d<1.5?checks[0].p:null;}
  function isStationPoint(p){return data.stations.some(s=>Math.hypot(s.x-p.x,s.y-p.y)<8);}
  function validateNewSegment(kind,point){if(!draft||!draft.points.length)return null;const tempIndex=draft.points.length-1,temp={points:[...draft.points,point],segmentModes:[...(draft.segmentModes||[]),drawMode],segmentLevels:[...(draft.segmentLevels||[]),drawLevel]},candidates=roadRoutingSegments(temp).filter(s=>s.sourceIndex===tempIndex);if(kind==='metro'){
      if(drawLevel===0){const roads=getRoadNetwork();for(const candidate of candidates)for(const road of queryNearSegment(roads,candidate,1.5,0))if(geometryConflict(candidate,road))return '地面层地铁不能与地面道路交叉';}
      const metros=getMetroNetwork();for(const candidate of candidates)for(const metro of queryNearSegment(metros,candidate,1.5,drawLevel)){if(reroute?.kind==='metros'&&metro.road===reroute.obj)continue;const hit=geometryConflict(candidate,metro);if(!hit)continue;const extensionOrigin=extension?.kind==='metros'&&metro.road===extension.obj&&Math.hypot(hit.x-draft.points[0].x,hit.y-draft.points[0].y)<2;if(!extensionOrigin&&!isStationPoint(hit))return `层级 ${drawLevel>0?'+':''}${drawLevel} 的地铁发生交叉；请通过既有站点接入`;}
      if(reroute?.kind==='metros'){const retainedParts=(reroute.side==='middle'?[reroute.retainedStart,reroute.retainedEnd]:[reroute.retained]).filter(Boolean);for(const part of retainedParts){const retained={points:part.points,segmentModes:part.modes,segmentLevels:part.levels};for(const candidate of candidates)for(const segment of roadRoutingSegments(retained).filter(s=>s.level===drawLevel)){const hit=geometryConflict(candidate,segment);if(!hit)continue;const atCut=(reroute.cutPoints||[]).some(cut=>Math.hypot(hit.x-cut.x,hit.y-cut.y)<2);if(!atCut&&!isStationPoint(hit))return '修改后的地铁不能与保留部分在同层交叉';}}}
      const own=roadRoutingSegments(temp).filter(s=>s.sourceIndex<tempIndex-1&&s.level===drawLevel);for(const candidate of candidates)for(const segment of own){const hit=geometryConflict(candidate,segment);if(hit&&!isStationPoint(hit))return '同一条地铁线路不能在同层自相交';}
    }else if(kind==='road'&&drawLevel===0){const metros=getMetroNetwork();for(const candidate of candidates)for(const metro of queryNearSegment(metros,candidate,1.5,0))if(geometryConflict(candidate,metro))return '地面道路不能与地面层地铁交叉';}
    return null;}
  function buildBusGraph(tolerance) {
    // Fixed junctions are cached; the two route endpoints are attached per search.
    const network=getRoadNetwork(),stops=new Map(),nodes=new Map(),edges=new Map(),joins=[];
    const segmentKey=(road,index)=>`${road.id}:${index}`;
    const addStop=(segment,p)=>{const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?((p.x-a.x)*dx+(p.y-a.y)*dy)/len2:0,key=segmentKey(segment.road,segment.index);if(!stops.has(key))stops.set(key,[]);stops.get(key).push({t,p:{x:p.x,y:p.y,level:segment.level}});};
    network.segments.forEach(segment=>{addStop(segment,segment.a);addStop(segment,segment.b);});
    data.roads.forEach(road=>{const segments=network.routes.get(road.id)||[];segments.forEach((segment,index)=>{if(index&&segments[index-1].level!==segment.level&&Math.hypot(segments[index-1].b.x-segment.a.x,segments[index-1].b.y-segment.a.y)<.1)joins.push([{...segment.a,level:segments[index-1].level},{...segment.a,level:segment.level}]);});});
    roadCrossings().same.forEach(({a,b,hit})=>{addStop(a,hit);addStop(b,hit);});
    data.roads.forEach(road=>road.points.forEach((p,pointIndex)=>{const levels=[...new Set([pointIndex>0?segmentLevel(road,pointIndex-1):null,pointIndex<road.points.length-1?segmentLevel(road,pointIndex):null].filter(v=>v!==null))];levels.forEach(level=>querySpatial(network,p.x-tolerance,p.y-tolerance,p.x+tolerance,p.y+tolerance,level).forEach(segment=>{if(segment.road===road)return;const {a,b}=segment,dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return;const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)),x=a.x+t*dx,y=a.y+t*dy;if(Math.hypot(p.x-x,p.y-y)<=tolerance){addStop(segment,{x,y});joins.push([{x:p.x,y:p.y,level},{x,y,level}]);}}));}));
    const addNode=p=>{const key=pointKey(p);if(!nodes.has(key))nodes.set(key,{x:p.x,y:p.y,level:p.level});if(!edges.has(key))edges.set(key,[]);return key;};
    const connect=(a,b)=>{const ak=addNode(a),bk=addNode(b);if(ak===bk)return;const cost=Math.hypot(a.x-b.x,a.y-b.y);edges.get(ak).push({key:bk,cost});edges.get(bk).push({key:ak,cost});};
    stops.forEach((list,key)=>{const unique=new Map();list.forEach(stop=>unique.set(pointKey(stop.p),stop));const sorted=[...unique.values()].sort((a,b)=>a.t-b.t);stops.set(key,sorted);for(let i=0;i<sorted.length-1;i++)connect(sorted[i].p,sorted[i+1].p);});joins.forEach(([a,b])=>connect(a,b));
    return {routes:network.routes,stops,nodes,edges};
  }

  function getBusGraph(){const network=getRoadNetwork(),box=svg.getBoundingClientRect(),tolerance=Math.max(1,view.w/Math.max(1,box.width)*20),key=Math.round(tolerance*10)/10;if(!network.busGraphs.has(key)){if(network.busGraphs.size>=4)network.busGraphs.delete(network.busGraphs.keys().next().value);network.busGraphs.set(key,buildBusGraph(tolerance));}return network.busGraphs.get(key);}

  function routeAlongRoads(from, to) {
    if(!from||!to)return null;
    const graph=getBusGraph(),dynamicNodes=new Map(),dynamicEdges=new Map();
    const addDynamicNode=p=>{const key=pointKey(p);if(!graph.nodes.has(key)&&!dynamicNodes.has(key))dynamicNodes.set(key,{x:p.x,y:p.y,level:p.level});if(!dynamicEdges.has(key))dynamicEdges.set(key,[]);return key;};
    const connectDynamic=(a,b)=>{const ak=addDynamicNode(a),bk=addDynamicNode(b);if(ak===bk)return;const cost=Math.hypot(a.x-b.x,a.y-b.y);dynamicEdges.get(ak).push({key:bk,cost});dynamicEdges.get(bk).push({key:ak,cost});};
    const attach=snap=>{const segment=graph.routes.get(snap.road.id)?.[snap.segment];if(!segment)return null;const p={x:snap.x,y:snap.y,level:segment.level},key=addDynamicNode(p),dx=segment.b.x-segment.a.x,dy=segment.b.y-segment.a.y,len2=dx*dx+dy*dy,t=len2?((p.x-segment.a.x)*dx+(p.y-segment.a.y)*dy)/len2:0,segmentId=`${snap.road.id}:${snap.segment}`,list=graph.stops.get(segmentId)||[];let previous=null,next=null;for(const stop of list){if(stop.t<=t)previous=stop;if(stop.t>=t&&!next)next=stop;}if(previous)connectDynamic(p,previous.p);if(next)connectDynamic(p,next.p);return {key,p,t,segmentId};};
    const startStop=attach(from),endStop=attach(to);if(!startStop||!endStop)return null;if(startStop.segmentId===endStop.segmentId)connectDynamic(startStop.p,endStop.p);
    const start=startStop.key,end=endStop.key,dist=new Map([[start,0]]),prev=new Map(),heap=[];
    const push=(key,cost)=>{heap.push({key,cost});let i=heap.length-1;while(i){const parent=(i-1)>>1;if(heap[parent].cost<=cost)break;heap[i]=heap[parent];i=parent;}heap[i]={key,cost};};
    const pop=()=>{if(!heap.length)return null;const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(true){let child=i*2+1;if(child>=heap.length)break;if(child+1<heap.length&&heap[child+1].cost<heap[child].cost)child++;if(heap[child].cost>=last.cost)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;};
    push(start,0);while(heap.length){const current=pop();if(current.cost!==dist.get(current.key))continue;if(current.key===end)break;const neighbors=[...(graph.edges.get(current.key)||[]),...(dynamicEdges.get(current.key)||[])];for(const edge of neighbors){const next=current.cost+edge.cost;if(next<(dist.get(edge.key)??Infinity)){dist.set(edge.key,next);prev.set(edge.key,current.key);push(edge.key,next);}}}
    if(!dist.has(end))return null;const path=[];for(let key=end;key;key=prev.get(key)){path.unshift(graph.nodes.get(key)||dynamicNodes.get(key));if(key===start)break;}return path[0]&&pointKey(path[0])===start?path:null;
  }
  function createPointObject(kind, p, line=null) { if(kind==='stations'&&!line){toast('请点击既有地铁线来新增站点');return;} const snap=kind==='stations' ? snapToLine(p,line) : null; if(snap)p={x:snap.x,y:snap.y}; const label=kind === 'stations' ? '站点名称' : '地名或路名'; const name=window.prompt(`请输入${label}`, kind === 'stations' ? '新城站' : '中央广场'); if (name === null) return; const d=kind === 'stations' ? defaults.station : defaults.label; const obj={id:ids(),x:p.x,y:p.y,...d,color:kind==='stations'?(line.color||d.color):d.color,name:name.trim() || (kind === 'stations'?'未命名站':'未命名'),...(snap?{level:segmentLevel(line,snap.segment),lineId:line.id,segmentIndex:snap.segment}:{})}; data[kind].push(obj); selectObject(kind,obj.id); render();recordHistory();saveLocal(false); }
  function hit(e) { const node=e.target.closest?.('[data-kind]'); return node ? {kind:node.dataset.kind,id:node.dataset.id} : null; }
  svg.addEventListener('click', e => { if (suppressClick) return; const target=hit(e), p=toMap(e);
    if(boundaryEdit)return;
    if(reroute?.stage?.startsWith('pick')){pickReroutePoint(p);return;}
    if(reroute?.side==='middle'&&reroute.stage==='ready'){toast('已确定回接位置，请单击右键完成绘制');return;}
    if(tryFinishMiddleReroute(p))return;
    if (tool === 'select') { if (target) selectObject(target.kind,target.id); else { selected=null; renderSelection(); loadInspector(null); } return; }
    if (tool === 'eraser') { if (target) { data[target.kind]=data[target.kind].filter(o=>o.id!==target.id);if(target.kind==='roads'||target.kind==='metros')invalidateNetwork(target.kind);selected=null;render();recordHistory();saveLocal(false);toast('对象已删除'); } return; }
    if (tool === 'station') return createPointObject('stations',p,target?.kind==='metros'?findObject('metros',target.id):null); if (tool === 'label') return createPointObject('labels',p);
    if (tool === 'bus') { const snap=snapToRoad(p,drawLevel); if (!snap) { toast(`当前附近没有层级 ${drawLevel>0?'+':''}${drawLevel} 的道路`); return; } if (!draft) { draft={points:[{x:snap.x,y:snap.y,level:snap.level}],anchor:snap}; cancelPreviewFrame();previewDraft(snap); return; } const route=routeAlongRoads(draft.anchor,snap); if (!route) { toast('两处道路未通过同层路口或匝道连通'); return; } draft.points.push(...route.slice(1)); draft.anchor=snap; cancelPreviewFrame();previewDraft(snap); return; }
    if (tool==='metro') { const station=target?.kind==='stations'?findObject('stations',target.id):null,point=station?{x:station.x,y:station.y}:p,conflict=validateNewSegment('metro',point);if(conflict){toast(conflict);return;}addDraftPoint(point);cancelPreviewFrame();previewDraft(point);return; }
    if (tool==='road') { const snap=snapToRoad(p,drawLevel,reroute?.kind==='roads'?reroute.obj:null),point=snap?{x:snap.x,y:snap.y}:p,conflict=validateNewSegment('road',point);if(conflict){toast(conflict);return;}addDraftPoint(point);cancelPreviewFrame();previewDraft(point);return; }
    if(['building','area'].includes(tool)){if(!draft)draft={points:[p]};else draft.points.push(p);cancelPreviewFrame();previewDraft(p);}
  });
  svg.addEventListener('contextmenu', e => { if (['road','bus','metro','building','area'].includes(tool)) { e.preventDefault(); finishDraft(); } });
  svg.addEventListener('pointerdown', e => { const labelNode=e.target.closest?.('[data-label-kind]');if(labelNode&&beginLabelDrag(labelNode,e))return;const vertex=e.target.closest?.('[data-boundary-index]');if(boundaryEdit&&vertex){boundaryEdit.dragIndex=+vertex.dataset.boundaryIndex;viewport.setPointerCapture?.(e.pointerId);e.preventDefault();return;}const allowPan=tool==='select'||e.button===1||spacePanning;if(!allowPan||(!spacePanning&&e.button!==1&&hit(e)))return;panning={clientX:e.clientX,clientY:e.clientY,view:{...view},moved:false};viewport.setPointerCapture?.(e.pointerId);e.preventDefault(); });
  function applyPendingPan(){const position=pendingPanPosition;pendingPanPosition=null;if(!panning||!position)return;const box=svg.getBoundingClientRect(),dx=(position.clientX-panning.clientX)*panning.view.w/box.width,dy=(position.clientY-panning.clientY)*panning.view.h/box.height;view.x=panning.view.x-dx;view.y=panning.view.y-dy;panning.moved=panning.moved||Math.abs(position.clientX-panning.clientX)>2||Math.abs(position.clientY-panning.clientY)>2;viewport.classList.add('panning');applyView();}
  function schedulePan(clientX,clientY){pendingPanPosition={clientX,clientY};if(panFrame)return;panFrame=requestAnimationFrame(()=>{panFrame=0;applyPendingPan();});}
  function flushPan(){if(panFrame)cancelAnimationFrame(panFrame);panFrame=0;applyPendingPan();}
  svg.addEventListener('pointermove', e => { if(labelDrag)moveLabel(e);else if(boundaryEdit&&boundaryEdit.dragIndex!==null){boundaryEdit.points[boundaryEdit.dragIndex]=toMap(e);renderSelection();}else if(panning)schedulePan(e.clientX,e.clientY);else if(draft&&reroute?.stage!=='ready')scheduleDraftPreview(e.clientX,e.clientY); });
  function endPan(){flushPan();const moved=panning?.moved;if(moved){suppressClick=true;setTimeout(()=>suppressClick=false,0);}panning=null;viewport.classList.remove('panning');if(moved)scheduleViewportRender(0);}
  function endPointer(){if(labelDrag){finishLabelDrag();return;}if(boundaryEdit&&boundaryEdit.dragIndex!==null){boundaryEdit.dragIndex=null;return;}endPan();}
  svg.addEventListener('pointerup',endPointer);svg.addEventListener('pointercancel',endPointer);
  viewport.addEventListener('wheel',e=>{e.preventDefault();const p=toMap(e),delta=clamp(e.deltaY,-160,160),target=zoomPercent()*Math.exp(-delta*.0018);setZoom(target,p);},{passive:false});
  $('#zoomIn').addEventListener('click',()=>setZoom(zoomPercent()*1.25));$('#zoomOut').addEventListener('click',()=>setZoom(zoomPercent()*.8));
  $('#zoomSlider').addEventListener('input',e=>setZoom(+e.target.value));$('#fitMap').addEventListener('click',fitMap);$('#resetView').addEventListener('click',resetView);
  document.querySelectorAll('[data-pan]').forEach(button=>button.addEventListener('click',()=>button.dataset.pan==='center'?resetView():panView(button.dataset.pan)));
  document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
  document.querySelectorAll('[data-draw-mode]').forEach(b=>b.addEventListener('click',()=>setDrawMode(b.dataset.drawMode)));
  $('#levelUp').addEventListener('click',()=>setDrawLevel(drawLevel+1));$('#levelDown').addEventListener('click',()=>setDrawLevel(drawLevel-1));
  $('#extendStart').addEventListener('click',()=>startExtension('start'));$('#extendEnd').addEventListener('click',()=>startExtension('end'));
  $('#rerouteStart').addEventListener('click',()=>startReroute('start'));$('#rerouteEnd').addEventListener('click',()=>startReroute('end'));$('#rerouteMiddle').addEventListener('click',()=>startReroute('middle'));
  $('#editBoundary').addEventListener('click',()=>boundaryEdit?finishBoundaryEdit():startBoundaryEdit());$('#cancelBoundary').addEventListener('click',cancelBoundaryEdit);
  document.addEventListener('keydown',e=>{ if(e.code==='Space'&&!e.target.matches('input,select,button')){e.preventDefault();spacePanning=true;viewport.classList.add('space-pan');return;}if (e.target.matches('input,select')) return; const key=e.key.toLowerCase(),keys={v:'select',r:'road',b:'bus',m:'metro',t:'metro',s:'station',g:'building',a:'area',l:'label',e:'eraser'}; if (keys[key]) setTool(keys[key]); if(['road','metro'].includes(tool)&&key==='c')setDrawMode('curve');if(['road','metro'].includes(tool)&&key==='x')setDrawMode('line');if(['road','bus','metro'].includes(tool)&&e.key==='ArrowUp'){e.preventDefault();setDrawLevel(drawLevel+1);}if(['road','bus','metro'].includes(tool)&&e.key==='ArrowDown'){e.preventDefault();setDrawLevel(drawLevel-1);} if (e.key==='Escape') { const wasEditing=!!extension||!!reroute;if(boundaryEdit)cancelBoundaryEdit();draft=null;extension=null;reroute=null;cancelPreviewFrame();preview.replaceChildren();if(wasEditing)setDrawLevel(drawLevel); } if ((e.key==='Delete'||e.key==='Backspace')&&selected){const kind=selected.kind;data[kind]=data[kind].filter(o=>o.id!==selected.obj.id);if(kind==='roads'||kind==='metros')invalidateNetwork(kind);boundaryEdit=null;reroute=null;selected=null;render();recordHistory();saveLocal(false);} });
  document.addEventListener('keydown',e=>{if(e.target.matches('input,select,button')||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='+'||e.key==='='){e.preventDefault();setZoom(zoomPercent()*1.25);}else if(e.key==='-'||e.key==='_'){e.preventDefault();setZoom(zoomPercent()*.8);}else if(e.key==='0'){e.preventDefault();resetView();}else if(e.key==='Home'){e.preventDefault();fitMap();}});
  document.addEventListener('keyup',e=>{if(e.code==='Space'){spacePanning=false;viewport.classList.remove('space-pan');}});window.addEventListener('blur',()=>{spacePanning=false;viewport.classList.remove('space-pan');finishLabelDrag();endPan();});
  $('#objectWidth').addEventListener('input',e=>$('#widthValue').value=e.target.value); $('#labelSize').addEventListener('input',e=>$('#labelSizeValue').value=e.target.value);$('#transitLabelSize').addEventListener('input',e=>$('#transitLabelSizeValue').value=e.target.value);
  $('#roadClass').addEventListener('change',e=>{const style=roadClassStyles[e.target.value];if(!style)return;$('#objectWidth').value=style.width;$('#widthValue').value=style.width;$('#objectColor').value=style.color;});
  $('#applyStyle').addEventListener('click',()=>{ if(!selected)return; const o=selected.obj;o.name=$('#objectName').value.trim();o.color=$('#objectColor').value;o.width=+$('#objectWidth').value;o.lineStyle=$('#lineStyle').value;o.size=+$('#labelSize').value;if(selected.kind==='roads')o.roadClass=$('#roadClass').value;if(['buses','metros'].includes(selected.kind)){o.labelShape=$('#transitLabelShape').value;o.labelColor=$('#transitLabelColor').value;o.labelTextColor=$('#transitLabelTextColor').value;o.labelSize=+$('#transitLabelSize').value;}render();recordHistory();saveLocal(false);toast('样式已应用'); });
  $('#resetTransitLabelPosition').addEventListener('click',()=>{if(!selected||!['buses','metros'].includes(selected.kind))return;selected.obj.labelOffsetX=0;selected.obj.labelOffsetY=0;render();recordHistory();saveLocal(false);toast('线路名称位置已重置');});
  document.querySelectorAll('[data-layer]').forEach(i=>i.addEventListener('change',render));
  function normalizeMap(v) { if (!v || !['roads','stations','labels'].every(k=>Array.isArray(v[k]))) return null; return { title:v.title || '未命名城市', roads:v.roads, buses:Array.isArray(v.buses)?v.buses:[], metros:Array.isArray(v.metros)?v.metros:(Array.isArray(v.transit)?v.transit:[]), stations:v.stations, buildings:Array.isArray(v.buildings)?v.buildings:[], areas:Array.isArray(v.areas)?v.areas:[], labels:v.labels }; }
  function historySnapshot(){return JSON.stringify(data);}
  function updateHistoryControls(){$('#undoAction').disabled=historyIndex<=0;$('#redoAction').disabled=historyIndex>=history.length-1;}
  function initializeHistory(){history=[historySnapshot()];historyIndex=0;updateHistoryControls();}
  function recordHistory(){const snapshot=historySnapshot();if(history[historyIndex]===snapshot)return;history.splice(historyIndex+1);history.push(snapshot);if(history.length>HISTORY_LIMIT)history.shift();historyIndex=history.length-1;updateHistoryControls();}
  function restoreHistory(index){if(index<0||index>=history.length)return;const restored=normalizeMap(JSON.parse(history[index]));if(!restored)return;historyIndex=index;data=restored;invalidateNetwork();draft=null;extension=null;reroute=null;boundaryEdit=null;labelDrag=null;selected=null;cancelPreviewFrame();preview.replaceChildren();$('#projectTitle').value=data.title;render();loadInspector(null);saveLocal(false);updateHistoryControls();}
  function undo(){if(historyIndex<=0)return;restoreHistory(historyIndex-1);toast('已撤销');}
  function redo(){if(historyIndex>=history.length-1)return;restoreHistory(historyIndex+1);toast('已重做');}
  function saveLocal(show=true){ data.title=$('#projectTitle').value.trim()||'未命名城市'; localStorage.setItem('fictional-city-map-v1',JSON.stringify(data));if(show)toast('已保存到此浏览器'); }
  function toast(s){const t=$('#toast');t.textContent=s;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2200);}
  $('#undoAction').addEventListener('click',undo);$('#redoAction').addEventListener('click',redo);
  document.addEventListener('keydown',e=>{if(!(e.ctrlKey||e.metaKey)||e.target.matches('input,select,textarea')||e.target.isContentEditable)return;const key=e.key.toLowerCase();if(key==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();}else if(key==='y'){e.preventDefault();redo();}});
  $('#saveMap').addEventListener('click',()=>saveLocal()); $('#projectTitle').addEventListener('change',()=>{saveLocal(false);recordHistory();});
  $('#newMap').addEventListener('click',()=>{if(!confirm('新建地图会清空当前画布；已保存的本地内容也会被替换。继续吗？'))return;data={title:'新曙光市',roads:[],buses:[],metros:[],stations:[],buildings:[],areas:[],labels:[]};invalidateNetwork();draft=null;extension=null;reroute=null;boundaryEdit=null;cancelPreviewFrame();preview.replaceChildren();$('#projectTitle').value=data.title;selected=null;render();recordHistory();saveLocal(false);});
  $('#exportMap').addEventListener('click',()=>{saveLocal(false);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=`${data.title||'city-map'}.json`;a.click();URL.revokeObjectURL(a.href);toast('地图 JSON 已导出');});
  $('#importMap').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const v=normalizeMap(JSON.parse(await f.text()));if(!v)throw Error();data=v;invalidateNetwork();draft=null;extension=null;reroute=null;boundaryEdit=null;cancelPreviewFrame();preview.replaceChildren();$('#projectTitle').value=v.title;selected=null;render();recordHistory();saveLocal(false);toast('地图已导入');}catch{toast('无法读取此地图文件');}e.target.value='';});
  try { const stored=normalizeMap(JSON.parse(localStorage.getItem('fictional-city-map-v1'))); if(stored) { data=stored; $('#projectTitle').value=data.title; } } catch {}
  initializeHistory();render();loadInspector(null);applyView();
})();
