/* dc-lite: motore minimo per mostrare fuori dal canvas le tavole di Claude Design.
   Legge il modello della pagina (segnaposto {{nome}}, blocchi <sc-if>, eventi onClick/onSubmit...),
   lo ricalcola a ogni cambio di stato e aggiorna la pagina con morphdom, senza perdere
   quello che l'utente ha scritto nei campi del modulo. Solo per le anteprime: il sito vero sarà WordPress. */
(function () {
  'use strict';
  var root, comp, tpl, vals = {}, pending = false;
  var EVENTS = ['click', 'submit', 'change', 'input', 'blur', 'focus', 'keydown', 'scroll'];

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (u) {
    var next = typeof u === 'function' ? u(this.state, this.props) : u;
    this.state = Object.assign({}, this.state, next);
    schedule();
  };
  window.DCLogic = DCLogic;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function truthy(v) {
    return !(v === false || v === null || v === undefined || v === 0 || v === '' || v === 'false');
  }
  // risolve i blocchi <sc-if>, dal più interno verso l'esterno
  function resolveIf(t) {
    var re = /<sc-if\b[^>]*?\bvalue="\{\{\s*([\w$]+)\s*\}\}"[^>]*>((?:(?!<sc-if\b)[\s\S])*?)<\/sc-if>/;
    var m;
    while ((m = re.exec(t))) {
      t = t.slice(0, m.index) + (truthy(vals[m[1]]) ? m[2] : '') + t.slice(m.index + m[0].length);
    }
    return t;
  }
  function build() {
    var h = resolveIf(tpl);
    h = h.replace(/\s(on[A-Za-z]+)="\{\{\s*([\w$]+)\s*\}\}"/g, function (_, ev, name) {
      var t = ev.slice(2).toLowerCase();
      if (t === 'change') t = 'input'; // come in React: onChange scatta a ogni modifica, non solo all'uscita dal campo
      return ' data-dc-' + t + '="' + name + '"';
    });
    h = h.replace(/\{\{\s*([\w$]+)\s*\}\}/g, function (_, k) {
      var v = vals[k];
      return v === null || v === undefined || typeof v === 'function' ? '' : esc(v);
    });
    return h;
  }
  function bind(el) {
    EVENTS.forEach(function (type) {
      var name = el.getAttribute('data-dc-' + type);
      if (!name) return;
      if (el['__dc_' + type] === name) return;
      el['__dc_' + type] = name;
      el['on' + type] = function (e) {
        var f = vals[name];
        if (typeof f === 'function') return f(e);
      };
    });
  }
  function bindAll() {
    var sel = EVENTS.map(function (t) { return '[data-dc-' + t + ']'; }).join(',');
    Array.prototype.forEach.call(root.querySelectorAll(sel), bind);
  }
  function render() {
    pending = false;
    vals = comp.renderVals() || {};
    var html = '<div id="dc-root">' + build() + '</div>';
    window.morphdom(root, html, {
      childrenOnly: true,
      onBeforeElUpdated: function (from, to) {
        // i campi del modulo tengono il valore scritto: aggiorno solo gli attributi (es. aria-invalid)
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(from.tagName)) {
          Array.prototype.forEach.call(to.attributes, function (a) {
            if (a.name !== 'value' && from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
          });
          Array.prototype.slice.call(from.attributes).forEach(function (a) {
            if (a.name !== 'value' && !to.hasAttribute(a.name)) from.removeAttribute(a.name);
          });
          return false;
        }
        return true;
      }
    });
    bindAll();
  }
  function schedule() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(render);
  }
  window.DCLite = {
    mount: function (Component, template, props) {
      root = document.getElementById('dc-root');
      tpl = template;
      comp = new Component(props || {});
      if (!comp.state) comp.state = {};
      render();
    }
  };
})();
