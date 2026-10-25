'use strict';
// Spec: opening a folder detects .NET solutions/projects, Python roots, Node packages and agentic-AI
// frameworks, and derives run configurations from them.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpdir, writeTree } = require('../helpers/fixtures');
const { detectProject } = require('../../src/main/services/detect');

const SLN = `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Api", "src\\Shop.Api\\Shop.Api.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Tests", "tests\\Shop.Tests\\Shop.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"
EndProject
Global
EndGlobal
`;

test('detects a C# solution with an executable and a test project', async () => {
  const root = writeTree(tmpdir(), {
    'Shop.sln': SLN,
    'src/Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.SemanticKernel" Version="1.20.0" /></ItemGroup></Project>',
    'src/Shop.Api/Program.cs': 'var app = WebApplication.Create(args); app.Run();\n',
    'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" /><PackageReference Include="xunit" Version="2.7.0" /><ProjectReference Include="..\\..\\src\\Shop.Api\\Shop.Api.csproj" /></ItemGroup></Project>',
  });
  const d = await detectProject(root);
  assert.ok(d.kinds.includes('dotnet'));
  assert.equal(path.basename(d.dotnet.solution), 'Shop.sln');
  assert.equal(d.dotnet.projects.length, 2);
  const api = d.dotnet.projects.find((p) => p.name === 'Shop.Api');
  const tests = d.dotnet.projects.find((p) => p.name === 'Shop.Tests');
  assert.equal(api.isExe, true, 'web project is runnable');
  assert.equal(tests.isTest, true);
  assert.equal(tests.isExe, false, 'test projects are not run with dotnet run');
  assert.deepEqual(d.dotnet.buildTargets.map((t) => path.basename(t)), ['Shop.sln']);
  const names = d.runConfigs.map((c) => c.name);
  assert.ok(names.includes('Shop.Api'));
  assert.ok(names.some((n) => /Test: Shop.Tests/.test(n)));
  assert.ok(d.agentic && d.agentic.frameworks.some((f) => f.name === 'Semantic Kernel'), 'Semantic Kernel counts as an agent framework');
});

test('detects a Python agent project, its frameworks and missing API keys', async () => {
  const root = writeTree(tmpdir(), {
    'requirements.txt': 'langgraph>=0.2\nanthropic==0.40.0  # sdk\n-r requirements-dev.txt\n',
    'requirements-dev.txt': 'pytest\n',
    'main.py': 'from langgraph.graph import StateGraph\n\nif __name__ == "__main__":\n    print("hi")\n',
    '.env.example': 'ANTHROPIC_API_KEY=\nWEATHER_API_KEY=\n',
    '.env': 'ANTHROPIC_API_KEY=sk-test\n',
    'tests/test_main.py': 'def test_ok():\n    assert True\n',
  });
  const d = await detectProject(root);
  assert.ok(d.kinds.includes('python'));
  assert.ok(d.kinds.includes('agentic'));
  const py = d.python.roots[0];
  assert.ok(py.deps.includes('langgraph'));
  assert.ok(py.deps.includes('anthropic'));
  assert.ok([...py.deps, ...py.devDeps].includes('pytest'), 'included requirement files are followed');
  const fw = d.agentic.frameworks.map((f) => f.name);
  assert.ok(fw.includes('LangGraph'));
  assert.ok(fw.includes('Anthropic SDK'));
  assert.deepEqual(d.agentic.env.missingKeys, ['WEATHER_API_KEY']);
  assert.ok(d.runConfigs.some((c) => c.name === 'main.py' && c.python));
  assert.ok(d.runConfigs.some((c) => /pytest/.test(c.name)));
});

test('finds FastAPI apps and pyproject dependencies', async () => {
  const root = writeTree(tmpdir(), {
    'pyproject.toml': '[project]\nname = "svc"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.110", "uvicorn"]\n',
    'app.py': 'from fastapi import FastAPI\napi = FastAPI()\n',
  });
  const d = await detectProject(root);
  assert.equal(d.python.roots[0].name, 'svc');
  assert.ok(d.python.roots[0].deps.includes('fastapi'));
  const uv = d.runConfigs.find((c) => /uvicorn/.test(c.name));
  assert.ok(uv, 'uvicorn run configuration');
  assert.deepEqual(uv.args.slice(0, 3), ['-m', 'uvicorn', 'app:api']);
});

test('detects Node agent packages', async () => {
  const root = writeTree(tmpdir(), {
    'package.json': JSON.stringify({ name: 'bot', scripts: { start: 'node index.js', build: 'tsc' }, dependencies: { '@anthropic-ai/sdk': '^0.50.0' } }),
    'index.js': 'console.log(1)\n',
  });
  const d = await detectProject(root);
  assert.ok(d.kinds.includes('node'));
  assert.equal(d.node.roots[0].agentic, true);
  assert.ok(d.runConfigs.some((c) => c.name === 'npm run start'));
});

test('an empty folder is a generic project with no run configurations', async () => {
  const d = await detectProject(tmpdir());
  assert.deepEqual(d.kinds, []);
  assert.deepEqual(d.runConfigs, []);
});

test('a package module with a __main__ guard runs as python -m pkg.module', async () => {
  const root = writeTree(tmpdir(), {
    'requirements.txt': 'requests\n',
    'app/__init__.py': '',
    'app/main.py': 'from app.util import f\n\nif __name__ == "__main__":\n    f()\n',
    'app/util.py': 'def f():\n    print(1)\n',
  });
  const d = await detectProject(root);
  const cfg = d.runConfigs.find((c) => c.detail === 'python -m app.main');
  assert.ok(cfg, `python -m app.main configuration (got: ${d.runConfigs.map((c) => c.detail).join(', ')})`);
  assert.deepEqual(cfg.args, ['-m', 'app.main']);
  assert.ok(!d.runConfigs.some((c) => c.detail === 'python -m app.util'), 'modules without a __main__ guard are not run configurations');
});
