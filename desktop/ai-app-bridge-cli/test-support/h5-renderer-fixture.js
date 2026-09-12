'use strict';
const vm = require('node:vm');
function createH5Page(renderer) {
  const nodes = [], events = [], listeners = {};
  class Element {
    constructor(id, label = '', tag = 'A') {
      Object.assign(this, { id, innerText: label, tagName: tag, type: tag === 'INPUT' ? 'text' : '', name: '',
        href: tag === 'A' ? 'kiwix://fixture/' + id : undefined, connected: true, _value: '', style: { opacity: '1' } }); nodes.push(this);
    }
    get value() { return this._value; } set value(value) { this._value = value; }
    getAttribute(key) { return this[key] ?? null; }
    getBoundingClientRect() { return this.rect ?? { left: 10, top: 20, right: 150, bottom: 55, width: 140, height: 35 }; }
    contains(other) { return other === this; }
    click() { events.push('click:' + this.id); this.onclick?.(); }
    focus() { this.onfocus?.(); }
    dispatchEvent(event) { events.push(event.type + ':' + this.id); this.onevent?.(event); }
    scrollIntoView() { events.push('scroll:' + this.id); delete this.rect; }
  }
  const location = { href: 'kiwix://fixture/index' };
  const document = { title: 'Offline reference', body: { innerText: 'Independent article body' },
    documentElement: { contains: e => e.connected }, querySelectorAll: () => nodes.filter(e => e.connected),
    elementFromPoint: () => state.hit ?? nodes.find(e => e.connected), readyState: 'complete' };
  const window = { addEventListener(name, handler) { (listeners[name] ??= []).push(handler); } };
  const history = { pushState(_state, _unused, url) { location.href = url; }, replaceState(_state, _unused, url) { location.href = url; } };
  const context = vm.createContext({ window, document, location, history, innerWidth: 400, innerHeight: 800, scrollX: 0, scrollY: 0,
    getComputedStyle: e => e.style, HTMLInputElement: Element, HTMLTextAreaElement: Element, Event: class { constructor(type) { this.type = type; } } });
  const state = { Element, nodes, events, document, location, history,
    setScroll: (x, y) => { context.scrollX = x; context.scrollY = y; },
    emit: name => (listeners[name] || []).forEach(fn => fn()),
    run: request => JSON.parse(JSON.stringify(vm.runInContext(`(${renderer})(${JSON.stringify(request)})`, context))),
    snapshot: () => state.run({ operation: 'snapshot', seed: 'document-seed' }).dom };
  return state;
}

module.exports = { createH5Page };
