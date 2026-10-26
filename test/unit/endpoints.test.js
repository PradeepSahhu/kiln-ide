'use strict';
// Spec: every HTTP endpoint of a FastAPI / Flask, Express or ASP.NET Core app is found in the code with
// its method, its full path (APIRouter / Blueprint / express.Router / MapGroup / controller prefixes,
// also when the router is mounted in another file) and its parameters (path, query, header, body with
// an example from the model), so a button above each endpoint can call it on the running app.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { scanPython, scanExpress, scanCsharp, applyPrefixes, EndpointService } = require('../../src/main/services/endpoints');
const { buildUrl, sendRequest, urlsIn } = require('../../src/main/services/http-client');
const { tmpdir, writeTree, fakeContext } = require('../helpers/fixtures');

const brief = (list) => list.map((e) => `${e.method} ${e.path}`);

test('FastAPI: methods, router prefixes, path / query / header / body parameters and an example body', () => {
  const src = `from fastapi import FastAPI, APIRouter, Depends, Header, Query
from pydantic import BaseModel

app = FastAPI()
router = APIRouter(prefix="/items")


class Item(BaseModel):
    name: str
    price: float = 9.5
    tags: list[str] = []


@app.get("/health")
def health():
    return {"ok": True}


@router.get("/{item_id}")
async def read_item(item_id: int, q: str | None = None, verbose: bool = Query(False), db=Depends(get_db)):
    ...


@router.post("/")
def create_item(
    item: Item,
    x_token: str = Header(...),
):
    ...


@app.api_route("/ping", methods=["GET", "HEAD"])
def ping():
    ...


app.include_router(router, prefix="/api")
`;
  const scan = scanPython(src, '/p/main.py');
  const list = applyPrefixes([['/p/main.py', scan]]);
  assert.deepEqual(brief(list), ['GET /health', 'GET /api/items/{item_id}', 'POST /api/items', 'GET /ping', 'HEAD /ping']);
  const read = list[1];
  assert.deepEqual(read.params.map((p) => [p.name, p.in, p.required]), [['item_id', 'path', true], ['q', 'query', false], ['verbose', 'query', false]]);
  assert.equal(read.line, 19, 'the line of the decorator');
  const create = list[2];
  assert.deepEqual(create.params.map((p) => [p.name, p.in]), [['x-token', 'header']]);
  assert.deepEqual(create.body.example, { name: 'string', price: 9.5, tags: ['string'] });
});

test('FastAPI routers mounted from another module; Flask blueprints', () => {
  const items = scanPython('from fastapi import APIRouter\nrouter = APIRouter(prefix="/items")\n\n@router.get("/{id}")\ndef get(id: int):\n    ...\n', '/p/routers/items.py');
  const main = scanPython('from fastapi import FastAPI\nfrom routers import items\napp = FastAPI()\napp.include_router(items.router, prefix="/v1")\n', '/p/main.py');
  assert.deepEqual(brief(applyPrefixes([['/p/routers/items.py', items], ['/p/main.py', main]])), ['GET /v1/items/{id}']);
  const flask = scanPython('from flask import Flask, Blueprint\nbp = Blueprint("users", __name__, url_prefix="/users")\n\n@bp.route("/<int:user_id>", methods=["GET", "DELETE"])\ndef user(user_id):\n    ...\n', '/p/users.py');
  const f = applyPrefixes([['/p/users.py', flask]]);
  assert.deepEqual(brief(f), ['GET /users/{user_id}', 'DELETE /users/{user_id}']);
  assert.deepEqual(f[0].params, [{ name: 'user_id', in: 'path', type: 'str', required: true }]);
});

test('Express: app and routers, app.use prefixes (also with require), :params, req.query and req.body keys', () => {
  const routes = scanExpress(`const express = require('express');
const router = express.Router();
router.get('/:id', (req, res) => res.json({ id: req.params.id, full: req.query.full }));
router.post('/', (req, res) => {
  const { name, email } = req.body;
  res.status(201).json({ name, email, age: req.body.age });
});
module.exports = router;
`, '/p/routes/users.js');
  const server = scanExpress(`const express = require('express');
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/users', require('./routes/users'));
app.listen(3000);
`, '/p/server.js');
  const list = applyPrefixes([['/p/routes/users.js', routes], ['/p/server.js', server]]);
  assert.deepEqual(brief(list), ['GET /api/users/{id}'.replace('{id}', ':id'), 'POST /api/users', 'GET /health']);
  assert.deepEqual(list[0].params.map((p) => [p.name, p.in]), [['id', 'path'], ['full', 'query']]);
  assert.deepEqual(list[1].body.example, { name: 'string', email: 'string', age: 'string' });
});

test('ASP.NET Core: minimal APIs with MapGroup, and controllers with [Route] / [Http*] and [From*]', () => {
  const minimal = scanCsharp(`var app = builder.Build();
app.MapGet("/weatherforecast", () => forecast);
var todos = app.MapGroup("/todos");
todos.MapGet("/{id:int}", async (int id, TodoDb db) => await db.Todos.FindAsync(id));
todos.MapPost("/", async (Todo todo, TodoDb db) => { db.Todos.Add(todo); });
todos.MapDelete("/{id}", (int id, [FromQuery] bool hard, ILogger<Program> log) => Results.NoContent());
record Todo(int Id, string Title, bool IsComplete);
`, '/p/Program.cs');
  const m = applyPrefixes([['/p/Program.cs', minimal]]);
  assert.deepEqual(brief(m), ['GET /weatherforecast', 'GET /todos/{id:int}', 'POST /todos', 'DELETE /todos/{id}']);
  assert.deepEqual(m[1].params, [{ name: 'id', in: 'path', type: 'int', required: true }], 'services (TodoDb) are not parameters');
  assert.deepEqual(m[2].body.example, { id: 0, title: 'string', isComplete: false });
  assert.deepEqual(m[3].params.map((p) => [p.name, p.in]), [['id', 'path'], ['hard', 'query']]);
  const ctrl = scanCsharp(`[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IEnumerable<Product> List([FromQuery] string? search) => _db.Products;

    [HttpGet("{id}")]
    public ActionResult<Product> Get(int id) => _db.Find(id);

    [HttpPut("{id}")]
    public IActionResult Update(int id, [FromBody] Product product, [FromHeader(Name = "X-Version")] string version) => NoContent();
}
public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
`, '/p/Controllers/ProductsController.cs');
  const c = applyPrefixes([['/p/Controllers/ProductsController.cs', ctrl]]);
  assert.deepEqual(brief(c), ['GET /api/Products', 'GET /api/Products/{id}', 'PUT /api/Products/{id}']);
  assert.deepEqual(c[0].params.map((p) => [p.name, p.in, p.required]), [['search', 'query', false]]);
  assert.deepEqual(c[2].params.map((p) => [p.name, p.in]), [['id', 'path'], ['version', 'header']]);
  assert.deepEqual(c[2].body.example, { id: 0, name: 'string' });
});

test('the project scan: endpoints of every file, and of one file with its unsaved text', () => {
  const root = writeTree(tmpdir('kiln-endpoints-'), {
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/a")\ndef a():\n    ...\n',
    'node_modules/x/index.js': "const express = require('express'); const app = express(); app.get('/hidden', () => {});\n",
    'web/server.js': "const express = require('express');\nconst app = express();\napp.post('/b', (req, res) => res.json(req.body.x));\n",
  });
  const svc = new EndpointService(fakeContext(root));
  assert.deepEqual(brief(svc.list()), ['GET /a', 'POST /b']);
  const edited = 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/a")\ndef a():\n    ...\n\n@app.delete("/a/{id}")\ndef d(id: int):\n    ...\n';
  assert.deepEqual(brief(svc.forFile(path.join(root, 'app/main.py'), edited)), ['GET /a', 'DELETE /a/{id}']);
});

test('URLs: path parameters filled in, query appended; addresses printed by servers', () => {
  assert.equal(buildUrl('http://127.0.0.1:8000', '/items/{item_id}', { item_id: 'a b' }, { q: 'x', empty: '' }), 'http://127.0.0.1:8000/items/a%20b?q=x');
  assert.equal(buildUrl('http://localhost:3000/', '/users/:id', { id: 7 }), 'http://localhost:3000/users/7');
  assert.equal(buildUrl('http://localhost:5000', '/todos/{id:int}', { id: 3 }), 'http://localhost:5000/todos/3');
  assert.throws(() => buildUrl('http://x:1', '/a/{id}', {}), /path parameter "id"/);
  assert.deepEqual(urlsIn('INFO:     Uvicorn running on \x1b[1mhttp://127.0.0.1:8000\x1b[0m (Press CTRL+C to quit)'), ['http://127.0.0.1:8000']);
  assert.deepEqual(urlsIn('info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5212\n      Now listening on: https://localhost:7212'), ['http://localhost:5212', 'https://localhost:7212']);
  assert.deepEqual(urlsIn('shop listening on port 3000'), ['http://localhost:3000']);
  assert.deepEqual(urlsIn(' * Running on http://0.0.0.0:5000'), ['http://127.0.0.1:5000']);
});

test('requests reach the server with method, headers and JSON body; errors say what is wrong', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], token: req.headers['x-token'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await sendRequest({ method: 'POST', url: `http://127.0.0.1:${port}/items?x=1`, headers: { 'X-Token': 't' }, body: '{"name":"a"}' });
    assert.equal(r.status, 201);
    assert.deepEqual(JSON.parse(r.body), { created: true });
    assert.deepEqual(seen[0], { method: 'POST', url: '/items?x=1', type: 'application/json', token: 't', body: '{"name":"a"}' });
  } finally {
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(() => sendRequest({ url: `http://127.0.0.1:${port}/` }), /Nothing is listening/);
});
