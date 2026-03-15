/**
 * @dashboard-shared/core - Test Suite
 * Run with: node test.js
 * Uses only Node's built-in assert module. Zero external dependencies.
 */

const assert = require("node:assert/strict");
const { resolveShardId, ShardManager, ShardStatus } = require("./src/manager/ShardManager");
const { ClusterManager } = require("./src/cluster/ClusterManager");
const { ShardClient } = require("./src/shard/ShardClient");
const { IPCBroker } = require("./src/ipc/IPCBroker");
const { ShardRouter } = require("./src/utils/ShardRouter");

// --- test runner ---

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        -> ${err.message}`);
    failed++;
  }
}

// --- resolveShardId ---

console.log("\n-- resolveShardId -------------------------------------------------");

test("numeric: 4 % 4 = 0", () => {
  assert.equal(resolveShardId(4, 4), 0);
});

test("numeric: 5 % 4 = 1", () => {
  assert.equal(resolveShardId(5, 4), 1);
});

test("numeric: 0 % 4 = 0", () => {
  assert.equal(resolveShardId(0, 4), 0);
});

test("numeric result always within [0, totalShards)", () => {
  for (let i = 0; i < 100; i++) {
    const shard = resolveShardId(i, 8);
    assert.ok(shard >= 0 && shard < 8, `Expected 0-7, got ${shard} for entity ${i}`);
  }
});

test("string: same input always returns same shard (deterministic)", () => {
  const a = resolveShardId("user-abc", 4);
  const b = resolveShardId("user-abc", 4);
  assert.equal(a, b);
});

test("string: different inputs produce different shards (distribution)", () => {
  const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const shards = new Set(ids.map((id) => resolveShardId(id, 4)));
  assert.ok(shards.size > 1, "Expected at least 2 distinct shards across 8 string IDs");
});

test("string result always within [0, totalShards)", () => {
  const keys = ["user-1", "tenant-xyz", "guild-999", "session-abc", "dashboard-shared"];
  for (const key of keys) {
    const shard = resolveShardId(key, 6);
    assert.ok(shard >= 0 && shard < 6, `Expected 0-5, got ${shard} for "${key}"`);
  }
});

// --- ShardManager ---

console.log("\n-- ShardManager ---------------------------------------------------");

test("throws TypeError on non-string script", () => {
  assert.throws(() => new ShardManager(42, { totalShards: 4 }), TypeError);
});

test("throws RangeError on missing totalShards", () => {
  assert.throws(() => new ShardManager("bot.js", {}), RangeError);
});

test("throws RangeError on totalShards < 1", () => {
  assert.throws(() => new ShardManager("bot.js", { totalShards: 0 }), RangeError);
});

test("resolveShardId delegate: 5 % 4 = 1", () => {
  const mgr = new ShardManager("bot.js", { totalShards: 4 });
  assert.equal(mgr.resolveShardId(5), 1);
});

test("resolveShardId delegate: 8 % 4 = 0", () => {
  const mgr = new ShardManager("bot.js", { totalShards: 4 });
  assert.equal(mgr.resolveShardId(8), 0);
});

test("shard map is empty before spawn", () => {
  const mgr = new ShardManager("bot.js", { totalShards: 4 });
  assert.equal(mgr.shards.size, 0);
});

test("getStatus returns empty array before spawn", () => {
  const mgr = new ShardManager("bot.js", { totalShards: 4 });
  assert.deepEqual(mgr.getStatus(), []);
});

test("ShardStatus has all required keys", () => {
  assert.ok(ShardStatus.IDLE);
  assert.ok(ShardStatus.SPAWNING);
  assert.ok(ShardStatus.READY);
  assert.ok(ShardStatus.CRASHED);
  assert.ok(ShardStatus.RECONNECTING);
});

// --- ClusterManager ---

console.log("\n-- ClusterManager -------------------------------------------------");

test("throws RangeError on totalShards < 1", () => {
  assert.throws(() => new ClusterManager({ totalShards: 0 }), RangeError);
});

test("getClusterShards: 8 shards / 4 clusters -> 2 shards each", () => {
  const cm = new ClusterManager({ totalShards: 8, totalClusters: 4 });
  for (let cid = 0; cid < 4; cid++) {
    const { shards } = cm.getClusterShards(cid);
    assert.equal(shards.length, 2, `Cluster ${cid} should have 2 shards`);
  }
});

test("getClusterShards: all 8 shards are covered with no gaps", () => {
  const cm = new ClusterManager({ totalShards: 8, totalClusters: 4 });
  const all = [];
  for (let cid = 0; cid < 4; cid++) {
    all.push(...cm.getClusterShards(cid).shards);
  }
  assert.deepEqual(all.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("getClusterShards: 7 shards / 3 clusters covers all shards (remainder)", () => {
  const cm = new ClusterManager({ totalShards: 7, totalClusters: 3 });
  const all = [];
  for (let cid = 0; cid < 3; cid++) {
    all.push(...cm.getClusterShards(cid).shards);
  }
  assert.deepEqual(all.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test("resolve: shardId and clusterId are correct for entity 5 (8 shards / 4 clusters)", () => {
  const cm = new ClusterManager({ totalShards: 8, totalClusters: 4 });
  const { shardId, clusterId } = cm.resolve(5);
  assert.equal(shardId, 5);
  assert.equal(clusterId, 2);
});

test("resolve: shardId is always < totalShards", () => {
  const cm = new ClusterManager({ totalShards: 6, totalClusters: 3 });
  for (let i = 0; i < 50; i++) {
    const { shardId } = cm.resolve(i);
    assert.ok(shardId < 6, `shardId ${shardId} >= 6`);
  }
});

// --- ShardClient ---

console.log("\n-- ShardClient ----------------------------------------------------");

test("id defaults to 0 when SHARD_ID is not set", () => {
  delete process.env.SHARD_ID;
  const sc = new ShardClient();
  assert.equal(sc.id, 0);
});

test("totalShards defaults to 1 when TOTAL_SHARDS is not set", () => {
  delete process.env.TOTAL_SHARDS;
  const sc = new ShardClient();
  assert.equal(sc.totalShards, 1);
});

test("owns() returns true when shard owns the entity", () => {
  process.env.SHARD_ID = "2";
  process.env.TOTAL_SHARDS = "4";
  const sc = new ShardClient();
  assert.equal(sc.owns(2), true);
  assert.equal(sc.owns(6), true);
});

test("owns() returns false when another shard owns the entity", () => {
  process.env.SHARD_ID = "2";
  process.env.TOTAL_SHARDS = "4";
  const sc = new ShardClient();
  assert.equal(sc.owns(1), false);
});

test("setContext stores the value in _evalContext", () => {
  process.env.SHARD_ID = "0";
  process.env.TOTAL_SHARDS = "2";
  const sc = new ShardClient();
  sc.setContext("uptime", 12345);
  assert.equal(sc._evalContext.uptime, 12345);
});

// --- IPCBroker ---

console.log("\n-- IPCBroker ------------------------------------------------------");

test("registerShard adds shards to the broker", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 4);
  broker.registerShard(1, 4);
  assert.equal(broker._shards.size, 2);
});

test("duplicate registerShard is a no-op", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 4);
  broker.registerShard(0, 4);
  assert.equal(broker._shards.size, 1);
});

test("setContext / getContext roundtrip", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 2);
  broker.setContext(0, "entityCount", 42);
  assert.equal(broker.getContext(0, "entityCount"), 42);
});

test("route dispatches to the correct shard based on entityId", () => {
  const broker = new IPCBroker();
  for (let i = 0; i < 4; i++) broker.registerShard(i, 4);
  broker.onMessage(1, "PING", () => "PONG_FROM_1");
  const { shardId, result } = broker.route(5, "PING"); // 5 % 4 = 1
  assert.equal(shardId, 1);
  assert.equal(result, "PONG_FROM_1");
});

test("route throws when no handler is registered for the type", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 2);
  assert.throws(() => broker.route(0, "NONEXISTENT"), /No handler/);
});

test("route throws when the resolved shard is not registered", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 2);
  assert.throws(() => broker.route(1, "PING"), /No shard registered/);
});

test("broadcast fans out to all shards with a handler", () => {
  const broker = new IPCBroker();
  for (let i = 0; i < 4; i++) {
    broker.registerShard(i, 4);
    broker.onMessage(i, "COUNT", ({ shardId }) => shardId * 10);
  }
  const results = broker.broadcast("COUNT");
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((r) => r.result), [0, 10, 20, 30]);
});

test("broadcastEval evaluates expression against every shard's context", () => {
  const broker = new IPCBroker();
  for (let i = 0; i < 3; i++) {
    broker.registerShard(i, 3);
    broker.setContext(i, "users", (i + 1) * 100);
  }
  const results = broker.broadcastEval("ctx.users * 2");
  assert.deepEqual(results.map((r) => r.result), [200, 400, 600]);
});

test("broadcastEval returns undefined (not an error) for missing context keys", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 2);
  broker.registerShard(1, 2);
  broker.setContext(0, "value", 5);
  const results = broker.broadcastEval("ctx.value");
  assert.equal(results[0].result, 5);
  assert.equal(results[1].result, undefined);
});

test("inspect returns id and contextKeys for all shards", () => {
  const broker = new IPCBroker();
  broker.registerShard(0, 2);
  broker.setContext(0, "foo", 1);
  broker.setContext(0, "bar", 2);
  const info = broker.inspect();
  assert.equal(info[0].id, 0);
  assert.deepEqual(info[0].contextKeys.sort(), ["bar", "foo"]);
});

// --- ShardRouter ---

console.log("\n-- ShardRouter ----------------------------------------------------");

test("throws RangeError on totalShards < 1", () => {
  assert.throws(() => new ShardRouter({ totalShards: 0 }), RangeError);
});

test("resolve: correct shardId for numeric entity (9 % 4 = 1)", () => {
  const router = new ShardRouter({ totalShards: 4 });
  assert.equal(router.resolve(9).shardId, 1);
});

test("resolve: clusterId is correct when totalClusters is set", () => {
  const router = new ShardRouter({ totalShards: 4, totalClusters: 2 });
  assert.equal(router.resolve(2).clusterId, 1); // shard 2 -> cluster 1
  assert.equal(router.resolve(1).clusterId, 0); // shard 1 -> cluster 0
});

test("resolve: clusterId is null when totalClusters is not set", () => {
  const router = new ShardRouter({ totalShards: 4 });
  assert.equal(router.resolve(3).clusterId, null);
});

test("resolve: redirectUrl is set correctly when shardUrls is provided", () => {
  const urls = ["http://s0:3001", "http://s1:3002", "http://s2:3003", "http://s3:3004"];
  const router = new ShardRouter({ totalShards: 4, shardUrls: urls });
  assert.equal(router.resolve(6).redirectUrl, "http://s2:3003"); // 6 % 4 = 2
});

test("resolve: redirectUrl is null when shardUrls is not set", () => {
  const router = new ShardRouter({ totalShards: 4 });
  assert.equal(router.resolve(0).redirectUrl, null);
});

test("isLocal returns true for the matching shard", () => {
  const router = new ShardRouter({ totalShards: 4 });
  const info = router.resolve(0);
  assert.equal(info.isLocal(0), true);
});

test("isLocal returns false for a non-matching shard", () => {
  const router = new ShardRouter({ totalShards: 4 });
  const info = router.resolve(0);
  assert.equal(info.isLocal(3), false);
});

test("distribution: covers all shards with no duplicates", () => {
  const router = new ShardRouter({ totalShards: 6, totalClusters: 3 });
  const dist = router.distribution();
  assert.equal(dist.length, 3);
  const all = dist.flatMap((d) => d.shards).sort((a, b) => a - b);
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5]);
});

test("distribution: returns empty array when totalClusters is not set", () => {
  const router = new ShardRouter({ totalShards: 4 });
  assert.deepEqual(router.distribution(), []);
});

// --- summary ---

console.log(`\n${"─".repeat(66)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total\n`);

if (failed > 0) process.exit(1);
