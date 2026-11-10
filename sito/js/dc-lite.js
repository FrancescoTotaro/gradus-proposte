/* dc-lite 2: motore minimo per mostrare fuori dal canvas le tavole di Claude Design.
   Gestisce più componenti per pagina (<dc-import>), segnaposto {{nome}}, <sc-if>, <sc-for>,
   eventi (onClick, onChange, onBlur, onSubmit…), stato e ciclo di vita stile React.
   Ricalcola la pagina a ogni cambio di stato e la aggiorna con morphdom, senza perdere
   quello che l'utente ha scritto nei campi. Solo per le anteprime: il sito vero sarà WordPress. */
(function () {
  'use strict';

  var defs = {};          // nome componente -> { frag, Cls }
  var insts = {};         // chiave istanza -> istanza
  var rootEl, rootName, pending = false, fns = [], rendering = false, passes = 0;
  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  var EVMAP = { onclick: 'click', onchange: 'input', oninput: 'input', onblur: 'blur', onfocus: 'focus', onsubmit: 'submit',
    onkeydown: 'keydown', onkeyup: 'keyup', onmouseenter: 'mouseenter', onmouseleave: 'mouseleave', onscroll: 'scroll',
    onanimationend: 'animationend', ontransitionend: 'transitionend', onpointerdown: 'pointerdown', onpointerup: 'pointerup' };

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (u, cb) {
    var next = typeof u === 'function' ? u(this.state, this.props) : u;
    if (next) this.state = Object.assign({}, this.state, next);
    schedule();
    if (cb) Promise.resolve().then(cb);
  };
  DCLogic.prototype.forceUpdate = function () { schedule(); };
  window.DCLogic = DCLogic;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^'.*'$|^".*"$/.test(path)) return path.slice(1, -1);
    var parts = path.split('.'), v, first = parts[0], s = scope;
    while (s && !(s.locals && Object.prototype.hasOwnProperty.call(s.locals, first))) s = s.up;
    v = s ? s.locals[first] : (scope.vals ? scope.vals[first] : undefined);
    for (var i = 1; i < parts.length && v !== null && v !== undefined; i++) v = v[parts[i]];
    return v;
  }
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  function interp(str, scope) {
    return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (_, p) {
      var v = lookup(p, scope);
      return v === null || v === undefined || typeof v === 'function' || v === false ? '' : String(v);
    });
  }
  function truthy(v) { return !(v === false || v === null || v === undefined || v === 0 || v === '' || v === 'false'); }

  function renderNodes(nodes, scope, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) out += renderNode(nodes[i], scope, ctx);
    return out;
  }

  function renderNode(n, scope, ctx) {
    if (n.nodeType === 3) return esc(interp(n.nodeValue, scope)).replace(/&quot;/g, '"');
    if (n.nodeType === 8) return '';
    if (n.nodeType !== 1) return '';
    var isHtml = n.namespaceURI === 'http://www.w3.org/1999/xhtml';
    var tag = isHtml ? n.tagName.toLowerCase() : n.tagName;
    var kids = n.tagName.toLowerCase() === 'template' ? n.content.childNodes : n.childNodes;

    if (tag === 'sc-if') {
      var a = n.getAttribute('value') || '', m = a.match(WHOLE);
      var cond = m ? lookup(m[1], scope) : a;
      return truthy(cond) ? renderNodes(kids, scope, ctx) : '';
    }
    if (tag === 'sc-for') {
      var lm = (n.getAttribute('list') || '').match(WHOLE);
      var list = lm ? lookup(lm[1], scope) : null, as = n.getAttribute('as') || 'item', out = '';
      if (list && list.length) {
        for (var j = 0; j < list.length; j++) {
          var loc = {}; loc[as] = list[j]; loc.$index = j;
          var saved = ctx.loop; ctx.loop = (saved || '') + '.' + j;
          out += renderNodes(kids, { vals: scope.vals, locals: loc, up: scope }, ctx);
          ctx.loop = saved;
        }
      }
      return out;
    }
    if (tag === 'dc-import') return renderImport(n, scope, ctx);
    if (tag === 'helmet') return '';

    var attrs = '', evs = [];
    for (var k = 0; k < n.attributes.length; k++) {
      var at = n.attributes[k], name = at.name, val = at.value, wm = val.match(WHOLE);
      var lname = name.toLowerCase();
      if (EVMAP[lname] || /^on[a-z]+$/.test(lname)) {
        if (wm) {
          var fn = lookup(wm[1], scope);
          if (typeof fn === 'function') evs.push((EVMAP[lname] || lname.slice(2)) + ':' + (fns.push(fn) - 1));
        }
        continue;
      }
      if (/^hint-/.test(lname)) continue;
      if (wm) {
        var v = lookup(wm[1], scope);
        if (v === null || v === undefined || v === false || typeof v === 'function') continue;
        if (v === true) { attrs += /^(aria-|data-)/.test(lname) ? ' ' + name + '="true"' : ' ' + name + '=""'; continue; }
        attrs += ' ' + name + '="' + esc(v) + '"';
      } else {
        attrs += ' ' + name + '="' + esc(val.indexOf('{{') === -1 ? val : interp(val, scope)) + '"';
      }
    }
    if (evs.length) attrs += ' data-dc-ev="' + evs.join(' ') + '"';
    if (VOID.test(tag) && isHtml) return '<' + tag + attrs + '>';
    var inner;
    if (tag === 'style' || tag === 'script') inner = interp(n.textContent, scope);
    else if (tag === 'textarea') inner = esc(interp(n.textContent, scope));
    else inner = renderNodes(kids, scope, ctx);
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  }

  function renderImport(n, scope, ctx) {
    var name = n.getAttribute('name');
    if (!defs[name]) return '';
    var props = {}, style = 'display: contents';
    for (var k = 0; k < n.attributes.length; k++) {
      var at = n.attributes[k], an = at.name.toLowerCase();
      if (an === 'name' || /^hint-/.test(an) || an === 'key') continue;
      if (an === 'style') { style = at.value; continue; }
      var wm = at.value.match(WHOLE);
      props[camel(an)] = wm ? lookup(wm[1], scope) : (at.value.indexOf('{{') === -1 ? at.value : interp(at.value, scope));
    }
    var idx = ctx.count[ctx.key] = (ctx.count[ctx.key] || 0) + 1;
    var key = ctx.key + '>' + name + '#' + idx + (ctx.loop || '');
    return '<dc-host style="' + esc(style) + '">' + renderInst(name, key, props, ctx) + '</dc-host>';
  }

  function renderInst(name, key, props, ctx) {
    var d = defs[name], inst = insts[key];
    if (!inst) {
      inst = new d.Cls(props);
      inst.props = props;
      if (!inst.state) inst.state = {};
      inst.__new = true;
      insts[key] = inst;
    } else {
      inst.props = props;
    }
    ctx.seen[key] = true;
    var vals = (inst.renderVals && inst.renderVals()) || {};
    var savedKey = ctx.key, savedLoop = ctx.loop;
    ctx.key = key; ctx.loop = '';
    var html = renderNodes(d.frag.childNodes, { vals: vals, locals: null, up: null }, ctx);
    ctx.key = savedKey; ctx.loop = savedLoop;
    return html;
  }

  function bindAll() {
    var els = rootEl.querySelectorAll('[data-dc-ev]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], list = el.getAttribute('data-dc-ev').split(' ');
      var types = {};
      list.forEach(function (p) {
        var t = p.split(':'), type = t[0], id = +t[1];
        types[type] = true;
        el['on' + type] = function (e) { var f = fns[id]; if (typeof f === 'function') return f(e); };
      });
      (el.__dcTypes || []).forEach(function (t) { if (!types[t]) el['on' + t] = null; });
      el.__dcTypes = Object.keys(types);
    }
  }

  function render() {
    pending = false;
    if (rendering) return;
    rendering = true;
    fns = [];
    var ctx = { key: 'root', loop: '', count: {}, seen: {} };
    var html = renderInst(rootName, 'root', {}, ctx);
    window.morphdom(rootEl, '<div id="dc-root">' + html + '</div>', {
      childrenOnly: true,
      onBeforeElUpdated: function (from, to) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(from.tagName)) {
          // i campi tengono il valore scritto: aggiorno gli attributi, il valore solo se il modello lo fissa e il campo non è attivo
          Array.prototype.forEach.call(to.attributes, function (a) {
            if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
          });
          Array.prototype.slice.call(from.attributes).forEach(function (a) {
            if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
          });
          if (from.type === 'checkbox' || from.type === 'radio') {
            if (to.hasAttribute('checked') !== from.checked && from.__dcCtl) from.checked = to.hasAttribute('checked');
          } else if (to.hasAttribute('value') && from !== document.activeElement && from.value !== to.getAttribute('value')) {
            from.value = to.getAttribute('value');
          } else if (from.tagName === 'TEXTAREA' && from !== document.activeElement && to.value === '' && from.value !== '' && from.__dcCtl) {
            from.value = '';
          }
          return false;
        }
        return true;
      }
    });
    Array.prototype.forEach.call(rootEl.querySelectorAll('input[type=checkbox],input[type=radio],textarea'), function (el) { el.__dcCtl = true; });
    bindAll();
    rendering = false;
    // ciclo di vita
    var mounted = [], updated = [];
    Object.keys(insts).forEach(function (k) {
      var inst = insts[k];
      if (!ctx.seen[k]) {
        if (inst.componentWillUnmount) try { inst.componentWillUnmount(); } catch (e) { console.error(e); }
        delete insts[k];
      } else if (inst.__new) { inst.__new = false; mounted.push(inst); }
      else updated.push(inst);
    });
    mounted.reverse().forEach(function (i) { if (i.componentDidMount) try { i.componentDidMount(); } catch (e) { console.error(e); } });
    updated.forEach(function (i) { if (i.componentDidUpdate) try { i.componentDidUpdate(); } catch (e) { console.error(e); } });
  }

  function schedule() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(function () {
      if (++passes > 200) { console.warn('dc-lite: troppi aggiornamenti di fila'); passes = 0; pending = false; return; }
      render();
      setTimeout(function () { passes = 0; }, 0);
    });
  }

  window.DCLite = {
    define: function (name, template, factory) {
      var t = document.createElement('template');
      t.innerHTML = template;
      defs[name] = { frag: t.content, Cls: factory(DCLogic) };
    },
    mount: function (name) {
      rootEl = document.getElementById('dc-root');
      rootName = name;
      render();
    }
  };
})();
