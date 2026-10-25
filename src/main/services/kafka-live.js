'use strict';
// Live Kafka view for the Message Flow diagram: topic sizes, consumer-group lag, peeking at recent
// messages and publishing test messages. Uses kafkajs (pure JavaScript, no native client needed).
const { Kafka, logLevel } = require('kafkajs');

class KafkaLive {
  constructor() {
    this.kafka = null;
    this.admin = null;
    this.producer = null;
    this.brokers = [];
  }

  async connect({ brokers, ssl = false, sasl = null } = {}) {
    await this.disconnect();
    const list = (Array.isArray(brokers) ? brokers : String(brokers || '').split(',')).map((b) => b.trim()).filter(Boolean);
    if (!list.length) throw new Error('Enter at least one bootstrap server, for example localhost:9092');
    const cfg = { clientId: 'kiln-ide', brokers: list, connectionTimeout: 4000, requestTimeout: 10000, retry: { retries: 1, initialRetryTime: 200 }, logLevel: logLevel.NOTHING };
    if (ssl) cfg.ssl = true;
    if (sasl && sasl.mechanism && sasl.mechanism !== 'none') cfg.sasl = { mechanism: sasl.mechanism, username: sasl.username || '', password: sasl.password || '' };
    this.kafka = new Kafka(cfg);
    this.admin = this.kafka.admin();
    await this.admin.connect();
    this.brokers = list;
    const cluster = await this.admin.describeCluster();
    return { brokers: cluster.brokers.map((b) => `${b.host}:${b.port}`), controller: cluster.controller, clusterId: cluster.clusterId };
  }

  requireAdmin() {
    if (!this.admin) throw new Error('Not connected to Kafka');
    return this.admin;
  }

  async overview() {
    const admin = this.requireAdmin();
    const names = (await admin.listTopics()).filter((t) => !t.startsWith('__')).sort();
    const meta = names.length ? await admin.fetchTopicMetadata({ topics: names }) : { topics: [] };
    const topics = [];
    const high = {};
    for (const t of meta.topics) {
      const offsets = await admin.fetchTopicOffsets(t.name);
      let messages = 0;
      high[t.name] = {};
      for (const o of offsets) {
        messages += Math.max(0, Number(o.high) - Number(o.low));
        high[t.name][o.partition] = Number(o.high);
      }
      topics.push({ name: t.name, partitions: t.partitions.length, messages });
    }
    const groups = [];
    let listed = [];
    try {
      listed = (await admin.listGroups()).groups.filter((g) => !g.groupId.startsWith('kiln-peek-')).slice(0, 40);
    } catch {
      listed = [];
    }
    if (listed.length) {
      const described = await admin.describeGroups(listed.map((g) => g.groupId));
      for (const g of described.groups) {
        const lag = {};
        try {
          const committed = await admin.fetchOffsets({ groupId: g.groupId, topics: names });
          for (const t of committed) {
            let total = 0;
            let any = false;
            for (const p of t.partitions) {
              const off = Number(p.offset);
              if (off < 0) continue;
              any = true;
              total += Math.max(0, (high[t.topic] ? high[t.topic][p.partition] || 0 : 0) - off);
            }
            if (any) lag[t.topic] = total;
          }
        } catch {
          /* group without offsets */
        }
        groups.push({ groupId: g.groupId, state: g.state, members: g.members.length, lag });
      }
    }
    return { topics, groups, at: Date.now() };
  }

  /** Read the most recent `limit` messages of a topic without committing offsets for any real group. */
  async peek(topic, limit = 20) {
    const admin = this.requireAdmin();
    const offsets = await admin.fetchTopicOffsets(topic);
    const perPartition = Math.max(1, Math.ceil(limit / Math.max(1, offsets.length)));
    const targets = offsets.map((o) => ({ partition: o.partition, start: Math.max(Number(o.low), Number(o.high) - perPartition), high: Number(o.high) })).filter((o) => o.high > o.start);
    if (!targets.length) return [];
    const groupId = `kiln-peek-${Date.now()}`;
    const consumer = this.kafka.consumer({ groupId, allowAutoTopicCreation: false });
    const messages = [];
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: true });
      const remaining = new Map(targets.map((t) => [t.partition, t.high - t.start]));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 6000);
        consumer
          .run({
            autoCommit: false,
            eachMessage: async ({ partition, message }) => {
              if (!remaining.has(partition)) return;
              const value = message.value ? message.value.toString('utf8') : null;
              messages.push({
                partition,
                offset: message.offset,
                timestamp: Number(message.timestamp),
                key: message.key ? message.key.toString('utf8') : null,
                value: value && value.length > 20000 ? value.slice(0, 20000) + '…' : value,
                headers: Object.fromEntries(Object.entries(message.headers || {}).map(([k, v]) => [k, v ? v.toString() : ''])),
              });
              const left = remaining.get(partition) - 1;
              if (left <= 0) remaining.delete(partition);
              else remaining.set(partition, left);
              if (!remaining.size) {
                clearTimeout(timer);
                resolve();
              }
            },
          })
          .catch(() => resolve());
        for (const t of targets) consumer.seek({ topic, partition: t.partition, offset: String(t.start) });
      });
    } finally {
      await consumer.disconnect().catch(() => {});
      admin.deleteGroups([groupId]).catch(() => {});
    }
    return messages.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async publish(topic, { key, value, headers } = {}) {
    if (!this.kafka) throw new Error('Not connected to Kafka');
    if (!this.producer) {
      this.producer = this.kafka.producer({ allowAutoTopicCreation: false });
      await this.producer.connect();
    }
    const res = await this.producer.send({ topic, messages: [{ key: key || null, value: value == null ? '' : String(value), headers: headers || {} }] });
    return res;
  }

  async disconnect() {
    const tasks = [];
    if (this.producer) tasks.push(this.producer.disconnect().catch(() => {}));
    if (this.admin) tasks.push(this.admin.disconnect().catch(() => {}));
    await Promise.all(tasks);
    this.producer = null;
    this.admin = null;
    this.kafka = null;
  }
}

module.exports = { KafkaLive };
