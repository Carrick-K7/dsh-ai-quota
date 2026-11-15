// Offline regression tests for the shipped lazy-CJS browser bundle.
//   node --test test-client-refresh.mjs
//   CLIENT_BUNDLE=/absolute/client.js node --test test-client-refresh.mjs
//   node test-client-refresh.mjs /absolute/client.js
// All DOM, storage, clocks, React hooks and Remote calls are in-memory fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const bundlePath = process.argv[2] || process.env.CLIENT_BUNDLE;
const filename = bundlePath ? resolve(bundlePath) : fileURLToPath(new URL('./client.js', import.meta.url));
const source = readFileSync(filename, 'utf8');
const MINUTE = 60_000;
const CACHE_KEY = 'dsh-ai-quota.cache.v1';
const INITIAL_TIME = Date.parse('2026-01-01T00:00:00.000Z');

async function flush() {
  // Covers both the store's promise chain and apply()'s mount-ready wrapper.
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function deferred() {
  let resolvePromise;
  let reject;
  const promise = new Promise((res, rej) => { resolvePromise = res; reject = rej; });
  return { promise, resolve: resolvePromise, reject };
}

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ type }); }
  count(type) { return this.listeners.get(type)?.size || 0; }
}

class Clock {
  now = INITIAL_TIME;
  timers = new Map();
  serial = 0;
  setInterval = (callback, ms) => {
    assert(Number.isFinite(ms) && ms > 0, 'interval must be a positive finite duration');
    const id = ++this.serial;
    this.timers.set(id, { callback, ms, nextAt: this.now + ms });
    return id;
  };
  clearInterval = (id) => { this.timers.delete(id); };
  periods() { return [...this.timers.values()].map(timer => timer.ms).sort((a, b) => a - b); }
  async advance(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.nextAt <= target)
        .sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
      if (!next) break;
      this.now = next[1].nextAt;
      next[1].nextAt += next[1].ms;
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
  suspend(ms) {
    // Simulate a browser that paused/coalesced timers; do not replay old ticks.
    this.now += ms;
    for (const timer of this.timers.values()) {
      if (timer.nextAt <= this.now) {
        timer.nextAt += (Math.floor((this.now - timer.nextAt) / timer.ms) + 1) * timer.ms;
      }
    }
  }
}

function fakeReact() {
  let active;
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hook = () => {
    assert(active, 'React hooks must run only inside the test renderer');
    const index = active.cursor++;
    return active.hooks[index] ??= {};
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = hook();
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial;
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useRef(initial) { const slot = hook(); return slot.ref ??= { current: initial }; },
    useCallback(callback, deps) {
      const slot = hook();
      if (!equalDeps(slot.deps, deps)) { slot.deps = deps; slot.callback = callback; }
      return slot.callback;
    },
    useEffect(callback, deps) {
      const slot = hook();
      if (!equalDeps(slot.deps, deps)) {
        slot.deps = deps;
        active.pending.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = hook();
      if (slot.subscribe !== subscribe) {
        slot.cleanup?.();
        slot.subscribe = subscribe;
        slot.cleanup = subscribe(() => { slot.notifications = (slot.notifications || 0) + 1; });
      }
      slot.getSnapshot = getSnapshot;
      return getSnapshot();
    },
  };
  const mount = (Component, props) => {
    const fiber = { hooks: [], pending: [], cursor: 0, tree: null };
    return {
      render(nextProps = props) {
        props = nextProps;
        fiber.cursor = 0;
        fiber.pending = [];
        active = fiber;
        try { fiber.tree = Component(props); } finally { active = undefined; }
        for (const effect of fiber.pending) effect();
        return fiber.tree;
      },
      subscriptions: () => fiber.hooks.filter(slot => slot.subscribe),
      unmount() { for (const slot of fiber.hooks) slot.cleanup?.(); fiber.hooks = []; },
    };
  };
  return { React, mount };
}

function fixture(time, amount = '42.00') {
  const balance = {
    kind: 'balance', status: 'ok', error: null, keyConfigured: true, available: true,
    balances: [{ currency: 'USD', totalBalance: amount, grantedBalance: '0', toppedUpBalance: amount, remainingAmount: Number(amount) }],
  };
  const subscription = () => ({
    kind: 'subscription', status: 'ok', error: null, keyConfigured: true, plan: 'synthetic',
    windows: [{ name: '7d', usedPercent: 12, remainingPercent: 88, limitWindowSeconds: 604800, resetsAt: new Date(time + MINUTE).toISOString() }],
  });
  return {
    ok: true,
    value: {
      fetchedAt: new Date(time).toISOString(),
      providers: { codex: subscription(), kimi: subscription(), glm: subscription(), opencodeGo: subscription(), deepseek: balance, ai302: balance },
    },
  };
}

function harness(seed) {
  const clock = new Clock();
  const storage = new Map(seed ? [[CACHE_KEY, JSON.stringify(seed)]] : []);
  const writes = [];
  const window = new Events();
  const document = new Events();
  document.visibilityState = 'visible';
  document.querySelector = () => null;
  const tags = new Map();
  document.getElementById = id => tags.get(id) || null;
  document.createElement = () => ({ remove() {} });
  document.head = { appendChild(element) { if (element.id) tags.set(element.id, element); } };
  document.body = {};
  const attributes = new Set();
  document.documentElement = {
    hasAttribute: name => attributes.has(name),
    toggleAttribute(name, on) { if (on) attributes.add(name); else attributes.delete(name); },
  };
  window.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { storage.set(key, value); writes.push([key, value]); },
  };
  const renderer = fakeReact();
  let exports;
  window.__ModuleLoader__ = {
    load(registration) {
      assert.equal(registration.id, 'dsh-ai-quota');
      exports = registration.factory(name => {
        assert.equal(name, 'react', 'the browser bundle must not require host dependencies');
        return renderer.React;
      });
    },
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  class MutationObserver { observe() {} disconnect() {} }
  runInNewContext(source, {
    window, document, MutationObserver, Date: FakeDate, Promise,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval, console,
  }, { filename });
  assert.equal(typeof exports?.createQuotaStore, 'function', `${filename} must export createQuotaStore`);
  assert.equal(typeof exports?.apply, 'function');
  return { exports, clock, window, document, storage, writes, renderer };
}

function context(h, refresh, { models = true, mountReady = Promise.resolve() } = {}) {
  const disposers = [];
  const entries = [];
  const calls = { mounts: 0, query: 0, directoryLoads: 0 };
  const directoryState = { status: 'ready', current: { provider: 'deepseek-official' }, groups: [] };
  const directory = {
    store: { getSnapshot: () => directoryState, subscribe: () => () => {} },
    load: async () => { calls.directoryLoads++; },
  };
  let dictionary = {};
  const api = { refresh, query() { calls.query++; throw new Error('query is forbidden in global-refresh tests'); } };
  const ctx = {
    remote: { $mount() { calls.mounts++; return mountReady; } },
    get(name) { if (name === 'remote.aiQuota') return api; throw new Error(`Unexpected lookup ${name}`); },
    effect(execute) {
      const cleanup = execute();
      let disposed = false;
      const dispose = () => { if (!disposed) { disposed = true; if (typeof cleanup === 'function') cleanup(); } };
      disposers.push(dispose);
      return dispose;
    },
    locale: {
      register(_namespace, translations) { dictionary = translations.en; return () => {}; },
      bind() { return key => dictionary[key] || key; },
    },
    slots: {
      inject(_name, register) { return register(); },
      register(options, Component) { entries.push({ options, Component }); return () => {}; },
    },
    modelDirectories: { directoryFor: () => directory },
    sessions: { subagentAddress: () => undefined },
    inject(_dependencies, execute) { if (models) execute(ctx); },
  };
  return { ctx, entries, calls, dispose() { for (const dispose of [...disposers].reverse()) dispose(); } };
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => nodes(child, predicate))];
}

function text(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return (tree.children || []).map(text).join(' ');
}

test('start immediately refreshes all providers, independent of any UI mount', async t => {
  const h = harness();
  const calls = [];
  const store = h.exports.createQuotaStore(filter => { calls.push(filter); return fixture(h.clock.now); });
  assert.strictEqual(store.getSnapshot(), store.getSnapshot(), 'snapshot must be referentially stable between updates');
  await store.refresh();
  assert.equal(calls.length, 0, 'an inactive store must be inert');
  assert.deepEqual(h.clock.periods(), []);
  const stop = store.start(); t.after(stop);
  await flush();
  assert.deepEqual(calls, [null]);
  assert.deepEqual(h.clock.periods(), [MINUTE]);
  assert.equal(store.getSnapshot().fetchedAt, new Date(INITIAL_TIME).toISOString());
  assert.equal(store.getSnapshot().refreshing, false);
  await h.clock.advance(MINUTE - 1);
  assert.equal(calls.length, 1);
  await h.clock.advance(1);
  assert.deepEqual(calls, [null, null]);
  await h.clock.advance(2 * MINUTE);
  assert.equal(calls.length, 4, 'exactly one all-provider request per minute');
});

test('repeated start does not create duplicate timers or startup requests', async t => {
  const h = harness(); let calls = 0;
  const store = h.exports.createQuotaStore(() => { calls++; return fixture(h.clock.now); });
  const stop = store.start(); t.after(stop);
  const duplicateStop = store.start();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.clock.periods(), [MINUTE]);
  duplicateStop();
  await h.clock.advance(MINUTE);
  assert.equal(calls, 2, 'a duplicate start has no second lifetime to dispose');
});

test('hidden documents continue minute refreshes without a composer or settings page', async t => {
  const h = harness(); let calls = 0;
  h.document.visibilityState = 'hidden';
  const store = h.exports.createQuotaStore(() => { calls++; return fixture(h.clock.now); });
  const stop = store.start(); t.after(stop);
  await flush();
  await h.clock.advance(3 * MINUTE);
  assert.equal(calls, 4);
  assert.equal(store.getSnapshot().fetchedAt, new Date(h.clock.now).toISOString());
});

test('visibility/online resume performs one overdue catch-up, never a backlog or event storm', async t => {
  const h = harness(); let calls = 0;
  const store = h.exports.createQuotaStore(() => { calls++; return fixture(h.clock.now); });
  const stop = store.start(); t.after(stop);
  await flush();
  h.window.dispatch('online'); h.document.dispatch('visibilitychange');
  await flush();
  assert.equal(calls, 1, 'fresh snapshots do not refetch on every event');
  h.document.visibilityState = 'hidden';
  h.clock.suspend(10 * MINUTE);
  h.document.dispatch('visibilitychange');
  await flush();
  assert.equal(calls, 1, 'a hidden visibility event alone is not a resume');
  h.document.visibilityState = 'visible';
  for (let i = 0; i < 20; i++) { h.document.dispatch('visibilitychange'); h.window.dispatch('online'); }
  await flush();
  assert.equal(calls, 2, 'ten missed intervals coalesce to one request');
  for (let i = 0; i < 20; i++) { h.window.dispatch('online'); await flush(); }
  assert.equal(calls, 2, 'separate event turns are also throttled');
  h.clock.suspend(MINUTE);
  h.document.visibilityState = 'hidden';
  h.window.dispatch('online');
  await flush();
  assert.equal(calls, 3, 'online catch-up need not wait for a visible page');
  assert.deepEqual(h.clock.periods(), [MINUTE]);
});

test('startup, manual clicks, timer ticks and resume events deduplicate one inflight RPC', async t => {
  const h = harness(); const pending = deferred(); let calls = 0;
  const store = h.exports.createQuotaStore(filter => { assert.equal(filter, null); calls++; return pending.promise; });
  const stop = store.start(); t.after(stop);
  const one = store.refresh();
  assert.strictEqual(store.refresh(true), one);
  await flush();
  await h.clock.advance(3 * MINUTE);
  h.window.dispatch('online'); h.document.dispatch('visibilitychange');
  assert.strictEqual(store.refresh(), one);
  await flush();
  assert.equal(calls, 1);
  pending.resolve(fixture(h.clock.now));
  await one;
  await flush();
  await h.clock.advance(MINUTE);
  assert.equal(calls, 2, 'the first completion releases the deduplication guard');
});

for (const [label, failure] of [
  ['rejected transport', () => Promise.reject(new Error('synthetic network failure'))],
  ['failed Remote result', () => ({ ok: false, error: { message: 'synthetic' } })],
  ['malformed Remote result', () => ({ ok: true, value: null })],
]) {
  test(`${label}: preserve old values/timestamp, notify failure and retry next minute`, async t => {
    const h = harness(); let calls = 0; let notifications = 0;
    const store = h.exports.createQuotaStore(() => {
      calls++;
      return calls === 2 ? failure() : fixture(h.clock.now, calls === 1 ? '42.00' : '17.00');
    });
    const unsubscribe = store.subscribe(() => { notifications++; }); t.after(unsubscribe);
    const stop = store.start(); t.after(stop);
    await flush();
    const previous = store.getSnapshot();
    const writesBeforeFailure = h.writes.length;
    await h.clock.advance(MINUTE);
    const failed = store.getSnapshot();
    assert.strictEqual(failed.providers, previous.providers);
    assert.equal(failed.fetchedAt, previous.fetchedAt);
    assert.equal(failed.refreshing, false);
    assert.equal(failed.error, 'remote failed');
    assert.equal(h.writes.length, writesBeforeFailure, 'failures must not persist a newer timestamp');
    assert(notifications >= 4, 'subscribers observe loading/result/error transitions');
    await h.clock.advance(MINUTE);
    assert.equal(calls, 3);
    assert.equal(store.getSnapshot().error, null);
    assert.equal(store.getSnapshot().providers.deepseek.balances[0].totalBalance, '17.00');
    assert.equal(store.getSnapshot().fetchedAt, new Date(h.clock.now).toISOString());
  });
}

test('cached data is seeded immediately and skipped providers do not erase last good values', async t => {
  const cached = fixture(INITIAL_TIME - 2 * MINUTE).value;
  const h = harness(cached);
  const store = h.exports.createQuotaStore(() => ({ ok: true, value: {
    fetchedAt: new Date(h.clock.now).toISOString(),
    providers: { deepseek: { status: 'skipped' }, kimi: { kind: 'subscription', status: 'error', error: 'network', windows: [] } },
  } }));
  const initial = store.getSnapshot();
  assert.equal(initial.fetchedAt, cached.fetchedAt);
  assert.equal(initial.providers.deepseek.balances[0].totalBalance, '42.00');
  const stop = store.start(); t.after(stop);
  assert.equal(store.getSnapshot().refreshing, false, 'silent refresh does not flicker cached readings');
  await flush();
  assert.strictEqual(store.getSnapshot().providers.deepseek, initial.providers.deepseek);
  assert.strictEqual(store.getSnapshot().providers.codex, initial.providers.codex);
  assert.equal(store.getSnapshot().providers.kimi.status, 'error', 'provider-level errors are real new data');
  assert.equal(JSON.parse(h.storage.get(CACHE_KEY)).fetchedAt, new Date(h.clock.now).toISOString());
});

test('unsubscribe removes a store listener without stopping the global scheduler', async t => {
  const h = harness(); let notifications = 0;
  const store = h.exports.createQuotaStore(() => fixture(h.clock.now));
  const unsubscribe = store.subscribe(() => { notifications++; });
  const stop = store.start(); t.after(stop);
  await flush();
  unsubscribe();
  const before = notifications;
  await h.clock.advance(MINUTE);
  assert.equal(notifications, before);
  assert.equal(store.getSnapshot().fetchedAt, new Date(h.clock.now).toISOString());
});

test('dispose before the startup microtask prevents Remote work and removes timer/events', async () => {
  const h = harness(); let calls = 0;
  const store = h.exports.createQuotaStore(() => { calls++; return fixture(h.clock.now); });
  const stop = store.start();
  assert.equal(h.document.count('visibilitychange'), 1);
  assert.equal(h.window.count('online'), 1);
  stop();
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(h.clock.periods(), []);
  assert.equal(h.document.count('visibilitychange'), 0);
  assert.equal(h.window.count('online'), 0);
  await store.refresh();
  await h.clock.advance(5 * MINUTE);
  h.window.dispatch('online'); h.document.dispatch('visibilitychange');
  await flush();
  assert.equal(calls, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`disposed inflight ${outcome} cannot publish or persist late data`, async () => {
    const h = harness(); const pending = deferred(); let notifications = 0;
    const store = h.exports.createQuotaStore(() => pending.promise);
    store.subscribe(() => { notifications++; });
    const stop = store.start();
    await flush();
    const before = store.getSnapshot();
    const notificationCount = notifications;
    const writes = h.writes.length;
    stop();
    if (outcome === 'resolve') pending.resolve(fixture(h.clock.now));
    else pending.reject(new Error('late synthetic failure'));
    await flush();
    assert.strictEqual(store.getSnapshot(), before);
    assert.equal(notifications, notificationCount);
    assert.equal(h.writes.length, writes);
    assert.deepEqual(h.clock.periods(), []);
    assert.equal(h.document.count('visibilitychange'), 0);
    assert.equal(h.window.count('online'), 0);
  });
}

for (const outcome of ['resolve', 'reject']) {
  test(`restart isolates an old ${outcome} from new data and the new inflight guard`, async t => {
    const h = harness(); const old = deferred(); const current = deferred(); let calls = 0;
    const store = h.exports.createQuotaStore(() => {
      calls++;
      return calls === 1 ? old.promise : calls === 2 ? current.promise : fixture(h.clock.now, '9.00');
    });
    const stopOld = store.start();
    await flush();
    stopOld();
    const stopNew = store.start(); t.after(stopNew);
    const newRequest = store.refresh();
    await flush();
    assert.equal(calls, 2);
    const beforeOldSettlement = store.getSnapshot();
    if (outcome === 'resolve') old.resolve(fixture(h.clock.now, '99.00'));
    else old.reject(new Error('old synthetic failure'));
    await flush();
    assert.strictEqual(store.getSnapshot(), beforeOldSettlement);
    assert.equal(h.writes.length, 0);
    assert.strictEqual(store.refresh(), newRequest, 'old finally must not clear new inflight request');
    await h.clock.advance(MINUTE);
    assert.equal(calls, 2);
    current.resolve(fixture(h.clock.now, '23.00'));
    await newRequest;
    await flush();
    assert.equal(store.getSnapshot().providers.deepseek.balances[0].totalBalance, '23.00');
    await h.clock.advance(MINUTE);
    assert.equal(calls, 3);
    assert.equal(store.getSnapshot().providers.deepseek.balances[0].totalBalance, '9.00');
    assert.deepEqual(h.clock.periods(), [MINUTE]);
    assert.equal(h.window.count('online'), 1);
  });
}

test('dispose/start before either queued request runs invokes only the new generation', async t => {
  const h = harness(); let calls = 0;
  const store = h.exports.createQuotaStore(() => { calls++; return fixture(h.clock.now); });
  store.start()();
  const stop = store.start(); t.after(stop);
  await flush();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().error, null);
  await h.clock.advance(MINUTE);
  assert.equal(calls, 2);
});

test('apply owns refresh lifecycle even with no model service, no mounted UI and pending Remote mount', async () => {
  const h = harness(); const ready = deferred(); const calls = [];
  const owner = context(h, filter => { calls.push(filter); return fixture(h.clock.now); }, { models: false, mountReady: ready.promise });
  h.exports.apply(owner.ctx);
  assert.equal(owner.calls.mounts, 1);
  assert.deepEqual(h.clock.periods(), [MINUTE]);
  assert.equal(owner.entries.length, 1, 'only the settings registration exists; it is not mounted');
  await h.clock.advance(MINUTE);
  assert.equal(calls.length, 0, 'RPC waits for $mount readiness');
  ready.resolve(); await flush();
  assert.deepEqual(calls, [null], 'waiting ticks do not accumulate calls');
  h.document.visibilityState = 'hidden';
  await h.clock.advance(MINUTE);
  assert.deepEqual(calls, [null, null]);
  owner.dispose();
  assert.deepEqual(h.clock.periods(), []);
  assert.equal(h.window.count('online'), 0);
  await h.clock.advance(MINUTE);
  assert.equal(calls.length, 2);
  assert.equal(owner.calls.query, 0);
});

test('apply disposal while $mount is pending must not start a deferred quota RPC', async () => {
  const h = harness(); const ready = deferred(); let calls = 0;
  const owner = context(h, () => { calls++; return fixture(h.clock.now); }, { mountReady: ready.promise });
  h.exports.apply(owner.ctx);
  await flush();
  assert.equal(calls, 0);
  owner.dispose();
  ready.resolve();
  await flush();
  assert.equal(calls, 0, 'Remote readiness after disposal must not launch fresh work');
  assert.deepEqual(h.clock.periods(), []);
  assert.equal(h.writes.length, 0);
});

test('Panel and both composer seats share one store; mounting, navigation and closing add no quota requests', async t => {
  const h = harness(); let calls = 0;
  const owner = context(h, () => { calls++; return fixture(h.clock.now, String(50 - calls)); });
  h.exports.apply(owner.ctx); t.after(() => owner.dispose());
  await flush();
  const panelEntry = owner.entries.find(entry => entry.options.id === 'ai-quota');
  const chipEntries = owner.entries.filter(entry => entry.options.id === 'ai-quota-chip');
  assert(panelEntry);
  assert.equal(chipEntries.length, 2);
  const panelProps = panelEntry.options.inject();
  const chipProps = chipEntries.map(entry => entry.options.inject('synthetic-session'));
  for (const props of chipProps) assert.strictEqual(props.quota, panelProps.quota);
  const panel = h.renderer.mount(panelEntry.Component, panelProps);
  const chips = chipEntries.map((entry, i) => h.renderer.mount(entry.Component, chipProps[i]));
  t.after(() => { panel.unmount(); chips.forEach(chip => chip.unmount()); });
  let panelTree = panel.render();
  for (const chip of chips) { chip.render(); chip.render(); }
  await flush();
  assert.equal(calls, 1, 'render/mount must not query quota');
  assert.deepEqual(h.clock.periods(), [30_000, MINUTE], 'only panel age repaint and plugin refresh clocks exist');
  for (const component of [panel, ...chips]) {
    assert(component.subscriptions().some(slot => slot.subscribe === panelProps.quota.subscribe && slot.getSnapshot === panelProps.quota.getSnapshot));
  }
  await h.clock.advance(MINUTE);
  assert.equal(calls, 2, 'multiple composer seats must not multiply scheduled requests');
  panelTree = panel.render();
  const snapshot = panelProps.quota.getSnapshot();
  const deepseek = nodes(panelTree, node => node.props.name === 'deepseek')[0];
  assert.strictEqual(deepseek.props.value, snapshot.providers.deepseek);
  for (const chip of chips) assert(text(chip.render()).includes('$48'), 'each chip reads the latest shared balance');
  for (let i = 0; i < chips.length; i++) {
    chips[i].render(chipEntries[i].options.inject('another-synthetic-session'));
  }
  await flush();
  assert.equal(calls, 2, 'switching conversations must not create an independent quota request');
  panel.unmount(); chips.forEach(chip => chip.unmount());
  assert.deepEqual(h.clock.periods(), [MINUTE]);
  await h.clock.advance(MINUTE);
  assert.equal(calls, 3, 'scheduler continues after every quota surface unmounts');
  assert.equal(owner.calls.query, 0);
});

test('Panel and Chip manual refresh actions deduplicate and update both subscribed surfaces', async t => {
  const h = harness(); const pending = deferred(); let calls = 0;
  const owner = context(h, () => ++calls === 1 ? fixture(h.clock.now, '42.00') : pending.promise);
  h.exports.apply(owner.ctx); t.after(() => owner.dispose());
  await flush();
  const panelEntry = owner.entries.find(entry => entry.options.id === 'ai-quota');
  const chipEntry = owner.entries.find(entry => entry.options.name === 'conversation.composer.dock');
  const props = panelEntry.options.inject();
  const panel = h.renderer.mount(panelEntry.Component, props);
  const chip = h.renderer.mount(chipEntry.Component, chipEntry.options.inject('synthetic'));
  t.after(() => { panel.unmount(); chip.unmount(); });
  const panelTree = panel.render();
  const chipTree = chip.render();
  const button = nodes(panelTree, node => node.type === 'button' && node.props.className?.startsWith('dsh-ab-refresh'))[0];
  assert(button);
  button.props.onClick(); chipTree.props.onClick();
  await flush();
  assert.equal(calls, 2);
  assert.equal(props.quota.getSnapshot().refreshing, true);
  assert(nodes(panel.render(), node => node.props.className?.includes('spinning')).length > 0);
  assert(chip.render().props.className.includes('dsh-ab-skel'));
  pending.resolve(fixture(h.clock.now, '21.00')); await flush();
  const latest = props.quota.getSnapshot().providers.deepseek;
  assert.strictEqual(nodes(panel.render(), node => node.props.name === 'deepseek')[0].props.value, latest);
  assert(text(chip.render()).includes('$21.00'));
  assert.equal(props.quota.getSnapshot().refreshing, false);
  assert.equal(owner.calls.query, 0);
});
