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

test('real names from the deployment files: Kubernetes ConfigMaps / Secrets, Helm values per environment, Strimzi topics', async () => {
  const root = writeTree(tmpdir(), {
    // C# service: the topic comes from options bound to configuration; appsettings has a local default.
    'src/Orders.Api/Orders.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Confluent.Kafka" Version="2.3.0" /><PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" /></ItemGroup></Project>',
    'src/Orders.Api/appsettings.json': '{ "Kafka": { "OrdersTopic": "orders-local" }, "ConnectionStrings": { "Orders": "Host=localhost;Database=orders_dev" } }',
    'src/Orders.Api/OrderPublisher.cs': `using Confluent.Kafka;
public class OrderPublisher {
  private readonly IProducer<string, string> _producer;
  private readonly KafkaOptions _options;
  public async Task Publish(Order o) {
    await _producer.ProduceAsync(_options.OrdersTopic, new Message<string, string> { Value = o.Id });
    _db.Orders.Add(o);
    await _db.SaveChangesAsync();
  }
}`,
    'deploy/k8s/base/orders-api.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  template:
    spec:
      containers:
        - name: orders-api
          image: registry.example.com/shop/orders-api:1.4.2
          env:
            - name: Kafka__OrdersTopic
              valueFrom:
                configMapKeyRef:
                  name: shop-config
                  key: ORDERS_TOPIC
            - name: ConnectionStrings__Orders
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: connection
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: shop-config
data:
  ORDERS_TOPIC: shop.orders.v1
---
apiVersion: v1
kind: Secret
metadata:
  name: orders-db
stringData:
  connection: Host=orders-pg.prod.svc;Database=orders_prod;Username=app;Password=hunter2
`,
    // Python worker with pydantic settings, deployed by a Helm chart (values + a production override).
    'billing/pyproject.toml': '[project]\nname = "billing"\ndependencies = ["kafka-python", "sqlalchemy", "psycopg2-binary", "pydantic-settings"]\n',
    'billing/worker.py': `from kafka import KafkaConsumer
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    orders_topic: str = "orders"
    kafka_group_id: str = "billing-dev"


settings = Settings()


class Invoice(Base):
    __tablename__ = "invoices"


consumer = KafkaConsumer(settings.orders_topic, group_id=settings.kafka_group_id)
for msg in consumer:
    session.add(Invoice(order=msg.value))
`,
    'charts/billing-worker/Chart.yaml': 'apiVersion: v2\nname: billing-worker\nversion: 0.1.0\n',
    'charts/billing-worker/values.yaml': 'kafka:\n  topic: shop.orders.v1\n  group: billing-consumers\ndb:\n  url: postgresql://billing:secret@billing-db:5432/billing\n',
    'charts/billing-worker/values-prod.yaml': 'kafka:\n  group: billing-prod\ndb:\n  url: postgresql://billing:secret@billing-db.prod:5432/billing_prod\n',
    'charts/billing-worker/templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "billing.fullname" . }}
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - name: ORDERS_TOPIC
              value: {{ .Values.kafka.topic | quote }}
            - name: KAFKA_GROUP_ID
              value: "{{ .Values.kafka.group }}"
            - name: DATABASE_URL
              value: {{ .Values.db.url }}
`,
    'deploy/kafka/topics.yaml': `apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: shop-orders-v1
spec:
  topicName: shop.orders.v1
  partitions: 12
  replicas: 3
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: shop.payments.v1
spec:
  partitions: 6
`,
  });
  const ctx = fakeContext(root);
  ctx.detection = await detectProject(root);
  const flow = await analyzeFlow(ctx);
  assert.deepEqual(flow.topics.map((t) => t.name), ['shop.orders.v1'], 'one real topic, not the local defaults (orders-local, orders)');
  const topic = flow.topics[0];
  assert.ok(topic.sources.some((s) => s.rel === 'deploy/k8s/base/orders-api.yaml' && s.key === 'Kafka__OrdersTopic' && s.from === 'shop-config' && s.fromKey === 'ORDERS_TOPIC'), 'the ConfigMap the producer reads it from');
  assert.ok(topic.sources.some((s) => s.rel === 'charts/billing-worker/values.yaml'), 'the Helm values the consumer reads it from');
  assert.ok(!topic.sources.some((s) => s.rel === 'charts/billing-worker/values-prod.yaml'), 'values-prod.yaml does not set the topic');
  assert.deepEqual(topic.declared.map((d) => [d.source, d.partitions, d.replicas]), [['Strimzi KafkaTopic', 12, 3]]);
  assert.deepEqual(flow.declaredTopics.map((t) => t.name), ['shop.payments.v1'], 'declared but unused topics are listed');

  const svc = Object.fromEntries(flow.services.map((s) => [s.name, s]));
  assert.ok(svc['Orders.Api'].deployments.some((d) => d.name === 'orders-api' && d.kind === 'Deployment'));
  assert.ok(svc.billing.deployments.some((d) => d.kind === 'Helm chart'));
  const edge = (from, to, kind) => flow.edges.find((e) => e.kind === kind && e.from.endsWith(from) && e.to.endsWith(to));
  assert.ok(edge('Orders.Api', 'shop.orders.v1', 'produce'));
  const consume = edge('shop.orders.v1', 'billing', 'consume');
  assert.deepEqual(consume.groups, ['billing-prod'], 'the production consumer group');
  assert.deepEqual(consume.groupVariants, { prod: 'billing-prod', default: 'billing-consumers' });

  const writes = flow.edges.filter((e) => e.kind === 'write');
  const ordersDb = flow.databases.find((d) => d.id === writes.find((e) => e.from.endsWith('Orders.Api')).to);
  assert.equal(ordersDb.name, 'orders_prod', 'from the Secret, not appsettings (orders_dev)');
  assert.deepEqual(ordersDb.hosts, ['orders-pg.prod.svc']);
  const billingDb = flow.databases.find((d) => d.id === writes.find((e) => e.from.endsWith('billing')).to);
  assert.equal(billingDb.name, 'billing_prod');
  assert.deepEqual(billingDb.variants, { prod: 'billing_prod', default: 'billing' });
  assert.doesNotMatch(JSON.stringify(flow), /hunter2|billing:secret/, 'credentials never leave the analyzer');
  assert.ok(flow.deploymentFiles.includes('deploy/k8s/base/orders-api.yaml') && flow.deploymentFiles.includes('charts/billing-worker/values-prod.yaml'));
});

test('Kustomize overlays and docker-compose env files give per-environment names', async () => {
  const root = writeTree(tmpdir(), {
    'worker/package.json': JSON.stringify({ name: 'notifier', dependencies: { kafkajs: '^2.2.4' } }),
    'worker/index.js': "const { Kafka } = require('kafkajs');\nconst consumer = kafka.consumer({ groupId: process.env.GROUP_ID || 'notifier-local' });\nawait consumer.subscribe({ topic: process.env.EVENTS_TOPIC || 'events' });\n",
    'docker-compose.yml': 'services:\n  notifier:\n    build: ./worker\n    env_file: .env.notifier\n',
    '.env.notifier': 'EVENTS_TOPIC=events.local\nGROUP_ID=notifier-compose\n',
    'k8s/base/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: notifier\nspec:\n  template:\n    spec:\n      containers:\n        - name: notifier\n          envFrom:\n            - configMapRef:\n                name: notifier-config\n',
    'k8s/base/kustomization.yaml': 'resources:\n  - deployment.yaml\nconfigMapGenerator:\n  - name: notifier-config\n    literals:\n      - EVENTS_TOPIC=events.staging\n      - GROUP_ID=notifier\n',
    'k8s/overlays/prod/kustomization.yaml': 'resources:\n  - ../../base\nconfigMapGenerator:\n  - name: notifier-config\n    behavior: replace\n    literals:\n      - EVENTS_TOPIC=platform.events.v2\n      - GROUP_ID=notifier-prod\n',
  });
  const ctx = fakeContext(root);
  ctx.detection = await detectProject(root);
  const flow = await analyzeFlow(ctx);
  assert.deepEqual(flow.topics.map((t) => t.name), ['platform.events.v2'], 'the production overlay wins');
  const e = flow.edges.find((x) => x.kind === 'consume');
  assert.deepEqual(e.groups, ['notifier-prod']);
  assert.ok(flow.topics[0].sources.some((s) => s.rel === 'k8s/overlays/prod/kustomization.yaml'));
  assert.ok(flow.topics[0].sources.some((s) => s.source === 'compose' && s.value === 'events.local'), 'the compose value is listed too');
});

test('a consumer topic read with getenv and a fallback is one topic, not two', async () => {
  const root = writeTree(tmpdir(), {
    'billing/requirements.txt': 'kafka-python\n',
    'billing/worker.py': 'import os\nfrom kafka import KafkaConsumer\nconsumer = KafkaConsumer(os.getenv("ORDERS_TOPIC", "orders"), group_id=os.getenv("GROUP_ID", "billing-local"), bootstrap_servers="k:9092")\n',
  });
  const ctx = fakeContext(root);
  ctx.detection = await detectProject(root);
  const flow = await analyzeFlow(ctx);
  assert.deepEqual(flow.topics.map((t) => t.name), ['orders']);
  assert.deepEqual(flow.edges.find((e) => e.kind === 'consume').groups, ['billing-local']);
});
