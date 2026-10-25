'use strict';
// New Project templates: Python (each in its own .venv), C#/.NET (solution + projects) and
// JavaScript/TypeScript, plus agentic-AI starters for the Claude Agent SDK and the Claude API.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const settings = require('../settings');
const { which, run, stream } = require('../util/proc');
const { dotnetAuth } = require('./github-auth');

const TEMPLATES = [
  { id: 'python-app', name: 'Python Application', lang: 'python', group: 'Python', requires: ['python'], venv: true, description: 'Console application in its own .venv with pytest.' },
  { id: 'python-fastapi', name: 'FastAPI Web API', lang: 'python', group: 'Python', requires: ['python'], venv: true, description: 'FastAPI service with uvicorn and tests, in a .venv.' },
  { id: 'python-agent-sdk', name: 'Claude Agent SDK Agent (Python)', lang: 'python', group: 'Agentic AI', requires: ['python'], venv: true, description: 'Agent with Claude Code tools plus a custom in-process tool.' },
  { id: 'python-agent-api', name: 'Claude API Tool-Use Agent (Python)', lang: 'python', group: 'Agentic AI', requires: ['python'], venv: true, description: 'Tool-using agent on the Anthropic Python SDK tool runner.' },
  { id: 'dotnet-console', name: 'Console App', lang: 'csharp', group: '.NET', requires: ['dotnet'], description: 'C# console application in a solution.' },
  { id: 'dotnet-classlib-tests', name: 'Class Library + xUnit Tests', lang: 'csharp', group: '.NET', requires: ['dotnet'], description: 'Class library with an xUnit test project.' },
  { id: 'dotnet-webapi', name: 'ASP.NET Core Web API', lang: 'csharp', group: '.NET', requires: ['dotnet'], description: 'Minimal API web service.' },
  { id: 'dotnet-agent', name: 'Claude API Tool-Use Agent (C#)', lang: 'csharp', group: 'Agentic AI', requires: ['dotnet'], description: 'Tool-using agent on the official Anthropic C# SDK.' },
  { id: 'node-app', name: 'Node.js App', lang: 'javascript', group: 'JavaScript', requires: ['node'], description: 'JavaScript application with node:test tests.' },
  { id: 'node-ts', name: 'TypeScript Node App', lang: 'typescript', group: 'JavaScript', requires: ['node'], description: 'TypeScript application compiled with tsc.' },
  { id: 'node-express', name: 'Express Web API', lang: 'javascript', group: 'JavaScript', requires: ['node'], description: 'Express 5 HTTP API.' },
  { id: 'react-vite', name: 'React + Vite', lang: 'javascript', group: 'JavaScript', requires: ['node'], description: 'React single-page app built with Vite.' },
  { id: 'node-agent-sdk', name: 'Claude Agent SDK Agent (TypeScript)', lang: 'typescript', group: 'Agentic AI', requires: ['node'], description: 'Agent built with @anthropic-ai/claude-agent-sdk.' },
];

const REASON = { python: 'Python 3 was not found', dotnet: 'The .NET SDK was not found', node: 'Node.js was not found' };

function list(toolchain = {}) {
  return TEMPLATES.map((t) => {
    const missing = t.requires.filter((r) => !(toolchain[r] && toolchain[r].found));
    return { ...t, available: missing.length === 0, reason: missing.length ? REASON[missing[0]] : null };
  });
}

// ------------------------------------------------------------- content

const PY_GITIGNORE = `__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.env\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\ndist/\nbuild/\n*.egg-info/\n`;
const NODE_GITIGNORE = `node_modules/\ndist/\n.env\n*.log\n.DS_Store\n`;

const pyIdent = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');
const csIdent = (name) => name.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^(\d)/, '_$1');
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '') || 'app';

const files = {
  'python-app': (name) => ({
    'main.py': `"""${name}: application entry point."""\n\n\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\ndef main() -> None:\n    print(greet("world"))\n\n\nif __name__ == "__main__":\n    main()\n`,
    'tests/test_main.py': `from main import greet\n\n\ndef test_greet():\n    assert greet("Kiln") == "Hello, Kiln!"\n`,
    'conftest.py': `# Makes the project root importable from tests/.\n`,
    'requirements.txt': `pytest>=8\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\npython main.py\npython -m pytest\n\`\`\`\n`,
    '.gitignore': PY_GITIGNORE,
  }),
  'python-fastapi': (name) => ({
    'main.py': `"""${name}: FastAPI service."""\nfrom fastapi import FastAPI, HTTPException\nfrom pydantic import BaseModel\n\napp = FastAPI(title="${name}")\n\n\nclass Item(BaseModel):\n    id: int\n    name: str\n\n\nITEMS: dict[int, Item] = {1: Item(id=1, name="Hello, world")}\n\n\n@app.get("/health")\ndef health() -> dict:\n    return {"status": "ok"}\n\n\n@app.get("/items/{item_id}")\ndef get_item(item_id: int) -> Item:\n    if item_id not in ITEMS:\n        raise HTTPException(status_code=404, detail="Item not found")\n    return ITEMS[item_id]\n\n\n@app.post("/items")\ndef create_item(item: Item) -> Item:\n    ITEMS[item.id] = item\n    return item\n`,
    'tests/test_api.py': `from fastapi.testclient import TestClient\n\nfrom main import app\n\nclient = TestClient(app)\n\n\ndef test_health():\n    assert client.get("/health").json() == {"status": "ok"}\n\n\ndef test_item():\n    assert client.get("/items/1").json()["name"] == "Hello, world"\n`,
    'conftest.py': `# Makes the project root importable from tests/.\n`,
    'requirements.txt': `fastapi>=0.115\nuvicorn[standard]>=0.30\nhttpx>=0.27\npytest>=8\n`,
    'README.md': `# ${name}\n\nRun with the "uvicorn main:app" run configuration, then open http://127.0.0.1:8000/docs\n`,
    '.gitignore': PY_GITIGNORE,
  }),
  'python-agent-sdk': (name) => ({
    'agent.py': `"""${name}: an agent built on the Claude Agent SDK.

It can read files in this folder and call a custom in-process tool.
Run:   python agent.py "Summarize README.md"
Auth:  uses your Claude Code login, or ANTHROPIC_API_KEY from .env / the environment.
"""
import sys

import anyio
from dotenv import load_dotenv
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    create_sdk_mcp_server,
    query,
    tool,
)

load_dotenv()


@tool("word_count", "Count the words in a piece of text", {"text": str})
async def word_count(args):
    count = len(args["text"].split())
    return {"content": [{"type": "text", "text": f"{count} words"}]}


tools_server = create_sdk_mcp_server(name="local-tools", version="1.0.0", tools=[word_count])


async def main(prompt: str) -> None:
    options = ClaudeAgentOptions(
        system_prompt="You are a concise assistant working in this project folder.",
        mcp_servers={"local": tools_server},
        allowed_tools=["Read", "Glob", "Grep", "mcp__local__word_count"],
        max_turns=8,
    )
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text, end="", flush=True)
                elif isinstance(block, ToolUseBlock):
                    print(f"\\n[tool] {block.name}", flush=True)
        elif isinstance(message, ResultMessage):
            print(f"\\n\\nDone in {message.duration_ms / 1000:.1f}s")


if __name__ == "__main__":
    anyio.run(main, " ".join(sys.argv[1:]) or "List the files in this folder and describe the project.")
`,
    'requirements.txt': `claude-agent-sdk>=0.2\npython-dotenv>=1.0\n`,
    '.env.example': `# Optional when you are logged in to Claude Code; required otherwise.\nANTHROPIC_API_KEY=\n`,
    'CLAUDE.md': `# ${name}\n\nAn agent built with the Claude Agent SDK. Entry point: agent.py.\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\npython agent.py "What does this project do?"\n\`\`\`\n`,
    '.gitignore': PY_GITIGNORE,
  }),
  'python-agent-api': (name) => ({
    'agent.py': `"""${name}: a tool-using agent on the Claude API (Anthropic Python SDK tool runner).

Run:   python agent.py "Which files are in this project?"
Auth:  set ANTHROPIC_API_KEY in .env (see .env.example) or in your environment.
"""
import datetime
import pathlib
import sys

import anthropic
from anthropic import beta_tool
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-5-5"
ROOT = pathlib.Path(__file__).resolve().parent


@beta_tool
def list_files(directory: str = ".") -> str:
    """List the files and folders in a directory of this project.

    Args:
        directory: Path relative to the project folder.
    """
    target = (ROOT / directory).resolve()
    if target != ROOT and ROOT not in target.parents:
        return "Error: that directory is outside the project."
    if not target.is_dir():
        return f"Error: {directory} is not a directory."
    return "\\n".join(sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir()))


@beta_tool
def read_file(path: str) -> str:
    """Read a UTF-8 text file from this project.

    Args:
        path: File path relative to the project folder.
    """
    target = (ROOT / path).resolve()
    if ROOT not in target.parents:
        return "Error: that file is outside the project."
    try:
        return target.read_text(encoding="utf-8")[:20000]
    except OSError as exc:
        return f"Error: {exc}"


@beta_tool
def current_time() -> str:
    """Return the current local date and time."""
    return datetime.datetime.now().isoformat(timespec="seconds")


def main(prompt: str) -> None:
    client = anthropic.Anthropic()
    runner = client.beta.messages.tool_runner(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "high"},
        # Server-side refusal fallback: a declined request is retried on a suitable model in the same call.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system="You explore this project folder with the tools provided and answer concisely.",
        tools=[list_files, read_file, current_time],
        messages=[{"role": "user", "content": prompt}],
    )
    for message in runner:
        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            print(f"Claude declined this request: {getattr(details, 'explanation', '')}")
            return
        for block in message.content:
            if block.type == "text":
                print(block.text)
            elif block.type == "tool_use":
                print(f"[tool] {block.name}({block.input})")


if __name__ == "__main__":
    try:
        main(" ".join(sys.argv[1:]) or "Which files are in this project, and what time is it?")
    except anthropic.AuthenticationError:
        print("Authentication failed: set ANTHROPIC_API_KEY in .env (see .env.example).")
    except anthropic.RateLimitError:
        print("Rate limited by the API; try again shortly.")
    except anthropic.APIStatusError as exc:
        print(f"API error {exc.status_code}: {exc.message}")
    except anthropic.APIConnectionError:
        print("Could not reach the Claude API; check your network connection.")
`,
    'requirements.txt': `anthropic>=2.3\npython-dotenv>=1.0\n`,
    '.env.example': `ANTHROPIC_API_KEY=\n`,
    'CLAUDE.md': `# ${name}\n\nTool-using agent on the Claude API. Entry point: agent.py.\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\ncp .env.example .env   # add your API key\npython agent.py "What time is it?"\n\`\`\`\n`,
    '.gitignore': PY_GITIGNORE,
  }),
  'node-app': (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', private: true, main: 'index.js', scripts: { start: 'node index.js', test: 'node --test' } }, null, 2) + '\n',
    'index.js': `'use strict';\n\nfunction greet(name) {\n  return \`Hello, \${name}!\`;\n}\n\nif (require.main === module) {\n  console.log(greet('${name}'));\n}\n\nmodule.exports = { greet };\n`,
    'test/index.test.js': `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { greet } = require('../index');\n\ntest('greet', () => {\n  assert.equal(greet('Kiln'), 'Hello, Kiln!');\n});\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\nnpm start\nnpm test\n\`\`\`\n`,
    '.gitignore': NODE_GITIGNORE,
  }),
  'node-ts': (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', private: true, type: 'module', scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx watch src/index.ts' }, devDependencies: { typescript: '^5.9.3', '@types/node': '^24.0.0', tsx: '^4.20.0' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', strict: true, esModuleInterop: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n',
    'src/index.ts': `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nconsole.log(greet('${name}'));\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\nnpm install\nnpm run build && npm start\n\`\`\`\n`,
    '.gitignore': NODE_GITIGNORE,
  }),
  'node-express': (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', private: true, main: 'server.js', scripts: { start: 'node server.js', dev: 'node --watch server.js' }, dependencies: { express: '^5.1.0' } }, null, 2) + '\n',
    'server.js': `'use strict';\nconst express = require('express');\n\nconst app = express();\napp.use(express.json());\n\napp.get('/health', (_req, res) => res.json({ status: 'ok' }));\napp.get('/hello/:name', (req, res) => res.json({ message: \`Hello, \${req.params.name}!\` }));\n\nconst port = Number(process.env.PORT || 3000);\napp.listen(port, () => console.log(\`${name} listening on http://localhost:\${port}\`));\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n`,
    '.gitignore': NODE_GITIGNORE,
  }),
  'react-vite': (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' } }, null, 2) + '\n',
    'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
    'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    'src/main.jsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './App.css';\n\ncreateRoot(document.getElementById('root')).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
    'src/App.jsx': `import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main>\n      <h1>${name}</h1>\n      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>\n    </main>\n  );\n}\n`,
    'src/App.css': `main { font-family: system-ui, sans-serif; padding: 2rem; }\nbutton { font-size: 1rem; padding: 0.5rem 1rem; }\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
    '.gitignore': NODE_GITIGNORE,
  }),
  'node-agent-sdk': (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', private: true, type: 'module', scripts: { start: 'tsx src/agent.ts', build: 'tsc' }, dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.0' }, devDependencies: { typescript: '^5.9.3', '@types/node': '^24.0.0', tsx: '^4.20.0' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', strict: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n',
    'src/agent.ts': `// ${name}: an agent built with the Claude Agent SDK.\n// Auth: your Claude Code login, or ANTHROPIC_API_KEY in the environment.\nimport { query } from '@anthropic-ai/claude-agent-sdk';\n\nconst prompt = process.argv.slice(2).join(' ') || 'List the files in this folder and describe the project.';\n\nfor await (const message of query({ prompt, options: { allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 8 } })) {\n  if (message.type === 'assistant') {\n    for (const block of message.message.content) {\n      if (block.type === 'text') process.stdout.write(block.text);\n      else if (block.type === 'tool_use') console.log(\`\\n[tool] \${block.name}\`);\n    }\n  } else if (message.type === 'result') {\n    console.log(\`\\n\\nDone in \${(message.duration_ms / 1000).toFixed(1)}s\`);\n  }\n}\n`,
    '.env.example': `# Optional when you are logged in to Claude Code.\nANTHROPIC_API_KEY=\n`,
    'CLAUDE.md': `# ${name}\n\nAgent built with @anthropic-ai/claude-agent-sdk. Entry point: src/agent.ts.\n`,
    'README.md': `# ${name}\n\n\`\`\`bash\nnpm install\nnpm start -- "What does this project do?"\n\`\`\`\n`,
    '.gitignore': NODE_GITIGNORE,
  }),
};

const CS_AGENT = `using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta;
using Anthropic.Models.Beta.Messages;

// A small tool-using agent on the Claude API, built with the official Anthropic C# SDK.
// Credentials: ANTHROPIC_API_KEY from the environment (Kiln loads .env into run configurations).
const string ModelId = "claude-opus-5-5";

AnthropicClient client = new();

List<BetaToolUnion> tools =
[
    new BetaTool
    {
        Name = "get_current_time",
        Description = "Get the current local date and time.",
        InputSchema = new() { Properties = new Dictionary<string, JsonElement>() },
    },
    new BetaTool
    {
        Name = "list_files",
        Description = "List the files and folders in a directory of this project.",
        InputSchema = new()
        {
            Properties = new Dictionary<string, JsonElement>
            {
                ["directory"] = JsonSerializer.SerializeToElement(new { type = "string", description = "Directory relative to the project folder, for example \\".\\"" }),
            },
            Required = ["directory"],
        },
    },
];

string prompt = args.Length > 0 ? string.Join(' ', args) : "What time is it, and which files are in this project?";
List<BetaMessageParam> messages = [new() { Role = BetaMessageParamRole.User, Content = prompt }];

for (int turn = 0; turn < 10; turn++)
{
    BetaMessage response = await client.Beta.Messages.Create(new MessageCreateParams
    {
        Model = ModelId,
        MaxTokens = 16000,
        OutputConfig = new BetaOutputConfig { Effort = BetaOutputConfigEffort.High },
        // Server-side refusal fallback: a declined request is retried on a suitable model in the same call.
        Betas = [AnthropicBeta.ServerSideFallback2026_07_01],
        Fallbacks = BetaFallbacksParam.Default,
        Tools = tools,
        Messages = messages,
    });

    if (response.StopReason == BetaStopReason.Refusal)
    {
        Console.WriteLine($"Claude declined this request: {response.StopDetails?.Explanation}");
        return;
    }

    List<BetaContentBlockParam> assistantContent = [];
    List<BetaContentBlockParam> toolResults = [];
    foreach (BetaContentBlock block in response.Content)
    {
        if (block.TryPickText(out BetaTextBlock? text))
        {
            Console.WriteLine(text.Text);
            assistantContent.Add(new BetaTextBlockParam { Text = text.Text });
        }
        else if (block.TryPickThinking(out BetaThinkingBlock? thinking))
        {
            assistantContent.Add(new BetaThinkingBlockParam { Thinking = thinking.Thinking, Signature = thinking.Signature });
        }
        else if (block.TryPickRedactedThinking(out BetaRedactedThinkingBlock? redacted))
        {
            assistantContent.Add(new BetaRedactedThinkingBlockParam { Data = redacted.Data });
        }
        else if (block.TryPickToolUse(out BetaToolUseBlock? toolUse))
        {
            assistantContent.Add(new BetaToolUseBlockParam { ID = toolUse.ID, Name = toolUse.Name, Input = toolUse.Input });
            Console.WriteLine($"[tool] {toolUse.Name}");
            toolResults.Add(new BetaToolResultBlockParam { ToolUseID = toolUse.ID, Content = RunTool(toolUse.Name, toolUse.Input) });
        }
    }

    if (toolResults.Count == 0) break;
    messages.Add(new() { Role = BetaMessageParamRole.Assistant, Content = assistantContent });
    messages.Add(new() { Role = BetaMessageParamRole.User, Content = toolResults });
}

static string RunTool(string name, IReadOnlyDictionary<string, JsonElement> input)
{
    switch (name)
    {
        case "get_current_time":
            return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss zzz");
        case "list_files":
            string root = Directory.GetCurrentDirectory();
            string relative = input.TryGetValue("directory", out JsonElement d) ? d.GetString() ?? "." : ".";
            string target = Path.GetFullPath(Path.Combine(root, relative));
            if (!target.StartsWith(root, StringComparison.Ordinal)) return "Error: that directory is outside the project.";
            if (!Directory.Exists(target)) return $"Error: {relative} does not exist.";
            return string.Join('\\n', Directory.EnumerateFileSystemEntries(target).Select(p => Path.GetFileName(p) + (Directory.Exists(p) ? "/" : "")).Order());
        default:
            return $"Error: unknown tool {name}.";
    }
}
`;

// ------------------------------------------------------------- creation

async function writeFiles(dir, map) {
  for (const [rel, content] of Object.entries(map)) {
    const full = path.join(dir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
}

async function exec(progress, cmd, args, opts = {}) {
  progress(`$ ${path.basename(cmd)} ${args.join(' ')}\n`);
  const h = stream(cmd, args, { ...opts, onData: progress });
  const code = await h.done;
  if (code !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} failed (exit code ${code})`);
}

async function createVenv(dir, progress) {
  const uv = settings.get().build.preferUv ? which('uv') : null;
  const py = settings.get().python.interpreter || which('python3') || which('python');
  if (uv) await exec(progress, uv, ['venv', path.join(dir, '.venv')], { cwd: dir });
  else if (py) await exec(progress, py, ['-m', 'venv', path.join(dir, '.venv')], { cwd: dir });
  else throw new Error('Python 3 was not found.');
}

async function dotnetNew(dir, name, kinds, progress) {
  const dotnet = settings.get().dotnet.path || which('dotnet');
  if (!dotnet) throw new Error('The .NET SDK was not found.');
  const env = dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en' }, dir).env;
  const o = { cwd: dir, env };
  await exec(progress, dotnet, ['new', 'sln', '-n', name, '-o', dir], o);
  const sln = fs.readdirSync(dir).find((f) => /\.slnx?$/.test(f));
  const projects = [];
  for (const k of kinds) {
    const pname = k.suffix ? `${name}.${k.suffix}` : name;
    const pdir = path.join(dir, pname);
    await exec(progress, dotnet, ['new', k.template, '-n', pname, '-o', pdir, ...(k.args || [])], o);
    const csproj = path.join(pdir, `${pname}.csproj`);
    await exec(progress, dotnet, ['sln', path.join(dir, sln), 'add', csproj], o);
    projects.push({ ...k, name: pname, dir: pdir, csproj });
  }
  try {
    await exec(progress, dotnet, ['new', 'gitignore', '-o', dir], o);
  } catch {
    await fsp.writeFile(path.join(dir, '.gitignore'), 'bin/\nobj/\n.vs/\n*.user\nTestResults/\n');
  }
  return { dotnet, projects, env };
}

const builders = {
  async 'dotnet-console'({ dir, name, progress }) {
    await dotnetNew(dir, csIdent(name), [{ template: 'console' }], progress);
  },
  async 'dotnet-webapi'({ dir, name, progress }) {
    await dotnetNew(dir, csIdent(name), [{ template: 'webapi' }], progress);
  },
  async 'dotnet-classlib-tests'({ dir, name, progress }) {
    const n = csIdent(name);
    const { dotnet, projects, env } = await dotnetNew(dir, n, [{ template: 'classlib' }, { template: 'xunit', suffix: 'Tests' }], progress);
    const [lib, tests] = projects;
    await exec(progress, dotnet, ['add', tests.csproj, 'reference', lib.csproj], { cwd: dir, env });
    await fsp.rm(path.join(lib.dir, 'Class1.cs'), { force: true });
    await writeFiles(lib.dir, { 'Calculator.cs': `namespace ${n};\n\npublic static class Calculator\n{\n    public static int Add(int a, int b) => a + b;\n}\n` });
    await fsp.rm(path.join(tests.dir, 'UnitTest1.cs'), { force: true });
    await writeFiles(tests.dir, { 'CalculatorTests.cs': `namespace ${n}.Tests;\n\npublic class CalculatorTests\n{\n    [Fact]\n    public void Add_ReturnsSum() => Assert.Equal(5, Calculator.Add(2, 3));\n}\n` });
  },
  async 'dotnet-agent'({ dir, name, progress }) {
    const n = csIdent(name);
    const { dotnet, projects, env } = await dotnetNew(dir, n, [{ template: 'console' }], progress);
    await exec(progress, dotnet, ['add', projects[0].csproj, 'package', 'Anthropic'], { cwd: dir, env });
    await writeFiles(projects[0].dir, { 'Program.cs': CS_AGENT });
    await writeFiles(dir, { '.env.example': 'ANTHROPIC_API_KEY=\n', 'CLAUDE.md': `# ${name}\n\nTool-using agent on the Anthropic C# SDK. Entry point: ${n}/Program.cs.\n` });
  },
};

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

async function create({ templateId, name, location, gitInit = true, venv = true } = {}, progress = () => {}) {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error(`Unknown template ${templateId}`);
  if (!name || !NAME_RE.test(name) || name.includes('..')) throw new Error('Use letters, digits, ".", "-" or "_" for the project name.');
  if (!location || !fs.existsSync(location)) throw new Error('Choose an existing parent folder.');
  const dir = path.join(location, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty.`);
  const created = !fs.existsSync(dir);
  await fsp.mkdir(dir, { recursive: true });
  try {
    if (builders[t.id]) await builders[t.id]({ dir, name, progress });
    else await writeFiles(dir, files[t.id](name));
    if (t.venv && venv) await createVenv(dir, progress);
    if (gitInit && which('git')) {
      const r = await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      if (r.code !== 0) await run('git', ['init', '-q'], { cwd: dir });
      progress('Initialized a Git repository\n');
    }
  } catch (err) {
    if (created) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  progress(`Created ${dir}\n`);
  return dir;
}

module.exports = { list, create, TEMPLATES, pyIdent };
