/* Cards and view state: the node detail card, the layer switch, language switching and
   the stored layer/language preference; the shell back handler closes these first. */

  /* -------------------------------------------------------------- shell back */
  /* The panel and the node card are dismissible layers of the page, and on Android the back
     gesture has to close them before it leaves the app. The shell cannot see the page's
     state, so the page keeps it informed: syncBack() reports how many layers are open
     through NPBack.setDepth() whenever that changes, and window.NodepulseBack() is the one
     call the shell makes when the gesture arrives. It answers whether it consumed the
     press. A plain browser has no NPBack and never calls either. */
  function cardOpen() {
    var m = $('modal');
    return !!(m && m.classList.contains('on'));
  }

  /* The entities sheet is a layer of its own: the list is one level, an entity detail is
     two. Ent.depth() answers 0 when it is closed. */
  function entDepth() { return (typeof Ent !== 'undefined' && Ent.depth) ? Ent.depth() : 0; }

  function backDepth() {
    var ed = entDepth();
    if (ed) return ed;
    return cardOpen() ? 2 : (S.panelOpen ? 1 : 0);
  }

  function syncBack() {
    try {
      if (window.NPBack && typeof window.NPBack.setDepth === 'function') window.NPBack.setDepth(backDepth());
    } catch (e) { }
  }

  window.NodepulseBack = function () {
    if (entDepth() && Ent.back()) return true;
    if (cardOpen()) { closeNodeCard(); return true; }
    if (S.panelOpen) { setPanel(false); return true; }
    return false;
  };

  function setPanel(open) {
    /* On the ENTITIES layer the panel button opens the entity sheet instead: there is no
       L1/Lightning block for it to reveal. */
    if (open && S.layer === 'entities') { showEntSheet(); return; }
    S.panelOpen = !!open;
    var top = $('topbar'), btn = $('toggle');
    if (top) top.classList.toggle('open', S.panelOpen);
    if (btn) {
      btn.textContent = S.panelOpen ? '−' : '+';
      btn.setAttribute('aria-expanded', S.panelOpen ? 'true' : 'false');
      btn.setAttribute('aria-label', S.panelOpen ? L('pClose') : L('pOpen'));
    }
    if (S.panelOpen) paintPanel();
    syncBack();
  }

  function showEntSheet() {
    if (typeof Ent === 'undefined') return;
    if (S.panelOpen) setPanel(false);
    Ent.open();
  }

  /* ------------------------------------------------------------ node card */
  function showNodeCard(cluster) {
    if (S.layer === 'l1') showL1Card(cluster);
    else if (S.layer === 'ln') showLNCard(cluster);
    else return;                       // the entities globe carries no dots to open
    $('modal').classList.add('on');
    Globe.hold(true);
    var cb = $('cardClose');
    if (cb) cb.addEventListener('click', closeNodeCard);
    syncBack();
  }

  function closeNodeCard() {
    var m = $('modal');
    if (m) m.classList.remove('on');
    Globe.hold(false);
    syncBack();
  }

  function cardRows(rows) {
    return rows.map(function (r) {
      return '<div class="cell' + (r[2] ? ' full' : '') + '"><dt>' + esc(r[0]) + '</dt><dd class="' + (r[1] === '—' ? 'na' : '') + '">' + esc(r[1]) + '</dd></div>';
    }).join('');
  }

  function showL1Card(cluster) {
    var s = l1Snap();
    var l1 = S.l1 || {};
    var pt = cluster.pts && cluster.pts.length ? cluster.pts[0] : [cluster.lat, cluster.lon];
    var iso = cluster.iso || '';
    var place = iso ? countryName(iso, '') + (iso ? ' (' + iso + ')' : '') : '—';
    var card = $('card');
    if (!card) return;
    var rows = [
      [L('cCoord'), pt[0].toFixed(4) + '°, ' + pt[1].toFixed(4) + '°'],
      [L('cCell'), fmtInt(cluster.count) + ' ' + L('cCells')],
      [L('cCountry'), place],
      [L('cSrc'), l1.src === 'live' ? 'Bitnodes ' + L('live') : l1.src === 'cache' ? 'Bitnodes ' + L('cache') : 'Bitnodes ' + L('snap')],
      [L('cSnapAt'), l1.at ? dateOf(l1.at) : '—'],
      [L('cHeight'), S.tip === null ? '—' : fmtInt(S.tip)]
    ];
    card.innerHTML =
      '<div class="card-head"><div>' +
      '<div class="kicker">BITCOIN L1 · FULL NODE</div>' +
      '<h2>' + esc(pt[0].toFixed(2) + '°, ' + pt[1].toFixed(2) + '°') + '</h2>' +
      '<p class="place">' + esc(place === '—' ? L('cWhere') + ' ' + (iso || '—') : place) + '</p>' +
      '</div><button class="close" id="cardClose" aria-label="close">×</button></div>' +
      '<dl class="grid">' + cardRows(rows) + '</dl>' +
      (s && s.capturedAt ? '<div class="disc">' + L('cCountry') + ': Bitnodes ' + dateOf(s.capturedAt * 1000).slice(0, 10) + ' · ' + fmtInt(s.totalNodes) + ' nodes</div>' : '') +
      '<p class="disc"><b>Bitnodes</b> · ' + esc(L('cL1Note')) + '</p>';
  }

  function showLNCard(cluster) {
    var n = cluster.nodes[0];
    var many = cluster.nodes.length > 1;
    var continent = contName(contOf(n.iso));
    var place = [n.city, n.country].filter(Boolean).join(' · ');
    var chainTipHash = null, chainTipHeight = S.tip;
    if (S.blocks && S.blocks.length) chainTipHash = S.blocks[0].id;

    var card = $('card');
    if (!card) return;
    var rows = [
      [L('cCoord'), num(n.lat) && num(n.lon) ? n.lat.toFixed(4) + '°, ' + n.lon.toFixed(4) + '°' : '—'],
      [L('cCountry'), (countryName(n.iso, n.country) || '—') + (n.iso ? ' (' + n.iso + ')' : '')],
      [L('cCh'), num(n.channels) ? fmtInt(n.channels) : '—'],
      [L('cCap'), num(n.capacity) ? fmtBtcCap(n.capacity) + ' BTC' : '—'],
      [L('cMapCh'), num(n.deg) ? fmtInt(n.deg) : '—'],
      [L('cAS'), n.asOrg || '—'],
      [L('cSock'), n.sockets ? n.sockets + L('sockUnit') + (n.tor ? ' · Tor' : ' · clearnet') : '—'],
      [L('cFirst'), dateOf(n.firstSeen)],
      [L('cUpd'), n.updatedAt ? dateOf(n.updatedAt) : '—']
    ];
    if (many) rows.push([L('cCluster'), cluster.count + L('unitNodes') + ' · ' + fmtInt(cluster.channels) + L('unitCh'), true]);

    var aliasList = many ? cluster.nodes.map(function (x) { return esc(x.alias); }).slice(0, 6).join(', ') : '';
    var peers = n.peers || [];
    var peerHTML = peers.length
      ? '<div class="peers"><div class="t">' + L('cPeers') + '</div><div class="p">' +
        peers.map(function (a) { return '<span class="peer">' + esc(a) + '</span>'; }).join('') +
        '</div><div class="v">' + fmtInt(cluster.deg) + ' / ' + cluster.arcs + ' · channels-geo</div></div>'
      : '';

    card.innerHTML =
      '<div class="card-head"><div>' +
      '<div class="kicker">NODE · ' + esc(continent) + '</div>' +
      '<h2>' + esc(n.alias) + '</h2>' +
      '<p class="place">' + esc(place || '—') + '</p>' +
      '</div><button class="close" id="cardClose" aria-label="' + esc(L('cClose')) + '">×</button></div>' +
      '<dl class="grid">' + cardRows(rows) + '</dl>' +
      peerHTML +
      (aliasList ? '<div class="disc tight">' + aliasList + (cluster.nodes.length > 6 ? ' +' + (cluster.nodes.length - 6) : '') + '</div>' : '') +
      '<div class="tip"><div class="t">' + L('cChainTip') + '</div>' +
      '<div class="h">' + esc(chainTipHash || '—') + '</div>' +
      '<div class="v">' + L('cHeight') + ' ' + (chainTipHeight === null ? '—' : fmtInt(chainTipHeight)) + ' · ' + esc(S.nodeSrc === 'seed' ? L('snap') : ago(S.nodeAt)) + '</div></div>' +
      '<p class="disc">' + esc(L('cLNNote')) + '</p>';
  }

  /* ------------------------------------------------------------- layer */
  /* Three layers share one globe and one stylesheet: L1 (cyan), Lightning (violet) and
     Entities (the same cyan shell, with the entity accent on its own panel). The body
     class is what every CSS rule keys off, so it is set in one place. */
  function layerClass(layer) {
    var b = document.body;
    if (!b || !b.classList) return;
    b.classList.toggle('l1', layer === 'l1');
    b.classList.toggle('ln', layer === 'ln');
    /* `layer-ent`, not `ent`: the sheet element is the div with id `ent` and class `ent`,
       and a body class of the same name let the sheet's own `.ent{display:none;
       position:fixed}` rule match the body and hide the whole page on this layer. One
       name, one element. */
    b.classList.toggle('layer-ent', layer === 'entities');
  }

  function setLayer(layer) {
    if (layer !== 'l1' && layer !== 'ln' && layer !== 'entities') return;
    S.layer = layer;
    layerClass(layer);
    mark($('layerL1'), 'on', layer === 'l1');
    mark($('layerLN'), 'on', layer === 'ln');
    mark($('layerEN'), 'on', layer === 'entities');
    var b1 = $('layerL1'), b2 = $('layerLN'), b3 = $('layerEN');
    if (b1) b1.setAttribute('aria-selected', layer === 'l1' ? 'true' : 'false');
    if (b2) b2.setAttribute('aria-selected', layer === 'ln' ? 'true' : 'false');
    if (b3) b3.setAttribute('aria-selected', layer === 'entities' ? 'true' : 'false');
    var cv = $('globe');
    if (cv) cv.setAttribute('aria-label', L(layer === 'l1' ? 'ariaL1' : layer === 'ln' ? 'ariaLN' : 'ariaEN'));
    show('secL1Wrap', layer === 'l1');
    show('secVerWrap', layer === 'l1');
    show('secLNWrap', layer === 'ln');
    txt('subrow', subrowText());
    txt('distTitle', layer === 'l1' ? L('secDistL1') : L('secDistLN'));
    paintLegend();
    Globe.build();
    Globe.retheme();
    noteDirty = true;
    storePref();
    schedulePaint();
    /* Switching to ENTITIES opens the sheet with the table; leaving closes it, so the
       globe is not left behind an overlay the tab no longer owns. */
    if (typeof Ent !== 'undefined' && Ent) {
      if (layer === 'entities') Ent.open(); else Ent.close();
    }
  }

  function storePref() { store(LS_PREF, { layer: S.layer }); }
  function loadPref() {
    var p = recall(LS_PREF);
    if (!p) return;
    if (p.layer === 'l1' || p.layer === 'ln' || p.layer === 'entities') S.layer = p.layer;
  }

