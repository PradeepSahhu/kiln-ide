'use strict';
// Spec: the Message Flow analyzer finds which services publish to Kafka topics, which consume them,
// and which databases they write to, resolving topic names from constants, config and .env files.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir, writeTree, fakeContext } = require('../helpers/fixtures');
const { detectProject } = require('../../src/main/services/detect');
const { analyzeFlow } = require('../../src/main/services/flow');

test('services, topics, databases and their edges', async () => {
  const root = writeTree(tmpdir(), {
    'docker-compose.yml': 'services:\n  orders-api:\n    build: ./orders\n  billing-worker:\n    build: ./billing\n    environment:\n      PAYMENTS_TOPIC: payments\n  kafka:\n    image: bitnami/kafka\n    ports:\n      - "9092:9092"\n',
    'orders/Orders.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Confluent.Kafka" Version="2.3.0" /><PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" /></ItemGroup></Project>',
    'orders/appsettings.json': '{ "Kafka": { "OrdersTopic": "orders.created" }, "ConnectionStrings": { "Orders": "Host=localhost;Database=ordersdb" } }',
    'orders/OrderPublisher.cs': `using Confluent.Kafka;
public class OrderPublisher {
  private readonly IProducer<string, string> _producer;
  private readonly IConfiguration _config;
  public async Task Publish(Order o) {
    await _producer.ProduceAsync(_config["Kafka:OrdersTopic"], new Message<string, string> { Value = o.Id });
    _db.Orders.Add(o);
    await _db.SaveChangesAsync();
  }
}`,
    'billing/requirements.txt': 'kafka-python\nsqlalchemy\npsycopg2-binary\n',
    'billing/worker.py': `import os
from kafka import KafkaConsumer, KafkaProducer

class Invoice(Base):
    __tablename__ = "invoices"

consumer = KafkaConsumer("orders.created", group_id="billing")
producer = KafkaProducer()
for msg in consumer:
    session.add(Invoice(order=msg.value))
    session.commit()
    producer.send(os.getenv("PAYMENTS_TOPIC", "payments-default"), b"paid")
`,
  });
  const ctx = fakeContext(root);
  ctx.detection = await detectProject(root);
  const flow = await analyzeFlow(ctx);
  const svc = flow.services.map((s) => s.name).sort();
  assert.deepEqual(svc, ['billing-worker', 'orders-api']);
  const topics = flow.topics.map((t) => t.name).sort();
  assert.deepEqual(topics, ['orders.created', 'payments']);
  const edge = (from, to, kind) => flow.edges.find((e) => e.kind === kind && e.from.endsWith(from) && e.to.endsWith(to));
  assert.ok(edge('orders-api', 'orders.created', 'produce'), 'orders-api publishes orders.created');
  const consume = edge('orders.created', 'billing-worker', 'consume');
  assert.ok(consume, 'billing-worker consumes orders.created');
  assert.deepEqual(consume.groups, ['billing']);
  assert.ok(edge('billing-worker', 'payments', 'produce'), 'topic from compose environment');
  const writes = flow.edges.filter((e) => e.kind === 'write');
  const ordersDb = writes.find((e) => e.from.endsWith('orders-api'));
  assert.ok(ordersDb && ordersDb.tables.includes('Orders'));
  assert.ok(flow.databases.some((d) => d.type === 'PostgreSQL'));
  const billingDb = writes.find((e) => e.from.endsWith('billing-worker'));
  assert.ok(billingDb && billingDb.tables.includes('invoices'));
  assert.ok(flow.brokers.includes('localhost:9092'));
  for (const e of flow.edges) assert.ok(e.refs[0].file && e.refs[0].line > 0, 'every edge links back to source code');
});
