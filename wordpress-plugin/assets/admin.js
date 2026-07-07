(function(){
  var LABELS = { https:"HTTPS", ssl:"SSL", cloudflare:"Cloudflare", ctm:"CTM", googleTag:"Google Tag", pagespeed:"PageSpeed", plugins:"Updates" };
  var ORDER = ["https","ssl","cloudflare","ctm","googleTag","pagespeed","plugins"];
  var grid = document.getElementById("deheled-grid");
  var btn  = document.getElementById("deheled-run");
  var cached = DEHELED_DATA.cached;
  var esc = function(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); };

  function card(key, c){
    var extra = "";
    if (key === "plugins" && c.meta){
      var u = c.meta.plugin_updates||[], t = c.meta.theme_updates||[];
      if (c.meta.core_update_available) extra += '<div class="d">WordPress core &#8594; '+esc(c.meta.core_new_version||"update")+'</div>';
      if (u.length) extra += '<ul>'+u.map(function(p){return '<li><span>'+esc(p.name)+'</span><span class="ver">'+esc(p.current||"?")+' &#8594; '+esc(p.new_version||"?")+'</span></li>';}).join("")+'</ul>';
      if (t.length) extra += '<ul>'+t.map(function(p){return '<li><span>'+esc(p.name)+' (theme)</span><span class="ver">'+esc(p.current||"?")+' &#8594; '+esc(p.new_version||"?")+'</span></li>';}).join("")+'</ul>';
    }
    return '<div class="deheled-card '+c.status+'">'
      + '<h3><span class="deheled-dot '+c.status+'"></span>'+LABELS[key]+'</h3>'
      + '<div class="v">'+esc(c.label||"\u2014")+'</div>'
      + '<div class="d">'+esc(c.detail||"")+'</div>'+extra+'</div>';
  }
  function render(data){
    if(!data || !data.checks){ grid.innerHTML = '<div class="deheled-empty">No data yet &mdash; click <strong>Run checks now</strong>.</div>'; return; }
    grid.innerHTML = ORDER.map(function(k){ return card(k, data.checks[k]||{status:"skip",label:"\u2014"}); }).join("");
  }
  function run(){
    btn.classList.add("busy"); btn.textContent = "Running\u2026";
    var body = new URLSearchParams({ action:"deheled_run", _ajax_nonce: DEHELED_DATA.nonce });
    fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j && j.success){ render(j.data); document.getElementById("deheled-checked").textContent = "Last checked just now"; }
        btn.classList.remove("busy"); btn.textContent = "Run checks now";
      })
      .catch(function(){ btn.classList.remove("busy"); btn.textContent = "Run checks now"; });
  }
  btn.addEventListener("click", run);
  render(cached);

  // ---- Security scan ----
  var secBtn  = document.getElementById("deheled-scan");
  var secBody = document.getElementById("deheled-sec-body");
  var secWhen = document.getElementById("deheled-sec-when");
  var secData = DEHELED_DATA.sec;

  function renderSec(d){
    if(!d){ secBody.innerHTML = ""; return; }
    var f = d.findings || [];
    if(!f.length){
      secBody.innerHTML = '<div class="deheled-sec-clean">&#10003; No threats found &middot; '
        + (d.files_scanned||0) + ' files scanned'
        + (d.partial ? ' (scan hit its time limit; large sites may need a rescan)' : '') + '</div>';
      return;
    }
    secBody.innerHTML = '<ul class="deheled-sec-list">' + f.map(function(x){
      return '<li><span class="deheled-sec-sev '+(x.sev==="high"?"high":"med")+'">'+(x.sev==="high"?"High":"Review")+'</span>'
        + '<span>'+esc(x.msg)+(x.file?' <span class="deheled-sec-file">'+esc(x.file)+'</span>':'')+'</span></li>';
    }).join("") + '</ul>';
  }
  function scan(){
    secBtn.classList.add("busy"); secBtn.textContent = "Scanning\u2026";
    var body = new URLSearchParams({ action:"deheled_scan", _ajax_nonce: DEHELED_DATA.nonce });
    fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j && j.success){ renderSec(j.data); secWhen.textContent = "Last scan just now"; }
        secBtn.classList.remove("busy"); secBtn.textContent = "Run scan now";
      })
      .catch(function(){ secBtn.classList.remove("busy"); secBtn.textContent = "Run scan now"; });
  }
  secBtn.addEventListener("click", scan);
  renderSec(secData);

  // ---- History & trends ----
  var histDays = 30;
  function downsample(vals, target){
    if(vals.length <= target) return vals;
    var out = [], b = vals.length / target;
    for(var i=0;i<target;i++){
      var s = vals.slice(Math.floor(i*b), Math.floor((i+1)*b) || Math.floor(i*b)+1);
      out.push(s.reduce(function(a,x){return a+x;},0)/s.length);
    }
    return out;
  }
  function lineSvg(raw, color, zeroBase){
    var vals = downsample(raw, 120);
    if(vals.length < 2) return "";
    var W=260,H=46,pad=4;
    var min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
    if(zeroBase) min=Math.min(min,0);
    if(min===max){min-=1;max+=1;}
    var step=(W-pad*2)/(vals.length-1);
    var pts=vals.map(function(v,i){return (pad+i*step).toFixed(1)+","+(pad+(1-(v-min)/(max-min))*(H-pad*2)).toFixed(1);}).join(" ");
    return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" width="100%" height="'+H+'"><polyline fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="'+pts+'"/></svg>';
  }
  function relTime(iso){
    var s=(Date.now()-new Date(iso).getTime())/1000;
    if(s<60) return "just now";
    if(s<3600) return Math.floor(s/60)+"m ago";
    if(s<86400) return Math.floor(s/3600)+"h ago";
    var d=Math.floor(s/86400);
    return d<30 ? d+"d ago" : new Date(iso).toLocaleDateString();
  }
  var HLBL = { ok:["#22c55e","Operational"], warn:["#f59e0b","Warning"], fail:["#ef4444","Failing"], skip:["#8c8f94","Pending"] };
  function renderHist(d){
    var up = document.getElementById("deheled-hist-up");
    up.textContent = (d.uptime==null ? "\u2014" : d.uptime+"%") + " uptime \u00b7 " + d.days + " days";
    var S = d.samples || [];
    var pick = function(k){ return S.filter(function(s){return typeof s[k]==="number";}).map(function(s){return s[k];}); };
    var ps = pick("pagespeed"), rt = pick("responseMs"), ssl = pick("sslDays");
    var psColor = ps.length ? (ps[ps.length-1]>=90 ? "#22c55e" : ps[ps.length-1]>=50 ? "#f59e0b" : "#ef4444") : "#2271b1";
    function card(label, vals, color, zero, fmt){
      if(vals.length < 2) return "";
      return '<div class="deheled-hchart"><div class="deheled-hchart-head"><span>'+label+'</span><strong>'+fmt(vals[vals.length-1])+'</strong></div>'+lineSvg(vals,color,zero)+'</div>';
    }
    var charts =
      card("PageSpeed", ps, psColor, false, function(v){return Math.round(v);}) +
      card("Response time", rt, "#2271b1", true, function(v){return Math.round(v)+"ms";}) +
      card("SSL days left", ssl, "#6366f1", true, function(v){return Math.round(v)+"d";});
    document.getElementById("deheled-hist-charts").innerHTML =
      charts || '<p class="description">Trends appear once the dashboard has collected a few samples.</p>';
    var ev = (d.events||[]).slice(0,6).map(function(e){
      var to=HLBL[e.to]||HLBL.skip, from=e.from?(HLBL[e.from]||HLBL.skip)[1]:"New";
      return '<li><span class="deheled-hdot" style="background:'+to[0]+'"></span>'+esc(from)+' \u2192 '+esc(to[1])+'<span class="deheled-hwhen">'+relTime(e.at)+'</span></li>';
    }).join("");
    document.getElementById("deheled-hist-events").innerHTML = ev;
  }
  function loadHist(days){
    histDays = days;
    var msg = document.getElementById("deheled-hist-msg");
    msg.style.display = "none";
    document.querySelectorAll(".deheled-range").forEach(function(b){ b.classList.toggle("is-on", parseInt(b.dataset.days,10)===days); });
    var body = new URLSearchParams({ action:"deheled_history", days:String(days), _ajax_nonce: DEHELED_DATA.nonce });
    fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j && j.success){ renderHist(j.data); }
        else { msg.textContent = (j && j.data ? j.data : "History unavailable") + " \u2014 make sure the monitoring license is active."; msg.style.display = ""; }
      })
      .catch(function(){ msg.textContent = "Could not load history."; msg.style.display = ""; });
  }
  document.querySelectorAll(".deheled-range").forEach(function(b){
    b.addEventListener("click", function(){ loadHist(parseInt(b.dataset.days,10)); });
  });
  loadHist(30);

  // ---- License field lock/unlock ----
  var licChange = document.getElementById("deheled-lic-change");
  if (licChange) {
    licChange.addEventListener("click", function () {
      var input = document.getElementById("deheled-lic-input");
      input.removeAttribute("readonly");
      input.focus();
      input.select();
      licChange.style.display = "none";
      document.getElementById("deheled-lic-save").style.display = "";
    });
  }
})();
